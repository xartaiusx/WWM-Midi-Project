# WWM Midi Project

WWM Midi Project is a Windows-first local MIDI player, library manager, and audio-to-MIDI creator for WWM-style music playback.

The project focuses on practical local use:

- Manage a local MIDI library.
- Play MIDI through configurable 21-key and 36-key mappings.
- Create WWM-friendly MIDI files from existing MIDI, audio files, or local system audio recording.
- Keep generated songs, recordings, and personal test files local unless they are explicitly sourceable and safe to publish.
- Rebuild and launch the desktop app from a stable desktop shortcut.

## Current State

The app currently includes:

- Desktop player built with Tauri, Rust, Svelte, and Bun.
- Library, queue, favorites, playlists, stats, and settings views.
- Global playback shortcuts with configurable keybindings.
- 21-key natural-note and 36-key chromatic playback modes.
- Custom note-key layouts and mapping modes.
- Live MIDI input support.
- Band/session-oriented playback views.
- Audio-to-MIDI creator view inside the app.
- Windows loopback recording helper for local system audio capture.
- MIDI optimizer profiles for project playback constraints:
  - `harp`: melody-first, low-polyphony, light arpeggiation.
  - `balanced`: moderate harmony and cleanup.
  - `debug_raw`: minimal cleanup for diagnostics.
- Desktop shortcut scripts that point to the latest rebuilt release executable.
- CI workflows for frontend checks, album auditing, Rust checks, package builds, checksums, and release artifacts.

## Local-Only Files

The repository intentionally ignores generated and private runtime files:

- `node_modules/`
- `.dev-tools/`
- `.temp/`
- `dist/`
- `src-tauri/target/`
- generated `.mid` files
- logs and cache outputs

Keep copyrighted, personal, recorded, or experimental songs out of Git unless their source and license are documented and approved for publishing. Use the local Bard MIDI miner when expanding the private runtime album from bard-focused repositories.

The default runtime album folder is:

```text
src-tauri/target/release/album
```

That folder is for local testing and release-time runtime content. It is not committed by default.

## Local Project Folder

For a complete private working copy, keep the project folder at:

```text
C:\Users\<you>\Documents\WWM Midi Project
```

That local folder can include the repository, local toolchains, generated release builds, private MIDI files, recordings, and any local runtime album content needed to run the program.

## Setup

Run commands from the repository root through the Windows helper:

```cmd
scripts\dev.cmd bun install --frozen-lockfile
```

Audio-to-MIDI setup:

```cmd
scripts\setup-audio-midi.cmd
```

Check audio-to-MIDI readiness:

```cmd
scripts\audio-to-midi.cmd status
```

## Development Commands

Run tests:

```cmd
scripts\dev.cmd bun run test
```

Build frontend:

```cmd
scripts\dev.cmd bun run build
```

Run desktop development mode:

```cmd
scripts\dev.cmd bun run tauri-dev
```

Build release desktop app:

```cmd
scripts\dev.cmd bun run tauri-build
```

Create or refresh the desktop shortcut:

```cmd
scripts\create-desktop-shortcut.cmd
```

Verify the shortcut:

```cmd
scripts\dev.cmd bun run shortcut:verify
```

## Audio-to-MIDI Workflow

Optimize an existing MIDI:

```cmd
scripts\audio-to-midi.cmd optimize --input song.mid --name "Song" --profile harp --key-mode 36
```

Convert an audio file:

```cmd
scripts\audio-to-midi.cmd create --input song.wav --name "Song" --profile harp --key-mode 36
```

Record local system audio for 30 seconds, transcribe it, optimize it, and save it to the library:

```cmd
scripts\audio-to-midi.cmd create --record 30 --name "Recorded Clip" --profile harp --key-mode 36
```

Generated conversion reports are saved beside the optimized MIDI when possible.

## Local Bard MIDI Expansion

Discover local-only bard arrangements:

```cmd
scripts\dev.cmd bun run bard:discover-bmp -- --ensemble solo --pages all
scripts\dev.cmd bun run bard:discover-ffxivbard -- --focused-genres --pages all
```

Download a validated BMP solo batch into the ignored runtime album:

```cmd
scripts\dev.cmd bun run bard:download -- --source bmp --limit 250
scripts\dev.cmd bun run bard:verify
```

Continue auditing the full local catalog in small verified batches:

```cmd
scripts\dev.cmd bun run bard:audit-status
scripts\dev.cmd bun run bard:audit-batch -- --source bmp --max-downloads 100
scripts\dev.cmd bun run bard:verify
scripts\dev.cmd bun run album:audit
```

Clean local album titles so the app shows `Artist - Song` for safe rows:

```cmd
scripts\dev.cmd bun run bard:title-audit
scripts\dev.cmd bun run bard:title-apply
scripts\dev.cmd bun run bard:verify
scripts\dev.cmd bun run album:audit
```

Generate web-assisted suggestions for rows that still need manual title review:

```cmd
scripts\dev.cmd bun run bard:title-review-suggest
scripts\dev.cmd bun run bard:title-review-apply -- --batch 1
```

See [Local Bard MIDI miner](docs/bard-midi-miner.md) for source notes and safeguards.

## Project Structure

```text
.
|-- .github/                  CI and release workflows
|-- Diagnostics/              Local diagnostic tooling
|-- docs/                     Project, release, album, and maintenance notes
|-- scripts/                  Windows setup, build, audit, shortcut, and helper scripts
|-- src/                      Svelte frontend
|-- src-tauri/                Rust/Tauri desktop backend
|-- tools/audio-to-wwm-midi/  Audio recording, transcription, and MIDI optimization tools
|-- album-manifest.json       Public album audit policy
|-- package.json              Bun scripts and frontend dependencies
`-- README.md                 Project overview
```

## Documentation

- [Album audit policy](docs/album-audit.md)
- [Audio-to-MIDI workflow](docs/audio-to-midi.md)
- [Local Bard MIDI miner](docs/bard-midi-miner.md)
- [Release process](docs/release-process.md)
- [Repository maintenance](docs/repository-maintenance.md)
- [Recovery and redownload](docs/recovery.md)
- [Troubleshooting](docs/troubleshooting.md)

## Build Notes

- Use `scripts\dev.cmd` so local Bun, Rust, Git, and build-tool paths are resolved consistently.
- Full desktop release builds require the Windows C++ build tools to be available.
- The app may need elevated privileges when keyboard input must reach another elevated target window.
- Update checks are disabled by default for local builds unless an update API endpoint is provided through local environment configuration.

## Roadmap

Near-term:

- Make audio-to-MIDI recordings easier to trim and preview before saving.
- Add conversion quality scoring and clearer warnings for noisy transcriptions.
- Improve library import auditing and source/license tracking.
- Add a safer playback test mode that does not send keys to the target window.
- Expand automated smoke tests around the Create MIDI view and shortcut scripts.

Mid-term:

- Add editable conversion presets for instrument-specific profiles.
- Add waveform and piano-roll previews for created MIDI files.
- Improve large-library performance and chunking.
- Add a guided first-run setup checklist.
- Add release packaging polish around installers, checksums, and desktop shortcuts.

Long-term:

- Build a richer local composition workspace for arranging and cleaning created MIDI.
- Support better multi-track splitting for band/session workflows.
- Add optional local-only metadata for personal song notes, source tracking, and quality history.
