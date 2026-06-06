# Release Process

Releases are intentional. `main` runs CI, but it does not create GitHub releases automatically.

## Local Verification

Run from the repository root:

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

Run the full package build when Windows C++ build tools are visible:

```powershell
.\scripts\dev.cmd bun run tauri-build
```

## Publishing

Use a `v*` tag for a normal release:

```powershell
git tag v1.1.10
git push origin v1.1.10
```

The release workflow builds the Windows app, creates the runtime `album` folder next to the executable, generates SHA256 checksums, uploads artifacts, and publishes a GitHub release.

Manual dispatch can publish a release when a tag name is supplied. Manual dispatch without a tag name is for artifact-only package testing.

## Release Notes

Keep `CHANGELOG.md` current before tagging. Release notes should include:

- Installation notes.
- Administrator-rights reminder.
- Integrity/checksum note.
- User-facing changes since the previous tag.
