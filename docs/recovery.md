# Recovery And Redownload

This project should have one active local working folder:

```text
C:\Users\<you>\Documents\WWM Midi Project
```

Use that folder for source edits, local toolchains, generated release builds, private MIDI tests, recordings, and runtime album content. Do not keep a second working clone with a similar name, because it becomes too easy to edit, build, or launch the wrong copy.

## What GitHub Restores

The GitHub repository is the source of truth for files that should survive a lost local machine:

- Application source in `src/` and `src-tauri/`.
- Windows scripts in `scripts/`.
- Audio-to-MIDI tooling in `tools/audio-to-wwm-midi/`.
- Documentation in `README.md`, `AGENTS.md`, and `docs/`.
- CI and release automation in `.github/workflows/`.
- Dependency lockfiles, Rust config, Tauri config, and the album audit contract.

Generated folders and private runtime files are intentionally not committed:

- `node_modules/`
- `.dev-tools/`
- `.temp/`
- `dist/`
- `src-tauri/target/`
- local logs, diagnostics, generated MIDI, private recordings, and unapproved runtime album files

If a MIDI file or recording is personal, copyrighted, experimental, or does not have a recorded source/license status, keep it local. If it should become part of the public project, add its source and license/status to the album audit workflow before committing it.

## Fresh Restore

On a new Windows machine or after losing the local copy:

```powershell
cd C:\Users\<you>\Documents
git clone https://github.com/<your-github-username>/WWM-Midi-Project.git "WWM Midi Project"
cd "WWM Midi Project"
.\scripts\dev.cmd bun install --frozen-lockfile
.\scripts\setup-audio-midi.cmd
.\scripts\audio-to-midi.cmd status
.\scripts\dev.cmd bun run test
.\scripts\dev.cmd bun run build
.\scripts\dev.cmd bun run album:audit
.\scripts\dev.cmd bun run shortcut:verify
```

When Windows C++ build tools are available, also run:

```powershell
.\scripts\dev.cmd bun run tauri-build
.\scripts\create-desktop-shortcut.cmd
```

## Save Current Work

Before ending a development session:

```powershell
cd "C:\Users\<you>\Documents\WWM Midi Project"
git status --short --branch
.\scripts\dev.cmd bun run test
.\scripts\dev.cmd bun run build
.\scripts\dev.cmd bun run album:audit
.\scripts\dev.cmd bun run shortcut:verify
git add -A
git commit -m "Describe the completed work"
git push origin main
.\scripts\dev.cmd bun run recovery:check
```

The recovery check confirms that the local `main` branch matches `origin/main`, the working tree is clean, core source files are present, and local-only generated folders are still being ignored instead of accidentally committed.

## Quick Health Check

Run this any time you want to know whether the current folder is safely recoverable from GitHub:

```powershell
.\scripts\dev.cmd bun run recovery:check
```

If it reports local edits, commit and push them or intentionally discard only the files you are sure are not needed. If it reports that the branch is ahead or behind, resolve that before doing more work.
