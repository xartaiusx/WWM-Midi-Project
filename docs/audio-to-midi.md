# Audio-to-MIDI Workflow

The audio-to-MIDI tools help turn local audio, system audio recordings, or existing MIDI files into project-friendly MIDI files.

## Setup

```powershell
.\scripts\setup-audio-midi.cmd
.\scripts\audio-to-midi.cmd status
```

The app also exposes setup and conversion from the Create MIDI view.

## Profiles

- `harp`: melody-first, low-polyphony output for harp-style playback.
- `balanced`: keeps moderate harmony after cleanup.
- `debug_raw`: minimal cleanup for troubleshooting transcription quality.

## Common Commands

Optimize an existing MIDI:

```powershell
.\scripts\audio-to-midi.cmd optimize --input song.mid --name "Song" --profile harp --key-mode 36
```

Convert an audio file:

```powershell
.\scripts\audio-to-midi.cmd create --input song.wav --name "Song" --profile harp --key-mode 36
```

Record local system audio for a fixed duration:

```powershell
.\scripts\audio-to-midi.cmd create --record 30 --name "Recorded Clip" --profile harp --key-mode 36
```

## Publishing Rules

Generated songs are local-only by default. Do not commit generated MIDI or recordings unless the source and license/status are recorded in `album-manifest.json` and pass `album:audit`.
