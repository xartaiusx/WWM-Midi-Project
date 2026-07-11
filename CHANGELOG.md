# Changelog

All notable repository-facing changes are tracked here.

## Unreleased

- No unreleased changes.

## 1.2.0 - 2026-07-11

- Added the exact 36-key Konghou instrument profile with explicit transpose and octave-only range fitting.
- Preserved Standard MIDI tempo maps, rejected unsupported timing formats, excluded percussion, and added continuity-aware melody selection.
- Added absolute-deadline playback scheduling, truthful input results, calibrated modifier timing, and reliable cancellation cleanup.
- Added the local Konghou calibration workflow, compatibility preflight reports, provenance ledger, 50-song gold corpus, and player accuracy audit.
- Updated the Tauri stack and vulnerable Rust dependencies, and moved GitHub Actions checkout to its Node 24 runtime.
- Added MIT license, security policy, contributing guide, and repository maintenance docs.
- Added album manifest JSON schema for the tracked album audit contract.
- Reworked GitHub Actions so `main` and pull requests run CI, while release publishing is limited to tags or explicit manual release input.
- Tightened Tauri project metadata and webview security defaults without changing playback behavior.
- Documented release, album audit, audio-to-MIDI, troubleshooting, and maintainability follow-up work.

## 1.1.9

- Branded and documented the local WWM Midi Project workspace.
- Kept generated songs, recordings, release artifacts, toolchains, and private runtime content out of Git by default.
