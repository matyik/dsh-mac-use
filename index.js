/**
 * dsh-mac-use
 *
 * A DeepSeek Harness Host plugin that gives an agent a computer-use toolset for
 * macOS: it captures the screen, reads the display/window geometry, moves and
 * clicks the mouse, scrolls, types, presses keys, and opens apps and URLs.
 *
 * Screen capture runs through the bundled macOS `screencapture` tool (with the
 * cursor included); display/window inspection and mouse/keyboard input call
 * macOS system APIs through the `koffi` FFI library. There is no separate helper
 * executable. Screen Recording and Accessibility permissions are therefore
 * checked against the DeepSeek Harness Desktop app itself, so the user grants
 * those permissions once to the app and never to a helper binary.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

const execFileAsync = promisify(execFile);

const name = 'tool-mac-use';
const inject = ['tools'];

const Config = z.object({
  // Delay between paired press/release events (down/up) for reliability.
  postDelayMs: z.number().min(0).max(2000).default(25),
  // Number of scroll "wheel" units per scroll step.
  scrollAmount: z.number().min(1).max(200).default(3),
  // Per-character delay while typing (0 = as fast as possible).
  typeDelayMs: z.number().min(0).max(200).default(0),
  // When true, mouse actions are delivered via the global HID tap (reliable
  // clicks), then the real cursor is restored to where it was, and a floating
  // "agent cursor" arrow is shown at the action point. When false, the system
  // cursor simply moves to each position. Keyboard input always goes to the
  // focused app.
  virtualCursor: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Native (macOS) layer, initialised lazily on first use.
// ---------------------------------------------------------------------------

let nativePromise;

function getNative() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  nativePromise ??= initNative();
  return nativePromise;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

async function initNative() {
  const { default: koffi } = await import('koffi');

  // Core types, registered idempotently: koffi's type registry is global and
  // survives plugin hot-reloads, so re-registering a name after a reload would
  // throw "Duplicate type name". Reuse an existing type when one is present.
  function structType(name, fields) {
    try {
      return koffi.type(name);
    } catch {
      return koffi.struct(name, fields);
    }
  }
  function pointerType(name, target) {
    try {
      return koffi.type(name);
    } catch {
      return koffi.pointer(name, target);
    }
  }

  structType('CGPoint', { x: 'double', y: 'double' });
  structType('CGSize', { width: 'double', height: 'double' });
  structType('CGRect', { origin: 'CGPoint', size: 'CGSize' });

  pointerType('CFStringRef', koffi.opaque());
  pointerType('CFNumberRef', koffi.opaque());
  pointerType('CFDictionaryRef', koffi.opaque());
  pointerType('CFArrayRef', koffi.opaque());
  pointerType('CGEventRef', koffi.opaque());
  pointerType('CGEventSourceRef', koffi.opaque());

  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const appSvc = koffi.load(
    '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices',
  );
  // Load QuartzCore so CAShapeLayer (used for the cursor arrow) is registered.
  koffi.load('/System/Library/Frameworks/QuartzCore.framework/QuartzCore');

  // --- CoreGraphics ---
  const CGMainDisplayID = cg.func('uint32 CGMainDisplayID()');
  const CGGetActiveDisplayList = cg.func(
    'int32 CGGetActiveDisplayList(uint32_t maxDisplays, uint32_t *displays, uint32_t *count)',
  );
  const CGDisplayBounds = cg.func('CGRect CGDisplayBounds(uint32_t display)');
  const CGWindowListCopyWindowInfo = cg.func(
    'CFArrayRef CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)',
  );
  const CGEventSourceCreate = cg.func('CGEventSourceRef CGEventSourceCreate(int32_t stateID)');
  const CGEventCreate = cg.func('CGEventRef CGEventCreate(CGEventSourceRef source)');
  const CGEventCreateMouseEvent = cg.func(
    'CGEventRef CGEventCreateMouseEvent(CGEventSourceRef source, uint32_t mouseType, CGPoint mouseCursorPosition, uint32_t mouseButton)',
  );
  const CGEventCreateKeyboardEvent = cg.func(
    'CGEventRef CGEventCreateKeyboardEvent(CGEventSourceRef source, uint16_t virtualKey, bool keyDown)',
  );
  const CGEventCreateScrollWheelEvent = cg.func(
    'CGEventRef CGEventCreateScrollWheelEvent(CGEventSourceRef source, uint32_t units, uint32_t wheelCount, int32_t wheel1, int32_t wheel2)',
  );
  const CGEventKeyboardSetUnicodeString = cg.func(
    'void CGEventKeyboardSetUnicodeString(CGEventRef event, uint32_t stringLength, const uint16_t *unicodeString)',
  );
  const CGEventSetFlags = cg.func('void CGEventSetFlags(CGEventRef event, uint64_t flags)');
  const CGEventSetLocation = cg.func('void CGEventSetLocation(CGEventRef event, CGPoint location)');
  const CGEventGetLocation = cg.func('CGPoint CGEventGetLocation(CGEventRef event)');
  const CGEventPost = cg.func('void CGEventPost(uint32_t tap, CGEventRef event)');
  const CGWarpMouseCursorPosition = cg.func('int32 CGWarpMouseCursorPosition(CGPoint position)');
  const CGColorCreateGenericRGB = cg.func(
    'void * CGColorCreateGenericRGB(double r, double g, double b, double a)',
  );
  const CGPreflightScreenCaptureAccess = cg.func('bool CGPreflightScreenCaptureAccess()');

  // CoreGraphics mutable paths (for drawing the agent-cursor arrow).
  const CGPathCreateMutable = cg.func('void * CGPathCreateMutable()');
  const CGPathMoveToPoint = cg.func(
    'void CGPathMoveToPoint(void *path, const void *transform, double x, double y)',
  );
  const CGPathAddLineToPoint = cg.func(
    'void CGPathAddLineToPoint(void *path, const void *transform, double x, double y)',
  );
  const CGPathCloseSubpath = cg.func('void CGPathCloseSubpath(void *path)');

  // --- Objective-C runtime (for the floating "agent cursor" arrow) ---
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const objc_getClass = objc.func('void * objc_getClass(const char *name)');
  const sel_registerName = objc.func('void * sel_registerName(const char *name)');
  const msg0 = objc.func('void * objc_msgSend(void *o, void *s)');
  const msgPointRet = objc.func('CGPoint objc_msgSend(void *o, void *s)');
  const msgInitWindow = objc.func(
    'void * objc_msgSend(void *o, void *s, CGRect r, uint64_t st, uint64_t bk, bool d)',
  );
  const msgVoidPtr = objc.func('void objc_msgSend(void *o, void *s, void *a)');
  const msgBool = objc.func('void objc_msgSend(void *o, void *s, bool v)');
  const msgInt = objc.func('void objc_msgSend(void *o, void *s, int64_t v)');
  const msgDbl = objc.func('void objc_msgSend(void *o, void *s, double v)');
  const msgPoint = objc.func('void objc_msgSend(void *o, void *s, CGPoint p)');
  const msgDate = objc.func('void * objc_msgSend(void *o, void *s, double ti)');
  const msgBoolRet = objc.func('bool objc_msgSend(void *o, void *s, void *date)');
  const msgRect = objc.func('void objc_msgSend(void *o, void *s, CGRect r)');
  const sel = sel_registerName;

  // --- CoreFoundation ---
  const CFRelease = cf.func('void CFRelease(const void *cf)');
  const CFArrayGetCount = cf.func('int64 CFArrayGetCount(CFArrayRef array)');
  const CFArrayGetValueAtIndex = cf.func(
    'const void * CFArrayGetValueAtIndex(CFArrayRef array, int64 index)',
  );
  const CFDictionaryGetValue = cf.func(
    'const void * CFDictionaryGetValue(CFDictionaryRef dict, const void *key)',
  );
  const CFNumberGetValue = cf.func(
    'bool CFNumberGetValue(CFNumberRef number, int32_t type, void *valuePtr)',
  );
  const CFStringGetLength = cf.func('int64 CFStringGetLength(CFStringRef str)');
  const CFStringGetCString = cf.func(
    'bool CFStringGetCString(CFStringRef str, char *buffer, int64 bufferSize, uint32_t encoding)',
  );
  const CFStringCreateWithCString = cf.func(
    'CFStringRef CFStringCreateWithCString(void *allocator, const char *cstr, uint32_t encoding)',
  );

  // --- Accessibility / ApplicationServices ---
  const AXIsProcessTrusted = appSvc.func('bool AXIsProcessTrusted()');

  const kUTF8 = 0x08000100;
  const kCFNumberDoubleType = 6;
  const kCFNumberSInt32Type = 3;

  // Cached CFString keys for window info dictionaries (process-lifetime).
  function cfStr(ascii) {
    return CFStringCreateWithCString(null, ascii, kUTF8);
  }
  const KEY = {
    windowNumber: cfStr('kCGWindowNumber'),
    ownerPid: cfStr('kCGWindowOwnerPID'),
    ownerName: cfStr('kCGWindowOwnerName'),
    windowName: cfStr('kCGWindowName'),
    bounds: cfStr('kCGWindowBounds'),
    layer: cfStr('kCGWindowLayer'),
    x: cfStr('X'),
    y: cfStr('Y'),
    width: cfStr('Width'),
    height: cfStr('Height'),
  };

  // Shared HID event source for synthetic input.
  const source = CGEventSourceCreate(1 /* kCGEventSourceStateHIDSystemState */);

  function cfStringToJs(cfstr) {
    if (!cfstr) return '';
    const len = Number(CFStringGetLength(cfstr));
    if (len === 0) return '';
    const buf = Buffer.alloc(len * 4 + 1);
    if (!CFStringGetCString(cfstr, buf, buf.length, kUTF8)) return '';
    const nul = buf.indexOf(0);
    return buf.toString('utf8', 0, nul < 0 ? buf.length : nul);
  }

  function cfNumberToDouble(cfnum) {
    if (!cfnum) return 0;
    const out = new Float64Array(1);
    return CFNumberGetValue(cfnum, kCFNumberDoubleType, out) ? out[0] : 0;
  }

  function cfNumberToInt(cfnum) {
    if (!cfnum) return 0;
    const out = new Int32Array(1);
    return CFNumberGetValue(cfnum, kCFNumberSInt32Type, out) ? out[0] : 0;
  }

  function getDisplays() {
    const maxDisplays = 16;
    const displays = new Uint32Array(maxDisplays);
    const count = new Uint32Array(1);
    CGGetActiveDisplayList(maxDisplays, displays, count);
    const out = [];
    for (let i = 0; i < count[0]; i++) {
      const id = displays[i];
      const b = CGDisplayBounds(id);
      // Bounds are in global display points — the same coordinate space used
      // by computer_move/computer_click. Pixel/backing scale is reported per
      // screenshot instead, where captured pixels are known exactly.
      out.push({
        id,
        bounds: { x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height },
      });
    }
    return out;
  }

  function listWindows() {
    const arr = CGWindowListCopyWindowInfo(1 /* on-screen only */, 0);
    if (!arr) return [];
    try {
      const count = Number(CFArrayGetCount(arr));
      const out = [];
      for (let i = 0; i < count; i++) {
        const dict = CFArrayGetValueAtIndex(arr, i);
        if (!dict) continue;
        const bd = CFDictionaryGetValue(dict, KEY.bounds);
        const bounds = bd
          ? {
              x: cfNumberToDouble(CFDictionaryGetValue(bd, KEY.x)),
              y: cfNumberToDouble(CFDictionaryGetValue(bd, KEY.y)),
              width: cfNumberToDouble(CFDictionaryGetValue(bd, KEY.width)),
              height: cfNumberToDouble(CFDictionaryGetValue(bd, KEY.height)),
            }
          : null;
        out.push({
          id: cfNumberToInt(CFDictionaryGetValue(dict, KEY.windowNumber)),
          layer: cfNumberToInt(CFDictionaryGetValue(dict, KEY.layer)),
          ownerPid: cfNumberToInt(CFDictionaryGetValue(dict, KEY.ownerPid)),
          ownerName: cfStringToJs(CFDictionaryGetValue(dict, KEY.ownerName)),
          name: cfStringToJs(CFDictionaryGetValue(dict, KEY.windowName)),
          bounds,
        });
      }
      return out;
    } finally {
      CFRelease(arr);
    }
  }

  function cursorLocation() {
    const ev = CGEventCreate(null);
    const pt = CGEventGetLocation(ev);
    CFRelease(ev);
    return { x: pt.x, y: pt.y };
  }

  function mainDisplayBounds() {
    const id = CGMainDisplayID();
    const b = CGDisplayBounds(id);
    return { x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height };
  }

  // --- synthetic input ------------------------------------------------------

  function postEvent(ev) {
    CGEventPost(0 /* kCGHIDEventTap */, ev);
    CFRelease(ev);
  }

  const BUTTON = { left: 0, right: 1, middle: 2 };
  const EVT = {
    leftDown: 1,
    leftUp: 2,
    rightDown: 3,
    rightUp: 4,
    moved: 5,
    leftDragged: 6,
    rightDragged: 7,
    otherDown: 25,
    otherUp: 26,
    otherDragged: 27,
  };

  function downUpTypes(button) {
    if (button === BUTTON.right)
      return { down: EVT.rightDown, up: EVT.rightUp, dragged: EVT.rightDragged };
    if (button === BUTTON.middle)
      return { down: EVT.otherDown, up: EVT.otherUp, dragged: EVT.otherDragged };
    return { down: EVT.leftDown, up: EVT.leftUp, dragged: EVT.leftDragged };
  }

  // --- virtual cursor: act reliably, then restore the real pointer ---

  // Current cursor position in CGEvent (top-left origin) coordinates, read via
  // the reliable AppKit `NSEvent.mouseLocation` (Cocoa bottom-left origin).
  const NSEvent = objc_getClass('NSEvent');
  function cursorCGPoint() {
    const ns = msgPointRet(NSEvent, sel('mouseLocation'));
    return { x: ns.x, y: mainDisplayBounds().height - ns.y };
  }

  // Pump the Cocoa run loop briefly so overlay-window changes commit to the
  // window server (a bare Node process has no running NSApplication loop).
  function pumpRunLoop(ms) {
    const NSRunLoop = objc_getClass('NSRunLoop');
    const NSDate = objc_getClass('NSDate');
    const rl = msg0(NSRunLoop, sel('currentRunLoop'));
    const date = msgDate(NSDate, sel('dateWithTimeIntervalSinceNow:'), ms / 1000);
    msgBoolRet(rl, sel('runUntilDate:'), date);
  }

  // Floating, click-through "agent cursor" arrow (created lazily once): a blue
  // pointer with a white outline, ~2x the system cursor, 90% opaque, with the
  // arrow tip exactly on the action point.
  let agentCursor = null;
  function ensureAgentCursor() {
    if (agentCursor) return agentCursor;
    const NSApplication = objc_getClass('NSApplication');
    const app = msg0(NSApplication, sel('sharedApplication'));
    msgInt(app, sel('setActivationPolicy:'), 1 /* accessory */);
    const NSWindow = objc_getClass('NSWindow');
    const ARROW = 48; // ~2x the ~24pt system cursor
    const PAD = 4; // margin so the white outline is not clipped
    const SIZE = ARROW + PAD * 2;
    const win = msgInitWindow(
      msg0(NSWindow, sel('alloc')),
      sel('initWithContentRect:styleMask:backing:defer:'),
      { origin: { x: -100, y: -100 }, size: { width: SIZE, height: SIZE } },
      0 /* borderless */,
      2 /* buffered */,
      false,
    );
    msgInt(win, sel('setLevel:'), 3 /* NSFloatingWindowLevel */);
    msgBool(win, sel('setOpaque:'), false);
    msgBool(win, sel('setIgnoresMouseEvents:'), true);
    msgBool(win, sel('setHasShadow:'), false);
    const contentView = msg0(win, sel('contentView'));
    msgBool(contentView, sel('setWantsLayer:'), true);
    const layer = msg0(contentView, sel('layer'));

    // macOS-style pointer outline (tip at origin, tail toward the lower right,
    // top-left origin with y down). Converted to the layer's y-up space below.
    const pts = [
      [0, 0],
      [0, 41],
      [12, 31],
      [19, 48],
      [26, 45],
      [18, 28],
      [32, 28],
    ];
    const path = CGPathCreateMutable();
    CGPathMoveToPoint(path, null, PAD + pts[0][0], PAD + (ARROW - pts[0][1]));
    for (let i = 1; i < pts.length; i++) {
      CGPathAddLineToPoint(path, null, PAD + pts[i][0], PAD + (ARROW - pts[i][1]));
    }
    CGPathCloseSubpath(path);

    const CAShapeLayer = objc_getClass('CAShapeLayer');
    const shape = msg0(CAShapeLayer, sel('layer'));
    msgRect(shape, sel('setBounds:'), {
      origin: { x: 0, y: 0 },
      size: { width: SIZE, height: SIZE },
    });
    msgPoint(shape, sel('setPosition:'), { x: SIZE / 2, y: SIZE / 2 });
    msgVoidPtr(shape, sel('setPath:'), path);
    const fill = CGColorCreateGenericRGB(0.302, 0.42, 0.996, 0.9); // DeepSeek blue #4D6BFE
    const stroke = CGColorCreateGenericRGB(1.0, 1.0, 1.0, 0.9); // white
    msgVoidPtr(shape, sel('setFillColor:'), fill);
    msgVoidPtr(shape, sel('setStrokeColor:'), stroke);
    msgDbl(shape, sel('setLineWidth:'), 2.5);
    msgVoidPtr(layer, sel('addSublayer:'), shape);
    CFRelease(fill);
    CFRelease(stroke);
    CFRelease(path); // the shape layer retained its own reference
    // Last shown target (top-left point); null when hidden, so the first show
    // after a hide appears in place and later shows slide from the previous one.
    let agentCursorPos = null;
    const ANIM_STEPS = 5;
    const ANIM_STEP_MS = 18;
    agentCursor = {
      show(x, y) {
        const from = agentCursorPos ?? { x, y };
        agentCursorPos = { x, y };
        const H = mainDisplayBounds().height;
        for (let i = 1; i <= ANIM_STEPS; i++) {
          const t = i / ANIM_STEPS;
          const cx = from.x + (x - from.x) * t;
          const cy = from.y + (y - from.y) * t;
          // The tip is PAD from the window's top-left; place it on the target.
          // setFrameOrigin: uses Cocoa bottom-left origin, so flip the y axis.
          msgPoint(win, sel('setFrameOrigin:'), { x: cx - PAD, y: H - cy + PAD - SIZE });
          if (i === 1) msgVoidPtr(win, sel('orderFront:'), null);
          pumpRunLoop(ANIM_STEP_MS);
        }
      },
      hide() {
        agentCursorPos = null;
        msgVoidPtr(win, sel('orderOut:'), null);
        pumpRunLoop(20);
      },
    };
    pumpRunLoop(60);
    return agentCursor;
  }

  // Hide the agent-cursor arrow once the agent finishes its whole task.
  function hideAgentCursor() {
    if (agentCursor) agentCursor.hide();
  }

  function postMouseGlobal(type, x, y, button) {
    postEvent(CGEventCreateMouseEvent(source, type, { x, y }, button));
  }

  // Run a mouse action: in virtual mode, save the real cursor, show the agent
  // arrow, run the action, then restore the real cursor. Global CGEventPost is
  // used because it delivers clicks reliably (posting to a PID is unreliable
  // for mouse hit-testing).
  async function withCursorRestore(x, y, virtual, action) {
    const saved = virtual ? cursorCGPoint() : null;
    if (virtual) ensureAgentCursor().show(x, y);
    await action();
    if (virtual) CGWarpMouseCursorPosition(saved);
  }

  async function move(x, y, virtual) {
    if (virtual) {
      ensureAgentCursor().show(x, y);
    } else {
      postMouseGlobal(EVT.moved, x, y, BUTTON.left);
    }
  }

  async function click(x, y, button, count, delayMs, virtual) {
    const { down, up } = downUpTypes(button);
    await withCursorRestore(x, y, virtual, async () => {
      for (let i = 0; i < count; i++) {
        postMouseGlobal(down, x, y, button);
        await sleep(delayMs);
        postMouseGlobal(up, x, y, button);
        await sleep(delayMs);
      }
    });
  }

  async function drag(x1, y1, x2, y2, button, delayMs, virtual) {
    const { down, up, dragged } = downUpTypes(button);
    await withCursorRestore(x2, y2, virtual, async () => {
      postMouseGlobal(down, x1, y1, button);
      await sleep(delayMs);
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        const x = x1 + ((x2 - x1) * i) / steps;
        const y = y1 + ((y2 - y1) * i) / steps;
        postMouseGlobal(dragged, x, y, button);
        await sleep(Math.max(1, Math.floor(delayMs / steps)));
      }
      postMouseGlobal(up, x2, y2, button);
      await sleep(delayMs);
    });
  }

  async function scroll(x, y, dx, dy, virtual) {
    await withCursorRestore(x, y, virtual, async () => {
      if (dy !== 0) {
        const ev = CGEventCreateScrollWheelEvent(source, 1 /* line */, 1, dy, 0);
        CGEventSetLocation(ev, { x, y });
        postEvent(ev);
      }
      if (dx !== 0) {
        const ev = CGEventCreateScrollWheelEvent(source, 1 /* line */, 1, 0, dx);
        CGEventSetLocation(ev, { x, y });
        postEvent(ev);
      }
    });
  }

  async function typeText(text, delayMs) {
    for (const ch of text) {
      const u16 = Buffer.from(ch, 'utf16le');
      const units = u16.length / 2;
      const down = CGEventCreateKeyboardEvent(source, 0, true);
      CGEventKeyboardSetUnicodeString(down, units, u16);
      postEvent(down);
      postEvent(CGEventCreateKeyboardEvent(source, 0, false));
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  const KEYCODE = {
    a: 0,
    b: 11,
    c: 8,
    d: 2,
    e: 14,
    f: 3,
    g: 5,
    h: 4,
    i: 34,
    j: 38,
    k: 40,
    l: 37,
    m: 46,
    n: 45,
    o: 31,
    p: 35,
    q: 12,
    r: 15,
    s: 1,
    t: 17,
    u: 32,
    v: 9,
    w: 13,
    x: 7,
    y: 16,
    z: 6,
    0: 29,
    1: 18,
    2: 19,
    3: 20,
    4: 21,
    5: 23,
    6: 22,
    7: 26,
    8: 28,
    9: 25,
    return: 36,
    enter: 36,
    tab: 48,
    space: 49,
    ' ': 49,
    delete: 51,
    backspace: 51,
    forwarddelete: 117,
    escape: 53,
    esc: 53,
    up: 126,
    down: 125,
    left: 123,
    right: 124,
    home: 115,
    end: 119,
    pageup: 116,
    pagedown: 121,
    f1: 122,
    f2: 120,
    f3: 99,
    f4: 118,
    f5: 96,
    f6: 97,
    f7: 98,
    f8: 100,
    f9: 101,
    f10: 109,
    f11: 103,
    f12: 111,
  };

  const MODIFIER = {
    cmd: 1 << 20,
    command: 1 << 20,
    meta: 1 << 20,
    super: 1 << 20,
    shift: 1 << 17,
    option: 1 << 19,
    alt: 1 << 19,
    control: 1 << 18,
    ctrl: 1 << 18,
  };

  function keyPress(keycode, flags, down) {
    const ev = CGEventCreateKeyboardEvent(source, keycode, down);
    if (flags) CGEventSetFlags(ev, flags);
    postEvent(ev);
  }

  async function pressKeys(keys, delayMs) {
    const modifiers = [];
    const others = [];
    for (const raw of keys) {
      const k = String(raw).toLowerCase();
      if (MODIFIER[k] !== undefined) modifiers.push(k);
      else others.push(k);
    }
    let flags = 0;
    for (const m of modifiers) flags |= MODIFIER[m];

    // Hold modifiers.
    for (const m of modifiers) {
      keyPress(KEYCODE[m] ?? 0, 0, true);
    }

    if (others.length > 0) {
      for (const k of others) {
        const keycode = KEYCODE[k];
        if (keycode === undefined) {
          // Release held modifiers before failing.
          for (const m of modifiers) keyPress(KEYCODE[m] ?? 0, 0, false);
          throw new Error(
            `computer_key: unknown key "${k}". Use computer_type for arbitrary text.`,
          );
        }
        keyPress(keycode, flags, true);
        await sleep(delayMs);
        keyPress(keycode, flags, false);
        await sleep(delayMs);
      }
    } else {
      // A modifier chord with no regular key: tap each modifier.
      for (const m of modifiers) {
        keyPress(KEYCODE[m] ?? 0, 0, true);
        await sleep(delayMs);
        keyPress(KEYCODE[m] ?? 0, 0, false);
      }
    }

    // Release modifiers.
    for (const m of modifiers) keyPress(KEYCODE[m] ?? 0, 0, false);
  }

  return {
    hasScreenRecording: () => CGPreflightScreenCaptureAccess(),
    isTrusted: () => AXIsProcessTrusted(),
    getDisplays,
    listWindows,
    cursorLocation,
    mainDisplayBounds,
    hideAgentCursor,
    move,
    click,
    drag,
    scroll,
    typeText,
    pressKeys,
  };
}

// ---------------------------------------------------------------------------
// Tool output helpers.
// ---------------------------------------------------------------------------

function jsonRender(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return [{ type: 'text', text }];
}

function requireNative(n) {
  if (!n)
    throw new Error(
      'computer_* tools are available only on macOS running inside the DeepSeek Harness Desktop app.',
    );
  return n;
}

function screenRecordingError() {
  return new Error(
    'Screen capture is blocked: the DeepSeek Harness app does not have Screen Recording permission. ' +
      'Open System Settings → Privacy & Security → Screen Recording, enable "DeepSeek Harness", then quit and reopen the app.',
  );
}

function accessibilityError() {
  return new Error(
    'Mouse and keyboard control is blocked: the DeepSeek Harness app does not have Accessibility permission. ' +
      'Open System Settings → Privacy & Security → Accessibility, enable "DeepSeek Harness", then quit and reopen the app.',
  );
}

// ---------------------------------------------------------------------------
// Screen capture via the macOS `screencapture` system binary.
//
// We deliberately avoid encoding the capture with in-process ImageIO/CFData FFI:
// a `koffi.view` over the mutable CFData bytes crashed the Desktop host (a NAPI
// fatal on a detached ArrayBuffer). `screencapture` is a robust, bundled system
// tool that also lets us include the mouse cursor with `-C`, so the user can see
// where the agent is pointing.
// ---------------------------------------------------------------------------

function pngSize(buf) {
  // PNG signature (8 bytes) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
  if (buf.length < 24 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47)
    return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function captureScreenshot({ bounds, windowId, displayId }) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-computer-'));
  const file = join(dir, 'shot.png');
  const args = ['-x', '-C', '-t', 'png']; // -x: silent, -C: include cursor, -t: PNG
  if (displayId !== undefined) args.push('-D', String(displayId));
  else if (windowId !== undefined) args.push('-l', String(windowId));
  else if (bounds !== undefined)
    args.push('-R', `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`);
  args.push(file);
  try {
    await execFileAsync('/usr/sbin/screencapture', args);
    const bytes = readFileSync(file);
    const size = pngSize(bytes);
    if (!size) throw new Error('screencapture produced an invalid image');
    return { bytes, width: size.width, height: size.height };
  } catch (error) {
    if (error instanceof Error && error.message.includes('produced an invalid image')) throw error;
    throw new Error(`computer_screenshot failed: ${error?.message ?? error}`, { cause: error });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

function apply(ctx, config) {
  const resolved = config;

  // Hide the agent-cursor arrow once the agent finishes its whole turn/task
  // (status transitions to "idle"), so it doesn't linger between prompts.
  ctx.on(
    'agent/status',
    ({ status }) => {
      if (status === 'idle') {
        getNative().then((n) => {
          if (n) n.hideAgentCursor();
        });
      }
    },
    { global: true },
  );

  // Read-only tools register on the main context.
  ctx.tools.register(
    defineTool({
      name: 'computer_screen_info',
      description:
        'Read the current macOS display geometry without taking a screenshot. ' +
        'Returns each display (id, bounds in global points, pixel size, backing scale), the current mouse cursor position in global points, ' +
        'and the list of on-screen windows (id, app, title, bounds in points, layer). ' +
        'Use this to compute screen coordinates before computer_move/computer_click/computer_screenshot.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            displays: { type: 'array', items: { type: 'object', additionalProperties: true } },
            cursor: {
              type: 'object',
              additionalProperties: false,
              properties: { x: { type: 'number' }, y: { type: 'number' } },
            },
            windows: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
        render: jsonRender,
      },
      isConcurrencySafe: () => true,
      async execute() {
        const n = requireNative(await getNative());
        return {
          displays: n.getDisplays(),
          cursor: n.cursorLocation(),
          windows: n.listWindows(),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'computer_open',
      description:
        'Open a URL, file, or application using the macOS `open` command (the system launcher; no extra binary). ' +
        'For a URL, pass the full address (e.g. "https://example.com"). For an app, pass its name (e.g. "Safari") or a file path.',
      parameters: {
        target: {
          type: 'string',
          required: true,
          description: 'URL, file path, or application name to open.',
        },
        app: {
          type: 'string',
          description: 'Optional application to open the target with (e.g. "Google Chrome").',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      isConcurrencySafe: () => true,
      async execute(args) {
        const argv = args.app ? ['-a', args.app, args.target] : [args.target];
        try {
          const { stdout, stderr } = await execFileAsync('/usr/bin/open', argv);
          return { opened: true, target: args.target, stdout, stderr };
        } catch (error) {
          throw new Error(`computer_open failed: ${error.message}`, { cause: error });
        }
      },
    }),
  );

  // Input tools (single-threaded: never run concurrently).
  const inputOptions = { isConcurrencySafe: () => false };

  ctx.tools.register(
    defineTool({
      name: 'computer_move',
      description:
        "Move the agent cursor to (x, y) in global display points (top-left origin of the main display, same space reported by computer_screen_info). The user's real mouse pointer is not moved.",
      parameters: {
        x: { type: 'number', required: true, description: 'X coordinate in global points.' },
        y: { type: 'number', required: true, description: 'Y coordinate in global points.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      ...inputOptions,
      async execute(args) {
        const n = requireNative(await getNative());
        if (!n.isTrusted()) throw accessibilityError();
        await n.move(args.x, args.y, resolved.virtualCursor);
        return { moved: true, x: args.x, y: args.y };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'computer_click',
      description:
        'Click at (x, y) in global display points using a virtual agent cursor (the user\'s real pointer is not moved). Use button "left" (default), "right", or "middle", and count 1 (default) or 2 for a double-click.',
      parameters: {
        x: { type: 'number', required: true, description: 'X coordinate in global points.' },
        y: { type: 'number', required: true, description: 'Y coordinate in global points.' },
        button: { type: 'string', description: '"left", "right", or "middle". Default "left".' },
        count: { type: 'integer', description: '1 (default) or 2 (double-click).' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      ...inputOptions,
      async execute(args) {
        const n = requireNative(await getNative());
        if (!n.isTrusted()) throw accessibilityError();
        const button = args.button === 'right' ? 1 : args.button === 'middle' ? 2 : 0;
        const count = args.count === 2 ? 2 : 1;
        await n.click(args.x, args.y, button, count, resolved.postDelayMs, resolved.virtualCursor);
        return { clicked: true, x: args.x, y: args.y, button: args.button ?? 'left', count };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'computer_drag',
      description:
        'Drag the mouse from (x1, y1) to (x2, y2) in global display points, with the button held down. Useful for moving windows, selecting text, or dragging sliders.',
      parameters: {
        x1: { type: 'number', required: true },
        y1: { type: 'number', required: true },
        x2: { type: 'number', required: true },
        y2: { type: 'number', required: true },
        button: { type: 'string', description: '"left" (default), "right", or "middle".' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      ...inputOptions,
      async execute(args) {
        const n = requireNative(await getNative());
        if (!n.isTrusted()) throw accessibilityError();
        const button = args.button === 'right' ? 1 : args.button === 'middle' ? 2 : 0;
        await n.drag(
          args.x1,
          args.y1,
          args.x2,
          args.y2,
          button,
          resolved.postDelayMs,
          resolved.virtualCursor,
        );
        return { dragged: true, from: { x: args.x1, y: args.y1 }, to: { x: args.x2, y: args.y2 } };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'computer_scroll',
      description:
        'Scroll at the given point (or the current cursor if x/y omitted) by `amount` wheel steps in a direction. ' +
        'Directions: "up", "down", "left", "right". If the direction feels reversed, use the opposite direction (natural scrolling).',
      parameters: {
        x: {
          type: 'number',
          description: 'X coordinate in global points; omit to scroll at the cursor.',
        },
        y: {
          type: 'number',
          description: 'Y coordinate in global points; omit to scroll at the cursor.',
        },
        direction: {
          type: 'string',
          required: true,
          description: '"up", "down", "left", or "right".',
        },
        amount: {
          type: 'integer',
          description: 'Wheel steps; defaults to the plugin scrollAmount.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      ...inputOptions,
      async execute(args) {
        const n = requireNative(await getNative());
        if (!n.isTrusted()) throw accessibilityError();
        const amount = args.amount ?? resolved.scrollAmount;
        let dx = 0;
        let dy = 0;
        switch (args.direction) {
          case 'up':
            dy = -amount;
            break;
          case 'down':
            dy = amount;
            break;
          case 'left':
            dx = -amount;
            break;
          case 'right':
            dx = amount;
            break;
          default:
            throw new Error('computer_scroll: direction must be "up", "down", "left", or "right".');
        }
        let point;
        if (args.x !== undefined && args.y !== undefined) point = { x: args.x, y: args.y };
        else point = n.cursorLocation();
        await n.scroll(point.x, point.y, dx, dy, resolved.virtualCursor);
        return { scrolled: true, at: point, direction: args.direction, amount };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'computer_type',
      description:
        'Type text into the currently focused field or window. Types the exact Unicode text (works for any characters). ' +
        'Use computer_key for special keys (return, tab, arrows, shortcuts).',
      parameters: {
        text: { type: 'string', required: true, description: 'The exact text to type.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      ...inputOptions,
      async execute(args) {
        const n = requireNative(await getNative());
        if (!n.isTrusted()) throw accessibilityError();
        await n.typeText(args.text, resolved.typeDelayMs);
        return { typed: true, length: args.text.length };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'computer_key',
      description:
        'Press a key or a key combination. Pass `keys` as an array of key names, e.g. ["cmd", "c"] for copy, ["return"], ["tab"], ["left"], ["cmd", "shift", "4"]. ' +
        'Supported names: letters a-z, digits 0-9, return/enter, tab, space, delete/backspace, escape, up/down/left/right, home, end, pageup, pagedown, f1-f12, ' +
        'and modifiers cmd/command, shift, option/alt, control/ctrl. Use computer_type for arbitrary text.',
      parameters: {
        keys: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Key names to press together.',
        },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: jsonRender },
      ...inputOptions,
      async execute(args) {
        const n = requireNative(await getNative());
        if (!n.isTrusted()) throw accessibilityError();
        await n.pressKeys(args.keys, resolved.postDelayMs);
        return { pressed: args.keys };
      },
    }),
  );

  // The screenshot tool requires the attachment service (to deliver the image).
  ctx.inject(['attachments'], (actx) => {
    actx.tools.register(
      defineTool({
        name: 'computer_screenshot',
        description:
          'Capture the macOS screen and return the image itself so you can see what is on the desktop or in the browser. ' +
          'The mouse cursor is included in the capture, so you can see where the pointer is. By default captures the main display; ' +
          'optionally pass a `region` ({x, y, width, height} in global points), a `window_id`, or a `display_id` (ids from computer_screen_info). ' +
          'The result includes the captured region bounds in points and the pixel-to-point scale so you can map pixels in the image back to click coordinates.',
        parameters: {
          region: {
            type: 'object',
            additionalProperties: false,
            description: 'Optional region in global points: {x, y, width, height}.',
            properties: {
              x: { type: 'number', required: true },
              y: { type: 'number', required: true },
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
            },
          },
          window_id: {
            type: 'integer',
            description:
              'Optional window id from computer_screen_info to capture just that window.',
          },
          display_id: {
            type: 'integer',
            description:
              'Optional display id from computer_screen_info to capture just that display.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              bounds: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  x: { type: 'number' },
                  y: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                },
              },
              nativeWidth: { type: 'integer' },
              nativeHeight: { type: 'integer' },
              imageWidth: { type: 'integer' },
              imageHeight: { type: 'integer' },
              scale: { type: 'number' },
              image: { type: 'object', additionalProperties: true },
            },
          },
          render: (_args, value) => {
            const text =
              `<screen capture>\n` +
              `region bounds (points): x=${value.bounds.x} y=${value.bounds.y} width=${value.bounds.width} height=${value.bounds.height}\n` +
              `native pixels: ${value.nativeWidth}x${value.nativeHeight}\n` +
              `image pixels: ${value.imageWidth}x${value.imageHeight}\n` +
              `scale: ${value.scale} image pixels per point\n` +
              `To click a location seen in this image at image pixel (px, py), call computer_click at x = ${value.bounds.x} + px/${value.scale}, y = ${value.bounds.y} + py/${value.scale}.`;
            return [
              { type: 'text', text },
              { type: 'image', attachment: value.image },
            ];
          },
        },
        isConcurrencySafe: () => true,
        async execute(args) {
          const n = requireNative(await getNative());
          if (!n.hasScreenRecording()) throw screenRecordingError();

          // Determine the capture bounds (global points) and the screencapture mode.
          let bounds;
          let windowId;
          let displayId;
          if (args.window_id !== undefined) {
            const win = n.listWindows().find((w) => w.id === args.window_id);
            if (!win || !win.bounds)
              throw new Error(
                `computer_screenshot: no on-screen window with id ${args.window_id}.`,
              );
            bounds = {
              x: win.bounds.x,
              y: win.bounds.y,
              width: win.bounds.width,
              height: win.bounds.height,
            };
            windowId = args.window_id;
          } else if (args.region) {
            bounds = {
              x: args.region.x,
              y: args.region.y,
              width: args.region.width,
              height: args.region.height,
            };
          } else if (args.display_id !== undefined) {
            const disp = n.getDisplays().find((d) => d.id === args.display_id);
            if (!disp)
              throw new Error(`computer_screenshot: no display with id ${args.display_id}.`);
            bounds = disp.bounds;
            displayId = args.display_id;
          } else {
            bounds = n.mainDisplayBounds();
          }

          const captured = await captureScreenshot({ bounds, windowId, displayId });

          const attachments = actx.get('attachments');
          if (!attachments)
            throw new Error(
              'computer_screenshot: no attachment service is mounted; cannot deliver the image to the model.',
            );

          // Save through the attachment store; it normalises and downscales if
          // the raster exceeds the deployment image limits.
          const ref = await attachments.saveImage({
            data: captured.bytes,
            mediaType: 'image/png',
            name: 'screenshot.png',
          });

          const scale = ref.width / bounds.width;
          return {
            bounds,
            nativeWidth: captured.width,
            nativeHeight: captured.height,
            imageWidth: ref.width,
            imageHeight: ref.height,
            scale,
            image: {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.originalDimensions ? { originalDimensions: ref.originalDimensions } : {}),
            },
          };
        },
      }),
    );
  });

  // System prompt guidance, registered when a systemPrompt service exists.
  ctx.inject(['systemPrompt'], (sctx) => {
    let order = 3000;
    try {
      order = sctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE');
    } catch {
      /* fall back to the reserved order */
    }
    sctx.systemPrompt.section({
      name: 'computer-use',
      order,
      text:
        'You have a computer-use toolset that can see and control the macOS desktop and browser (computer_screenshot, computer_screen_info, computer_move, computer_click, computer_drag, computer_scroll, computer_type, computer_key, computer_open).\n' +
        'Workflow: (1) call computer_screen_info or computer_screenshot to observe the current state; (2) identify the target element in the image; (3) convert image pixels to global points using the scale and bounds returned by computer_screenshot; (4) act with mouse/keyboard; (5) take another screenshot to verify the result.\n' +
        'All mouse coordinates are global display points with the origin at the top-left of the main display; do not mix them up with image pixels.\n' +
        'Mouse actions use a floating "agent cursor" and do not move the user\'s real pointer; keyboard input still goes to the focused app, so use computer_open to launch/focus the app you need to type into.\n' +
        'These tools control the real desktop, so act deliberately, re-check after each step, and undo mistakes where possible.',
    });
  });
}

export { Config, apply, inject, name };
