## Summary

-

## Verification

- [ ] `.\scripts\dev.cmd bun install --frozen-lockfile`
- [ ] `.\scripts\dev.cmd bun run test`
- [ ] `.\scripts\dev.cmd bun run build`
- [ ] `.\scripts\dev.cmd bun run album:audit`
- [ ] `.\scripts\dev.cmd bun run shortcut:verify`
- [ ] `.\scripts\dev.cmd cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`
- [ ] `.\scripts\dev.cmd cargo check --manifest-path src-tauri/Cargo.toml --locked`
- [ ] `.\scripts\dev.cmd cargo clippy --manifest-path src-tauri/Cargo.toml --locked -- -D warnings`
- [ ] `.\scripts\dev.cmd bun run tauri-build` if this changes release packaging, Tauri, Rust, shortcuts, or installers

## Project Boundaries

- [ ] No private, copyrighted, generated, or unsourced MIDI files were added.
- [ ] Album entries include source and license/status in `album-manifest.json` when public MIDI files are intentionally added.
- [ ] Gameplay/input behavior was not changed unless this PR explicitly covers that behavior.
- [ ] Playlist duplicate behavior was not changed unless this PR explicitly covers that behavior.
