# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.1]: https://github.com/matyik/dsh-mac-use/releases/tag/v0.1.1
[0.1.0]: https://github.com/matyik/dsh-mac-use/releases/tag/v0.1.0
