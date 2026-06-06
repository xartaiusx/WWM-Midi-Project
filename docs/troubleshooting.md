# Troubleshooting

## Commands Cannot Find Bun, Rust, or Build Tools

Run commands through:

```powershell
.\scripts\dev.cmd <command>
```

The helper resolves local tool paths, Bun, Cargo, Git, and Visual Studio build-tool environment when available.

## Tauri Build Fails at C++ Link Step

Install Visual Studio Build Tools with the Desktop development with C++ workload. WebView2 Runtime is also required for running the Windows desktop app.

After installation, open a new shell and run:

```powershell
.\scripts\dev.cmd bun run tauri-build
```

## Shortcut Points at an Old Build

Refresh and verify the desktop shortcut:

```powershell
.\scripts\create-desktop-shortcut.cmd
.\scripts\dev.cmd bun run shortcut:verify
```

## Audio-to-MIDI Tools Are Missing

Run:

```powershell
.\scripts\setup-audio-midi.cmd
.\scripts\audio-to-midi.cmd status
```

## Online Library Sharing Cannot Connect

Packaged builds only allow documented discovery and peer endpoints through the Tauri CSP. If a custom discovery server is needed, add that trusted origin to `connect-src` before building a release.

## Album Audit Fails

Run:

```powershell
.\scripts\dev.cmd bun run album:audit
```

Then update `album-manifest.json` with the missing source, license/status, duplicate allowlist, or hash correction. Do not commit private or unsourced MIDI files to work around an audit failure.
