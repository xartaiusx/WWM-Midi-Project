# Album Audit Policy

`album-manifest.json` is the tracked contract for any MIDI files that are safe to publish with the repository or release process.

## Runtime Album Folder

The default runtime album folder is local-only:

```text
src-tauri/target/release/album
```

That folder is ignored by Git. It can contain private test songs, generated files, or local runtime content, but those files are not publishable until their source and status are recorded in the manifest.

## Manifest Statuses

Use one of these statuses:

- `approved-sourceable`: source and license/status are clear enough to publish.
- `needs-user-source`: the file may be useful locally, but the source still needs to be recorded.
- `needs-license`: the source is known, but the license/status is not clear enough.
- `rejected`: do not publish or ship this file.

Approved entries need either `sourceUrl` or `sourceNote`.

## Duplicate Rules

`bun run album:audit` fails exact duplicate hashes unless the hash is listed in `allowExactDuplicateHashes`.

The audit also normalizes song titles and fails likely duplicate titles unless the normalized duplicate is listed in `allowNormalizedDuplicates` with a reason. Pattern-based duplicate allowlists are allowed when multiple differently named files intentionally represent the same song family.

## Validation

Run:

```powershell
.\scripts\dev.cmd bun run album:audit
```

The manifest schema is tracked at `docs/album-manifest.schema.json`.
