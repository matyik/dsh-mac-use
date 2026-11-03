#!/usr/bin/env node
// AX snapshot smoke test. Run inside the Electron host so the Accessibility
// grant applies to DeepSeek Harness:
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
//     --expose-internals scripts/ax-smoke.mjs [app] [maxNodes] [maxChars] [maxDepth]
import { axSnapshot } from '../index.js';

const app = process.argv[2];
const num = (v) => (v === undefined ? undefined : Number(v));
const opts = {
  app,
  maxNodes: num(process.argv[3]),
  maxChars: num(process.argv[4]),
  maxDepth: num(process.argv[5]),
};

try {
  const started = Date.now();
  const snap = await axSnapshot(opts);
  const elapsed = Date.now() - started;
  const status = snap.truncated ? 'truncated' : 'complete';
  console.log(
    `${snap.snapshotId} · ${snap.app.name} (pid ${snap.app.pid}) · ` +
      `${snap.returned}/${snap.count} nodes · ${snap.chars} chars · ${status} · ${elapsed} ms`,
  );
  console.log(snap.text);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
