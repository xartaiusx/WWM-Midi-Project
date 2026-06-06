# Security Policy

## Supported Versions

Security fixes are handled for the current `main` branch and the latest tagged release.

## Reporting a Vulnerability

Use GitHub private vulnerability reporting when it is available for this repository. If private reporting is not available, open a public issue with only a non-sensitive summary and state that details are withheld until a private channel is available.

Please include:

- Affected version or commit.
- Operating system and whether the app was running elevated.
- A short reproduction outline.
- Expected impact.

Do not include private MIDI files, local recordings, account details, tokens, machine-specific diagnostics, or other sensitive files in public reports.

## Security Boundaries

- Tauri capabilities and CSP are treated as security boundaries.
- Release workflows should keep GitHub token permissions least-privilege.
- Runtime album files are local user content unless explicitly approved through the album audit workflow.
- The app may require Administrator rights for keyboard input to reach elevated windows; packaging must not hide that requirement.
