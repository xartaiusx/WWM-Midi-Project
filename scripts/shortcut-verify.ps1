param(
  [string]$ShortcutName = "WWM MIDI Project",
  [string]$ExpectedVersion = ""
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targetPath = Join-Path $repoRoot "src-tauri\target\release\wwm-overlay.exe"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$ShortcutName.lnk"
$iconPath = Join-Path $repoRoot "src-tauri\icons\icon.ico"

$issues = New-Object System.Collections.Generic.List[string]

if (-not (Test-Path -LiteralPath $targetPath)) {
  $issues.Add("Release executable is missing: $targetPath") | Out-Null
}

if (-not (Test-Path -LiteralPath $shortcutPath)) {
  $issues.Add("Desktop shortcut is missing: $shortcutPath") | Out-Null
}
else {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $actualTarget = [System.IO.Path]::GetFullPath($shortcut.TargetPath)
  $expectedTarget = [System.IO.Path]::GetFullPath($targetPath)
  if ($actualTarget -ne $expectedTarget) {
    $issues.Add("Shortcut target mismatch. Expected '$expectedTarget' but found '$actualTarget'.") | Out-Null
  }
  if ($shortcut.WorkingDirectory -ne (Split-Path -Parent $targetPath)) {
    $issues.Add("Shortcut working directory mismatch: $($shortcut.WorkingDirectory)") | Out-Null
  }
}

if ((Test-Path -LiteralPath $targetPath) -and $ExpectedVersion) {
  $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($targetPath)
  $actualVersion = $versionInfo.ProductVersion
  if ($actualVersion -and $actualVersion -notlike "$ExpectedVersion*") {
    $issues.Add("Executable version mismatch. Expected '$ExpectedVersion' but found '$actualVersion'.") | Out-Null
  }
}

if (Test-Path -LiteralPath $iconPath) {
  Write-Host "Icon found: $iconPath"
}
else {
  Write-Warning "Icon file is missing; shortcut can still launch but may use the executable icon."
}

if ($issues.Count -gt 0) {
  foreach ($issue in $issues) {
    Write-Error $issue
  }
  exit 1
}

[pscustomobject]@{
  Shortcut = $shortcutPath
  Target = $targetPath
  Exists = $true
}
