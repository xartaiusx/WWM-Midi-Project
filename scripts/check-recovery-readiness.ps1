[CmdletBinding()]
param(
    [switch]$AllowDirty,
    [switch]$SkipFetch
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
Set-Location $RepoRoot

$Failures = New-Object System.Collections.Generic.List[string]

function Write-Ok {
    param([string]$Message)
    Write-Host "[ok] $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "[warn] $Message" -ForegroundColor Yellow
}

function Write-Fail {
    param([string]$Message)
    $Failures.Add($Message) | Out-Null
    Write-Host "[fail] $Message" -ForegroundColor Red
}

function Invoke-Git {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & git @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed: $output"
    }
    return $output
}

Write-Host "WWM Midi Project recovery readiness"
Write-Host "Repository: $RepoRoot"

try {
    $insideWorkTree = (Invoke-Git rev-parse --is-inside-work-tree).Trim()
    if ($insideWorkTree -eq "true") {
        Write-Ok "inside a Git working tree"
    } else {
        Write-Fail "not inside a Git working tree"
    }
} catch {
    Write-Fail $_.Exception.Message
}

$branch = ""
try {
    $branch = (Invoke-Git branch --show-current).Trim()
    if ($branch -eq "main") {
        Write-Ok "on branch main"
    } elseif ($branch) {
        Write-Fail "expected branch main, found $branch"
    } else {
        Write-Fail "detached HEAD or no current branch"
    }
} catch {
    Write-Fail $_.Exception.Message
}

try {
    $originUrl = (Invoke-Git remote get-url origin).Trim()
    if ($originUrl -match "WWM-Midi-Project(\.git)?$") {
        Write-Ok "origin remote points at WWM-Midi-Project"
    } else {
        Write-Fail "origin remote does not look like WWM-Midi-Project: $originUrl"
    }
} catch {
    Write-Fail $_.Exception.Message
}

try {
    $upstream = (Invoke-Git rev-parse --abbrev-ref --symbolic-full-name "@{u}").Trim()
    if ($upstream) {
        Write-Ok "branch tracks $upstream"
    } else {
        Write-Fail "branch has no upstream tracking ref"
    }
} catch {
    Write-Fail "branch has no upstream tracking ref"
}

if (-not $SkipFetch) {
    try {
        Invoke-Git fetch --prune origin | Out-Null
        Write-Ok "fetched origin"
    } catch {
        Write-Fail $_.Exception.Message
    }
}

try {
    $countsText = (Invoke-Git rev-list --left-right --count "HEAD...@{u}").Trim()
    $counts = $countsText -split "\s+"
    $ahead = [int]$counts[0]
    $behind = [int]$counts[1]
    if ($ahead -eq 0 -and $behind -eq 0) {
        Write-Ok "local HEAD matches upstream"
    } else {
        Write-Fail "local and upstream differ: ahead=$ahead behind=$behind"
    }
} catch {
    Write-Fail $_.Exception.Message
}

try {
    $status = @(Invoke-Git status --porcelain)
    if ($status.Count -eq 0) {
        Write-Ok "working tree is clean"
    } elseif ($AllowDirty) {
        Write-Warn "working tree has local edits; allowed by -AllowDirty"
        $status | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Fail "working tree has uncommitted changes"
        $status | ForEach-Object { Write-Host "  $_" }
    }
} catch {
    Write-Fail $_.Exception.Message
}

$requiredPaths = @(
    "README.md",
    "AGENTS.md",
    "LICENSE",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "CHANGELOG.md",
    "package.json",
    "bun.lock",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
    "album-manifest.json",
    "scripts/dev.cmd",
    "scripts/check-recovery-readiness.ps1",
    "docs/recovery.md",
    ".github/workflows/ci.yml",
    ".github/workflows/build.yml"
)

$missingRequiredPaths = @(
    $requiredPaths | Where-Object {
        -not (Test-Path -LiteralPath (Join-Path $RepoRoot $_))
    }
)

if ($missingRequiredPaths.Count -eq 0) {
    Write-Ok "required source, config, docs, and workflow files are present"
} else {
    Write-Fail "required files are missing"
    $missingRequiredPaths | ForEach-Object { Write-Host "  $_" }
}

try {
    $trackedAlbumFiles = @(Invoke-Git ls-files -- "Album")
    if ($trackedAlbumFiles.Count -eq 0) {
        Write-Ok "local Album folder has no tracked files"
    } else {
        Write-Fail "local Album folder contains tracked files"
        $trackedAlbumFiles | ForEach-Object { Write-Host "  $_" }
    }

    Invoke-Git check-ignore -q -- "Album/example.mid" | Out-Null
    Write-Ok "local Album folder is covered by repository ignore rules"
} catch {
    Write-Fail "local Album folder is not safely ignored"
}

try {
    $ignored = @(Invoke-Git status --ignored --short)
    $ignoredEntries = @(
        $ignored |
            Where-Object { $_ -like "!! *" } |
            ForEach-Object { $_.Substring(3) } |
            Sort-Object -Unique
    )

    if ($ignoredEntries.Count -gt 0) {
        Write-Host "Ignored local-only paths:"
        $ignoredEntries | ForEach-Object { Write-Host "  $_" }
    } else {
        Write-Host "Ignored local-only paths: none"
    }
} catch {
    Write-Warn "could not list ignored local-only paths: $($_.Exception.Message)"
}

$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
if ($ghCommand) {
    try {
        $originUrl = (Invoke-Git remote get-url origin).Trim()
        $repoSlug = $null
        if ($originUrl -match "github\.com[:/](.+?)(\.git)?$") {
            $repoSlug = $matches[1]
        }

        if ($repoSlug) {
            $runJson = & gh run list --repo $repoSlug --branch main --limit 1 --json databaseId,name,status,conclusion,headSha 2>$null
            if ($LASTEXITCODE -eq 0 -and $runJson) {
                $latestRun = @($runJson | ConvertFrom-Json)[0]
                $headSha = (Invoke-Git rev-parse HEAD).Trim()
                if ($latestRun.headSha -ne $headSha) {
                    Write-Warn "latest GitHub Actions run is for a different commit"
                } elseif ($latestRun.status -eq "completed" -and $latestRun.conclusion -eq "success") {
                    Write-Ok "latest GitHub Actions run succeeded for this commit"
                } else {
                    Write-Warn "latest GitHub Actions run for this commit is $($latestRun.status)/$($latestRun.conclusion)"
                }
            } else {
                Write-Warn "GitHub CLI is installed, but no workflow run was returned"
            }
        } else {
            Write-Warn "could not infer GitHub repository from origin URL"
        }
    } catch {
        Write-Warn "could not check GitHub Actions status: $($_.Exception.Message)"
    }
} else {
    Write-Warn "GitHub CLI is not installed or not on PATH; skipped remote workflow check"
}

if ($Failures.Count -gt 0) {
    Write-Host ""
    Write-Host "Recovery readiness failed:" -ForegroundColor Red
    $Failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    exit 1
}

Write-Host ""
Write-Host "Recovery readiness passed." -ForegroundColor Green
exit 0
