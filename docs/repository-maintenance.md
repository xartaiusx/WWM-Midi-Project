# Repository Maintenance

This repository follows a solo-public maintenance model: practical for local development, readable to outside users, and light on process overhead.

## Branch Protection

Use a light GitHub ruleset for `main` so the public branch stays recoverable without making solo maintenance heavy.

Required status checks:

- `Windows checks`

Rules:

- Require status checks to pass.
- Block force pushes to `main`.
- Block deletions of `main`.
- Allow repository admins to bypass for emergency owner-maintained fixes.

Do not require pull requests for every owner change unless the project grows beyond the current solo-public maintenance model.

## Public Repository Settings

Recommended public metadata:

- Description: `Windows-first Tauri/Svelte/Rust MIDI player and local album manager for WWM-style playback.`
- Topics: `tauri`, `svelte`, `rust`, `midi`, `windows`, `desktop-app`, `music`, `bun`.
- Issues enabled.
- Private vulnerability reporting enabled.

Keep the public Releases page focused on semver releases. Remove obsolete nightly/prerelease tags such as `main-1` and `main-2` once they are no longer useful.

## GitHub Actions

Workflow defaults should keep `contents: read`. Jobs that publish a release may request `contents: write`.

Actions should remain pinned to full commit SHAs and annotated with the intended version.

Release builds should generate artifact attestations for the executable, installers, and checksum file.

CodeQL should scan JavaScript/TypeScript, Rust, and GitHub Actions workflows on pull requests, pushes to `main`, manual dispatch, and a weekly schedule.

## Dependabot

Dependabot should keep grouped weekly updates for:

- GitHub Actions
- Bun/npm dependencies
- Cargo dependencies

Review grouped updates with the normal verification commands before merging.

Keep security updates grouped separately from routine version updates. Keep major updates separate from minor/patch updates so broad compatibility shifts are reviewed intentionally.

## Recovery Readiness

Use `.\scripts\dev.cmd bun run recovery:check` before ending a development session or after pushing important work. The check verifies that the active working folder is on `main`, tracks `origin/main`, has no uncommitted source changes, includes the expected recovery-critical files, and is not accidentally committing ignored local-only outputs.

## Maintainability Backlog

The largest Rust and Svelte modules should be split gradually without behavior changes:

- Rust commands and Tauri wiring.
- Playback state and keyboard input.
- Library, album, and sharing flows.
- Audio-to-MIDI commands and status reporting.
- Large UI views and stores.

Each refactor should keep public behavior and saved data compatibility unchanged.
