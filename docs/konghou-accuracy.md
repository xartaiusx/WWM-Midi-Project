# Konghou Accuracy And Local Music Policy

`wwm-konghou-36` is the authoritative Where Winds Meet profile. It maps MIDI
notes 48-83 chromatically to the visible Konghou keys, applies explicit
semitone transpose once, and optionally fits range by octaves only. Legacy
21-key transforms are creative modes and are not pitch-exact.

## Playback Contract

- Accept SMF format 0 or 1 with metrical PPQN timing.
- Reject SMF format 2 and SMPTE timing with an actionable error.
- Preserve the complete tempo map on an absolute microsecond timeline.
- Exclude General MIDI channel 10 percussion.
- Select melody using track monophony, register, density, and temporal
  continuity; then retain bass/root and inner harmony up to the calibrated
  Konghou capacity.
- Treat Windows API acceptance as input delivery, not proof that WWM produced
  a note. WASAPI loopback calibration provides the audio proof.

## Calibration

Open the WWM Konghou interface, mute unrelated system/game audio, then run the
three stages in Settings:

1. `36-pitch sweep`: verifies all pitches and modifier notes with YIN-style
   fundamental-frequency estimation.
2. `Timing and chord stress`: sweeps modifier lead, tap, and modifier release
   timing, then measures onset recall, relative onset error, chord spread, and
   the maximum rate with 100% verified onsets. A passing report becomes the
   locally persisted input timing profile.
3. `Five-minute drift`: verifies cumulative audio drift.

Reports are written beside the ignored local album. Strict certification
requires 36/36 pitches, no extra notes, 100% recall at the certified rate, p95
relative onset error at or below 25 ms, and less than 20 ms drift over five
minutes.

```powershell
.\scripts\dev.cmd bun run player:accuracy-audit
.\scripts\dev.cmd bun scripts/player-accuracy-audit.mjs --require-calibration
```

## Local Album Evidence

Initialize or refresh the ignored provenance and 50-song gold corpus without
changing MIDI files:

```powershell
.\scripts\dev.cmd bun run album:provenance
.\scripts\dev.cmd bun run album:gold
```

Every legacy song remains `legacy-local` and `needs-license` until its exact
source is reconstructed. Future candidates are parsed and compatibility-gated
before ranking with 35% popularity, 30% WWM compatibility, 20% provenance,
and 15% variety. Deduplication uses raw SHA256, canonical artist/title,
filename, and a transposition-invariant melody fingerprint.

Preferred evidence sources are [Bard Music Player](https://bardmusicplayer.com/),
[BitMidi](https://bitmidi.com/), and [VGMusic](https://www.vgmusic.com/).
Commercial soundtrack listings are title/credit references only. FFXIV tools
and repertoire are engineering references, not runtime compatibility targets.

Automated performance can carry account risk. Where Winds Meet's
[official enforcement notice](https://www.wherewindsmeetgame.com/news/official/BanReport.html)
identifies macros and similar third-party assists as potentially punishable.
The player does not provide stealth, anti-cheat evasion, memory access, or
packet manipulation.
