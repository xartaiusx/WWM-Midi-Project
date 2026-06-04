param(
    [switch]$NoAdmin,
    [switch]$Redact,
    [switch]$VerboseOutput,
    [switch]$ScanDevices,
    [string]$PythonPath = ''
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Collector = Join-Path $ScriptDir 'collect-windows.ps1'
$Analyzer = Join-Path $ScriptDir 'analyze-windows.py'
$LatestFile = Join-Path $ScriptDir 'latest-run.txt'

function Find-PythonCommand {
    $candidates = New-Object System.Collections.Generic.List[object]

    if (-not [string]::IsNullOrWhiteSpace($PythonPath)) {
        $candidates.Add([pscustomobject]@{ Exe = $PythonPath; Args = @() }) | Out-Null
    }
    if (-not [string]::IsNullOrWhiteSpace($env:PYTHON)) {
        $candidates.Add([pscustomobject]@{ Exe = $env:PYTHON; Args = @() }) | Out-Null
    }
    if (-not [string]::IsNullOrWhiteSpace($env:CODEX_PYTHON)) {
        $candidates.Add([pscustomobject]@{ Exe = $env:CODEX_PYTHON; Args = @() }) | Out-Null
    }

    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        $candidates.Add([pscustomobject]@{ Exe = $python.Source; Args = @() }) | Out-Null
    }

    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        $candidates.Add([pscustomobject]@{ Exe = $py.Source; Args = @('-3') }) | Out-Null
    }

    $codexPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
    if (Test-Path -LiteralPath $codexPython) {
        $candidates.Add([pscustomobject]@{ Exe = $codexPython; Args = @() }) | Out-Null
    }

    foreach ($candidate in $candidates) {
        $exe = [string]$candidate.Exe
        if (-not (Test-Path -LiteralPath $exe)) {
            continue
        }
        $prefixArgs = @($candidate.Args)
        try {
            & $exe @prefixArgs -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' *> $null
            if ($LASTEXITCODE -eq 0) {
                return $candidate
            }
        }
        catch {
        }
    }

    return $null
}

$collectorArgs = @()
if ($NoAdmin) { $collectorArgs += '-NoAdmin' }
if ($Redact) { $collectorArgs += '-Redact' }
if ($VerboseOutput) { $collectorArgs += '-VerboseOutput' }
if ($ScanDevices) { $collectorArgs += '-ScanDevices' }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Collector @collectorArgs

if (-not (Test-Path -LiteralPath $LatestFile)) {
    throw "Could not find latest run file: $LatestFile"
}

$RunDir = (Get-Content -LiteralPath $LatestFile | Select-Object -Last 1).Trim()
if (-not (Test-Path -LiteralPath $RunDir)) {
    throw "Collector did not create expected run directory: $RunDir"
}

$pythonCommand = Find-PythonCommand
if (-not $pythonCommand) {
    throw "Python 3 is required to analyze artifacts. Collection path: $RunDir"
}

$exe = [string]$pythonCommand.Exe
$prefixArgs = @($pythonCommand.Args)

$analyzerArgs = @($Analyzer, $RunDir, '--redact')
if ($VerboseOutput) {
    $analyzerArgs += '--verbose'
}

& $exe @prefixArgs @analyzerArgs
