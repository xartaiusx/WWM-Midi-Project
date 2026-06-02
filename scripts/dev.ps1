param(
  [Parameter(Position = 0, ValueFromRemainingArguments = $true)]
  [string[]] $Command
)

. "$PSScriptRoot\dev-env.ps1"

if ($Command.Count -eq 0) {
  git --version
  node --version
  npm --version
  cargo --version
  Write-Host ''
  Write-Host 'Usage: .\scripts\dev.cmd <command> [args...]'
  Write-Host 'Examples:'
  Write-Host '  .\scripts\dev.cmd npm test'
  Write-Host '  .\scripts\dev.cmd npm run build'
  Write-Host '  .\scripts\dev.cmd npm run tauri-dev'
  exit 0
}

$exe = $Command[0]
$argsForExe = @()
if ($Command.Count -gt 1) {
  $argsForExe = $Command[1..($Command.Count - 1)]
}

& $exe @argsForExe
exit $LASTEXITCODE
