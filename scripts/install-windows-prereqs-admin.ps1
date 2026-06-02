$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DevTools = Join-Path $RepoRoot '.dev-tools'
$BuildToolsPath = Join-Path $DevTools 'vs-buildtools'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Run this script from an elevated PowerShell session so Visual Studio Build Tools can install the MSVC linker.'
}

$override = "--quiet --wait --norestart --nocache --installPath `"$BuildToolsPath`" --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --silent --disable-interactivity --accept-package-agreements --accept-source-agreements --override $override
winget install --id Microsoft.EdgeWebView2Runtime -e --source winget --silent --disable-interactivity --accept-package-agreements --accept-source-agreements
