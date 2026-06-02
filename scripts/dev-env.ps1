$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$DevTools = Join-Path $RepoRoot '.dev-tools'

$env:RUSTUP_HOME = Join-Path $DevTools 'rustup'
$env:CARGO_HOME = Join-Path $DevTools 'cargo'

$gitPaths = @(
  (Join-Path $env:ProgramFiles 'Git\cmd'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd'),
  (Join-Path $DevTools 'git\cmd')
)

$localPaths = @($gitPaths | Where-Object { Test-Path $_ })
$localPaths += @(
  (Join-Path $DevTools 'node'),
  (Join-Path $env:CARGO_HOME 'bin')
) | Where-Object { Test-Path $_ }

$env:PATH = ($localPaths + $env:PATH) -join ';'
