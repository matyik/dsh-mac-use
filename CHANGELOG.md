# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `computer_ax_snapshot`: read-only Accessibility (AX) UI tree as compact text, with
  roles, titles, values, and screen-coordinate frames per node plus a stable integer
  `[ref]` for each. Read-only (Phase 1 — no acting on elements yet), bounded by
  `maxDepth`/`maxNodes`/`maxChars` and a ~1.5 s wall-clock deadline so an unresponsive
  app can't freeze the agent. Emitted elements are retained in an LRU cache keyed by
  snapshot id for a later action phase.
- `scripts/ax-smoke.mjs` dev script to print a snapshot from the Electron host.

## [0.1.3] - 2026-10-23

### Fixed

- Agent cursor window is fully transparent (no more dark background box behind the arrow).
- `computer_key` modifiers (`cmd`, `shift`, `option`, `control`) are now released
  correctly, so a chord like `cmd+a` no longer leaves the modifier stuck for later typing.

## [0.1.2] - 2026-10-23

### Changed

- Agent cursor is now a blue pointer arrow (DeepSeek blue `#4D6BFE`) with a white outline,
  ~2x the system cursor, 90% opaque, and its tip sits exactly on the action point.

## [0.1.1] - 2026-10-16

### Changed

- Added Prettier formatting and ESLint linting; reformatted the codebase and removed dead code.
- Rethrown tool errors now carry their original error as `cause`.

## [0.1.0] - 2026-10-15

### Added

- Initial release: computer-use toolset for DeepSeek Harness on macOS.
- `computer_screenshot`, `computer_screen_info`, `computer_move`, `computer_click`,
  `computer_drag`, `computer_scroll`, `computer_type`, `computer_key`, and `computer_open`.
- Virtual agent cursor: click without stranding the real pointer, a floating orange dot
  that glides between actions and hides when the task ends.
- Screen capture via the bundled `screencapture` tool (cursor included).
- Release automation via GitHub Actions.

[0.1.3]: https://github.com/matyik/dsh-mac-use/releases/tag/v0.1.3
[0.1.2]: https://github.com/matyik/dsh-mac-use/releases/tag/v0.1.2
[0.1.1]: https://github.com/matyik/dsh-mac-use/releases/tag/v0.1.1
[0.1.0]: https://github.com/matyik/dsh-mac-use/releases/tag/v0.1.0
