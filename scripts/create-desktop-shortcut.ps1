param(
  [string]$ShortcutName = "WWM MIDI Project"
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetPath = Join-Path $repoRoot "src-tauri\target\release\wwm-midi-project.exe"
$workingDirectory = Split-Path -Parent $targetPath
$iconPath = Join-Path $repoRoot "src-tauri\icons\icon.ico"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$ShortcutName.lnk"

if (-not (Test-Path -LiteralPath $workingDirectory)) {
  New-Item -ItemType Directory -Path $workingDirectory -Force | Out-Null
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $workingDirectory
$shortcut.IconLocation = if (Test-Path -LiteralPath $iconPath) { "$iconPath,0" } else { "$targetPath,0" }
$shortcut.Description = "Launch the latest WWM MIDI Project release build."
$shortcut.Save()

if (-not (Test-Path -LiteralPath $targetPath)) {
  Write-Warning "Shortcut created, but the release executable does not exist yet. Run scripts\dev.cmd bun run tauri-build before launching it."
}

[pscustomobject]@{
  Shortcut = $shortcutPath
  Target = $targetPath
  Icon = $shortcut.IconLocation
}
