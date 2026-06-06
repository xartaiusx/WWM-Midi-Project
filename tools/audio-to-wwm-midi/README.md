# WWM Audio-to-MIDI Creator

This tool records local Windows playback or accepts an existing audio/MIDI file,
then creates a WWM Midi Project friendly `.mid` file in the project library.

The pipeline is:

1. WASAPI loopback recording with PyAudioWPatch, or an existing audio file.
2. Spotify Basic Pitch transcription to raw MIDI.
3. WWM optimization for the project's 21/36-key playback limits.
4. Save the optimized `.mid` and a `.report.json` beside it.

## Setup

```cmd
scripts\setup-audio-midi.cmd
```

This installs/uses Python 3.11, creates `.dev-tools\audio-midi-venv`, and installs
Basic Pitch plus the Windows loopback recorder dependency.

## Examples

Optimize an existing MIDI without machine learning:

```cmd
scripts\audio-to-midi.cmd optimize --input song.mid --name "Song" --profile harp --key-mode 36
```

Convert an audio file:

```cmd
scripts\audio-to-midi.cmd create --input song.wav --name "Song" --profile harp --key-mode 36
```

Record local system audio, convert it, and save it to the library:

```cmd
scripts\audio-to-midi.cmd create --record 30 --name "Recorded Clip" --profile harp --key-mode 36
```

## Profiles

- `harp`: melody-first, low polyphony, arpeggiated harmony.
- `balanced`: moderate chords and timing cleanup.
- `debug_raw`: minimal simplification for diagnostics.

## Notes

Full mixed songs can produce noisy transcriptions. Clean single-instrument audio
works best, especially harp, piano, guitar, flute, and isolated melodies.
