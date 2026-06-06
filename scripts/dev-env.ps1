$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DevTools = Join-Path $RepoRoot '.dev-tools'

$LocalRustupHome = Join-Path $DevTools 'rustup'
$LocalCargoHome = Join-Path $DevTools 'cargo'

if (Test-Path $LocalRustupHome) {
  $env:RUSTUP_HOME = $LocalRustupHome
}

if (Test-Path $LocalCargoHome) {
  $env:CARGO_HOME = $LocalCargoHome
}

$gitPaths = @(
  (Join-Path $env:ProgramFiles 'Git\cmd'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'),
  (Join-Path $DevTools 'git\cmd')
)
$bunPaths = @(
  (Join-Path $env:USERPROFILE '.bun\bin'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64')
)

$localPaths = @($gitPaths | Where-Object { Test-Path $_ })
$localPaths += @($bunPaths | Where-Object { Test-Path $_ })
$localPaths += @(
  (Join-Path $DevTools 'node'),
  ($(if ($env:CARGO_HOME) { Join-Path $env:CARGO_HOME 'bin' }))
) | Where-Object { Test-Path $_ }

$env:PATH = ($localPaths + $env:PATH) -join ';'
