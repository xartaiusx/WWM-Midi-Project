# Repository Maintenance

This repository follows a solo-public maintenance model: practical for local development, readable to outside users, and light on process overhead.

## Branch Protection

Use a GitHub ruleset for `main` when the repository is ready for enforced checks.

Recommended required status checks:

- `Windows checks`
- `Release package` for release tags only, if tag protection is enabled.

Recommended rules:

- Require a pull request before merging when practical.
- Require status checks to pass.
- Block force pushes to `main`.
- Block deletions of `main`.

## GitHub Actions

Workflow defaults should keep `contents: read`. Jobs that publish a release may request `contents: write`.

Actions should remain pinned to full commit SHAs and annotated with the intended version.

## Dependabot

Dependabot should keep grouped weekly updates for:

- GitHub Actions
- Bun/npm dependencies
- Cargo dependencies

Review grouped updates with the normal verification commands before merging.

## Maintainability Backlog

The largest Rust and Svelte modules should be split gradually without behavior changes:

- Rust commands and Tauri wiring.
- Playback state and keyboard input.
- Library, album, and sharing flows.
- Audio-to-MIDI commands and status reporting.
- Large UI views and stores.

Each refactor should keep public behavior and saved data compatibility unchanged.
