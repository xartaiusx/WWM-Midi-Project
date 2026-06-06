# Contributing

WWM Midi Project is maintained as a solo-public Windows-first project. Contributions are welcome when they fit the local playback, library, release, and audio-to-MIDI goals without changing gameplay behavior unexpectedly.

## Development Setup

Use the repository root and route commands through the Windows helper:

```powershell
.\scripts\dev.cmd bun install --frozen-lockfile
.\scripts\dev.cmd bun run test
.\scripts\dev.cmd bun run build
.\scripts\dev.cmd bun run album:audit
```

Use Bun for package scripts and installs. Do not add npm lifecycle hooks or npm-only instructions.

## Change Guidelines

- Keep behavior changes tightly scoped.
- Do not change playlist duplicate behavior unless the issue explicitly asks for it.
- Do not change gameplay/input behavior unless the issue explicitly asks for it.
- Keep generated MIDI, recordings, copyrighted songs, and private diagnostics out of Git.
- Add album entries only when source and license/status are recorded in `album-manifest.json`.
- Prefer docs in `docs/` when a topic would make the README too long.

## Pull Request Checklist

Before opening a pull request, run the focused checks for the changed area. For release, tooling, Tauri, or repository-organization changes, run:

```powershell
.\scripts\dev.cmd bun install --frozen-lockfile
.\scripts\dev.cmd bun run test
.\scripts\dev.cmd bun run build
.\scripts\dev.cmd bun run album:audit
.\scripts\dev.cmd bun run shortcut:verify
.\scripts\dev.cmd cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
.\scripts\dev.cmd cargo check --manifest-path src-tauri/Cargo.toml --locked
.\scripts\dev.cmd cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings
```

Run `.\scripts\dev.cmd bun run tauri-build` when Windows C++ build tools are available and the change touches desktop packaging, Tauri config, Rust, release tooling, or shortcut behavior.
