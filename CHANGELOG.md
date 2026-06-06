# Changelog

All notable repository-facing changes are tracked here.

## Unreleased

- Added MIT license, security policy, contributing guide, and repository maintenance docs.
- Added album manifest JSON schema for the tracked album audit contract.
- Reworked GitHub Actions so `main` and pull requests run CI, while release publishing is limited to tags or explicit manual release input.
- Tightened Tauri project metadata and webview security defaults without changing playback behavior.
- Documented release, album audit, audio-to-MIDI, troubleshooting, and maintainability follow-up work.

## 1.1.9

- Branded and documented the local WWM Midi Project workspace.
- Kept generated songs, recordings, release artifacts, toolchains, and private runtime content out of Git by default.
