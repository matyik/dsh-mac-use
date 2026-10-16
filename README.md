<div align="center">

# dsh-mac-use

**Computer-use for DeepSeek Harness on macOS.**

Let an agent *see* the screen, *drive* the mouse and keyboard, and *open* apps and URLs —
the same observe → act → verify loop as Claude's `computer` tool or Codex computer-use,
shipped as a single DeepSeek Harness bundle.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20(arm64)-lightgrey)](#)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-4b32c3)](#)
[![Release](https://img.shields.io/github/v/release/matyik/dsh-mac-use?sort=semver)](https://github.com/matyik/dsh-mac-use/releases)

</div>

## Why

Most computer-use setups ship a separate helper binary that needs its own screen-recording
and accessibility grants. `dsh-mac-use` doesn't:

- **Plugin only, no extra binary.** Everything runs inside the DeepSeek Harness Desktop
  host process. Screen capture uses the bundled `screencapture` tool; mouse/keyboard and
  window inspection call macOS APIs through the `koffi` FFI library (an npm dependency).
- **Permissions come from the Harness app itself.** Because the plugin runs in the Desktop
  host (a child of the Electron app), macOS checks Screen Recording and Accessibility
  against *DeepSeek Harness*. Grant those two once — never to a helper.
- **Virtual agent cursor.** Mouse actions don't strand your real pointer: clicks land,
  then your cursor snaps back, while a floating orange dot glides between action points so
  you can watch the agent work — and it disappears when the task is done.

## Tools

| Tool | What it does |
| --- | --- |
| `computer_screenshot` | Capture the screen (main display, a region, a window, or a display) and return the image plus bounds and pixel→point scale. |
| `computer_screen_info` | Read display geometry (points), cursor position, and the on-screen window list (id, app, title, bounds). |
| `computer_move` | Move the **agent cursor** to `(x, y)` in global display points (your real pointer is untouched). |
| `computer_click` | Click at `(x, y)` — left/right/middle, single or double. |
| `computer_drag` | Drag from `(x1, y1)` to `(x2, y2)`. |
| `computer_scroll` | Scroll up/down/left/right at a point or the cursor. |
| `computer_type` | Type arbitrary Unicode text into the focused field. |
| `computer_key` | Press a key or chord (letters, digits, arrows, return, tab, escape, F-keys, and `cmd`/`shift`/`option`/`control`). |
| `computer_open` | Open a URL, file, or app via the system `open` command. |

A system-prompt section teaches the agent the workflow: observe → locate → convert image
pixels to global points → act → screenshot again to verify.

## Requirements

- **DeepSeek Harness Desktop** (the macOS app), running on macOS (Apple Silicon).
- A **vision-capable model** for full observe-and-act (e.g. `deepseek-flash`, which reads
  images). Text-only models can still use `computer_screen_info` and the action tools.

### Permissions (once)

1. **System Settings → Privacy & Security → Screen Recording** → enable **DeepSeek Harness**.
2. **System Settings → Privacy & Security → Accessibility** → enable **DeepSeek Harness**
   (needed for mouse/keyboard input).
3. Fully quit and reopen DeepSeek Harness.

Missing a permission? The relevant tool fails with a message naming the exact setting.

## Install

Install through the built-in Plugin Manager — no shell commands, no manual profile edits:

- **Plugin Manager (recommended):** Web sidebar → **Plugins → Install bundle**, enter the
  package as a git URL, an npm spec, or a local directory (e.g.
  `github:matyik/dsh-mac-use`).
- **`plugin_manager` tool:** `install_bundle` with the same target.

The only dependency is `koffi@3.1.1` (the version the Desktop runtime ships). It bundles a
prebuilt `darwin-arm64` binary and its install script is a fast prebuild check — no
compilation. pnpm 11 may ask you to approve that script once: click **Allow these scripts
and retry** and it finishes instantly.

## Coordinate system

All mouse coordinates are **global display points**, origin at the top-left of the main
display (the same space as `computer_screen_info` and the click tools). Screenshots are
returned in **device pixels**, so `computer_screenshot` also reports `bounds` (points) and
`scale` (image pixels per point):

```
x = bounds.x + px / scale
y = bounds.y + py / scale
```

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `virtualCursor` | `true` | Use the virtual agent cursor (click, then restore your pointer) and show the floating dot. Set `false` to leave the pointer where it clicked. |
| `postDelayMs` | `25` | Delay between press/release events. |
| `scrollAmount` | `3` | Scroll wheel units per step. |
| `typeDelayMs` | `0` | Per-character typing delay. |

## Security

These tools drive the real desktop — treat them as powerful. They run under the agent's
normal permission/approval policy; keep them in a preset that prompts before acting, and
have the agent re-check its work with a follow-up screenshot. macOS-only: on other
platforms the tools register but error when called.

## Contributing

PRs welcome — please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE) © [matyik](https://github.com/matyik)
