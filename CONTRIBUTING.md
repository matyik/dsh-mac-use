# Contributing to dsh-mac-use

Thanks for wanting to help out. This project is small, so the bar for getting involved is
low — but a couple of conventions keep things moving cleanly.

## Before you write code

- **Open an issue first for anything non-trivial.** New features, behavior changes, bug
  fixes that need discussion, or anything larger than a few lines — start with an issue so
  we can agree on the approach before you invest in a PR. This prevents duplicated or
  unwanted work.
- **Trivial changes** (typos, doc fixes, small cleanups) can skip straight to a PR.

## Workflow

1. Fork the repository.
2. Branch from `main`. Use a short, descriptive name: `feat/foo`, `fix/bar`, `docs/baz`.
3. Make focused, self-contained changes. One PR, one concern.
4. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages:
   `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, etc.
5. Run `node --check index.js` to make sure the plugin still parses.
6. Push and open a pull request.

## Pull requests

- Reference the issue it closes (e.g. `Closes #12`).
- Describe **what** changed and **why** — especially for anything that touches the FFI or
  event handling.
- Keep the diff reviewable. Split unrelated changes into separate PRs.

## Code conventions

- Plain JavaScript (ESM), no build step. Don't introduce TypeScript or a bundler unless an
  issue explicitly calls for it.
- Match the existing style: 2-space indent, single quotes, semicolons.
- Native calls go through `koffi`. Always test FFI changes in the actual Electron host
  (`ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness" --expose-internals your-test.mjs`), not just
  plain `node` — the two are not equivalent.
- New config knobs go in the plugin `Config` and get documented in `README.md`.

## Releasing

Releases are cut automatically. Bump `version` in `package.json` (SemVer), merge to
`main`, and the CI workflow tags `v<version>`, publishes a GitHub Release with
auto-generated notes, and publishes to npm. Keep the [CHANGELOG](CHANGELOG.md) updated in
the same PR.

Publishing uses npm **trusted publishing (OIDC)** — no long-lived token. One-time setup:

1. Publish the package once from your machine (`npm login && npm publish`) to create it.
2. On npm, open the package → **Settings → Access → Trusted Publishing**, and add the
   publisher: owner `matyik`, repo `dsh-mac-use`, workflow `release.yml`, branch `main`,
   registry `https://registry.npmjs.org`.

After that, version bumps publish automatically.

## Code of conduct

Be kind. Assume good intent. Review feedback is about the code, never the person.
