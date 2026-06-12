# Local Bard MIDI Miner

`scripts/bard-midi-miner.mjs` builds a local-only song library from bard-focused MIDI repositories without adding MIDI files to Git.

Primary sources:

- [Bard Music Player MIDI repository](https://bardmusicplayer.com/midis)
- [FFXIV-Bard songbook](https://ffxivbard.com/song/list)

The runtime album remains:

```text
src-tauri/target/release/album
```

That folder is ignored by Git. The miner also writes ignored local metadata beside the album:

- `.local-bard-catalog.json`: discovered BMP and FFXIV-Bard records.
- `.local-bard-source-ledger.json`: downloaded file source, SHA256, validation, and rejection notes.

## Discovery

Run BMP solo discovery first. BMP exposes structured metadata and is the best high-volume source for solo bard arrangements:

```powershell
.\scripts\dev.cmd bun run bard:discover-bmp -- --ensemble solo --pages all
```

Then add FFXIV-Bard solo discovery. The focused genre pass covers games, anime, pop, rock, and soundtrack pages sorted by downloads and rating:

```powershell
.\scripts\dev.cmd bun run bard:discover-ffxivbard -- --focused-genres --pages all
```

Use `--dry-run` with either discovery command to inspect counts without updating the local catalog.

## Download

Start with the highest-scoring BMP solo batch:

```powershell
.\scripts\dev.cmd bun run bard:download -- --source bmp --limit 250
```

The downloader skips files that are too short, too long, already present in the ledger, exact hash duplicates, or likely normalized-title duplicates. It validates every downloaded MIDI before moving it into the album folder.

To supplement from FFXIV-Bard:

```powershell
.\scripts\dev.cmd bun run bard:download -- --source ffxivbard --limit 100
```

## Full Catalog Audit

Use the audit commands when every discovered catalog record should become either an accepted local file or a recorded rejection.

Check current progress:

```powershell
.\scripts\dev.cmd bun run bard:audit-status
```

Run one small BMP batch at a time:

```powershell
.\scripts\dev.cmd bun run bard:audit-batch -- --source bmp --max-downloads 100
.\scripts\dev.cmd bun run bard:verify
.\scripts\dev.cmd bun run album:audit
```

Repeat until BMP pending reaches zero, then process FFXIV-Bard:

```powershell
.\scripts\dev.cmd bun run bard:audit-batch -- --source ffxivbard --max-downloads 100
.\scripts\dev.cmd bun run bard:verify
.\scripts\dev.cmd bun run album:audit
```

Each batch stores a local report in `.local-bard-source-ledger.json` with accepted, rejected, failed, scanned, and verification counts. Stop after any failed verification and clean or quarantine only the files from the failed batch before continuing.

## Verification

After each batch:

```powershell
.\scripts\dev.cmd bun run bard:verify
.\scripts\dev.cmd bun run album:audit
```

`album:audit` may warn that local MIDI files are missing from `album-manifest.json`; that is expected for private local-only songs. Exact duplicates and unallowlisted normalized duplicates should still be treated as cleanup work.

If verification finds legacy local files with impossible duration, extreme pitch range, or no playable notes, move them out of the active album:

```powershell
.\scripts\dev.cmd bun run bard:verify -- --quarantine-invalid
```

Quarantined files are moved to `src-tauri/target/release/album-quarantine`, which is also ignored by Git.

## Title Cleanup

The app displays library names from the MIDI filename stem. After bulk mining, use the title cleanup workflow to remove source prefixes, ensemble names, arrangers, and source IDs from safe rows:

```powershell
.\scripts\dev.cmd bun run bard:title-audit
```

The audit writes ignored local files beside the runtime album:

- `.local-title-cleanup-report.json`: full machine-readable report.
- `.local-title-cleanup-plan.csv`: review sheet with current file, proposed file, status, reason, source key, artist, title, source work, arranger, SHA256, and notes.

Rows marked `rename-ready` have clear local ledger metadata and target `Artist - Song.mid`. Rows marked `review-needed` or `collision-review` are intentionally not renamed automatically.

After reviewing the audit counts, apply only the safe rows:

```powershell
.\scripts\dev.cmd bun run bard:title-apply
.\scripts\dev.cmd bun run bard:verify
.\scripts\dev.cmd bun run album:audit
```

The apply step creates `.local-title-cleanup-backup-<timestamp>.json`, uses a two-phase rename to avoid Windows filename collisions, updates ignored local ledgers, and clears the app metadata cache so the library reloads clean names.

## Review-Name Suggestions

Rows that remain `review-needed` or `collision-review` can be turned into a CSV-first review queue:

```powershell
.\scripts\dev.cmd bun run bard:title-review-suggest
```

The suggestion pass writes ignored local files beside the runtime album:

- `.local-title-review-suggestions.csv`: editable review sheet.
- `.local-title-review-suggestions.json`: machine-readable copy.
- `.local-title-review-web-cache.json`: cached MusicBrainz/Wikidata responses.

Each CSV row includes `decision`, `currentFile`, `recommendedFile`, `finalArtist`, `finalTitle`, `finalFile`, confidence, evidence, and notes. Suggestions are recommendations only; no file is renamed unless `decision` is set to `approve` or `edit`.

Apply one reviewed batch at a time:

```powershell
.\scripts\dev.cmd bun run bard:title-review-apply -- --batch 1
.\scripts\dev.cmd bun run bard:title-audit
.\scripts\dev.cmd bun run bard:verify
.\scripts\dev.cmd bun run album:audit
```

The apply command refuses exact filename collisions and album-audit normalized-title collisions, writes `.local-title-review-backup-<timestamp>.json`, updates ignored local ledgers, and clears the app metadata cache.

Do not use app playback for bulk testing until the app has a true audio-only preview mode, because current playback can send game keypresses.
