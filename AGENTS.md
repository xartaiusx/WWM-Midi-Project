# AGENTS.md

## Project Expectations

- This is a Windows-first Tauri 2 + Svelte 5 + Rust project for WWM Midi Project.
- Use `scripts\dev.cmd` as the Windows entrypoint for local commands so Bun, Rust, Visual Studio Build Tools, Git, and local dev tools resolve consistently.
- Prefer Bun for package scripts and installs. Do not add npm lifecycle hooks or npm-only instructions.
- Do not change gameplay behavior unless the request explicitly asks for it. Pause/input changes must stay scoped to music-mode safeguards.
- Do not alter playlist duplicate behavior unless explicitly requested; playlists intentionally allow queue-style repeated entries in some flows.
- Do not add MIDI songs unless the source and license/status are recorded in the album audit workflow.

## Common Commands

Run from the repository root:

```powershell
.\scripts\dev.cmd bun install --frozen-lockfile
.\scripts\dev.cmd bun run test
.\scripts\dev.cmd bun run build
.\scripts\dev.cmd bun run tauri-build
.\scripts\dev.cmd bun run album:audit
.\scripts\dev.cmd bun run shortcut:verify
```

For development:

```powershell
.\scripts\dev.cmd bun run dev
.\scripts\dev.cmd bun run tauri-dev
.\scripts\dev.cmd bun run test:watch
```

## Verification Before Handoff

- Run focused tests for the changed area first.
- For release/tooling changes, run `bun run test`, `bun run build`, `bun run album:audit`, and `bun run shortcut:verify` through `scripts\dev.cmd`.
- Run `bun run tauri-build` for Tauri, Rust, release, shortcut, or installer changes when time allows.
- Leave the worktree clean except for intentional edits, and never revert unrelated user changes.

## Album Rules

- The default runtime album is `src-tauri\target\release\album`, which is ignored by Git.
- `album-manifest.json` is the tracked audit contract. Use statuses: `approved-sourceable`, `needs-user-source`, `needs-license`, or `rejected`.
- `album:audit` must pass before release. Exact duplicate hashes fail unless explicitly allowlisted. Normalized song duplicates fail unless explicitly allowlisted.
- Public-domain/CC sources still need a source URL or source note in the manifest before they are considered fully approved.

## Release Notes

- Release workflows should use Bun, least-privilege GitHub token permissions, and pinned action SHAs.
- Tauri CSP and capabilities are security boundaries. Keep CSP restrictive and capabilities scoped to the `main` window.
- The app may need Administrator rights to send input to the game; packaging changes must not hide that requirement.
