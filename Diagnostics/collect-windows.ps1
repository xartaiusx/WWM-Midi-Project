param(
    [switch]$NoAdmin,
    [switch]$Redact,
    [switch]$VerboseOutput,
    [switch]$ScanDevices
)

$ErrorActionPreference = 'Continue'
$ScriptVersion = '2026.06.03'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunsDir = Join-Path $ScriptDir 'runs'
$HostSafe = ($env:COMPUTERNAME -replace '[^A-Za-z0-9._-]', '_')
if ([string]::IsNullOrWhiteSpace($HostSafe)) { $HostSafe = 'windows-host' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$RunDir = Join-Path $RunsDir "$Stamp-$HostSafe"
$RawDir = Join-Path $RunDir 'raw'
$CommandsJsonl = Join-Path $RunDir 'commands.jsonl'
$SummaryJson = Join-Path $RunDir 'summary.json'
$LatestFile = Join-Path $ScriptDir 'latest-run.txt'

New-Item -ItemType Directory -Force -Path $RawDir | Out-Null
Set-Content -LiteralPath $CommandsJsonl -Value '' -Encoding UTF8 -NoNewline
[System.IO.File]::WriteAllText($LatestFile, "$RunDir`n", [System.Text.UTF8Encoding]::new($false))

$CommandCounter = 0
$MissingEvidence = New-Object System.Collections.Generic.List[string]

function Write-Log {
    param([string]$Message)
    Write-Host "[system-diagnostics] $Message"
}

function Write-VerboseLog {
    param([string]$Message)
    if ($VerboseOutput) {
        Write-Log $Message
    }
}

function Test-IsAdmin {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Get-SafeLabel {
    param([string]$Label)
    $safe = ($Label.ToLowerInvariant() -replace '[^a-z0-9._-]', '_') -replace '_+', '_'
    $safe = $safe.Trim('_')
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = 'command' }
    return $safe
}

function Add-CommandMeta {
    param(
        [string]$Label,
        [string]$Status,
        [Nullable[int]]$ExitCode,
        [datetime]$StartedAt,
        [datetime]$EndedAt,
        [string]$Stdout,
        [string]$Stderr,
        [string]$Command,
        [string]$SkipReason
    )

    $obj = [ordered]@{
        label = $Label
        status = $Status
        exit_code = $ExitCode
        started_at = $StartedAt.ToUniversalTime().ToString('o')
        ended_at = $EndedAt.ToUniversalTime().ToString('o')
        stdout = $Stdout
        stderr = $Stderr
        timeout_s = $null
        timed_out = $false
        command = $Command
        skip_reason = $SkipReason
    }
    ($obj | ConvertTo-Json -Compress -Depth 8) | Add-Content -LiteralPath $CommandsJsonl -Encoding UTF8
}

function Invoke-Collect {
    param(
        [string]$Label,
        [scriptblock]$Script,
        [string]$CommandText = '',
        [switch]$RequiresAdmin
    )

    $script:CommandCounter += 1
    $base = '{0:d3}_{1}' -f $script:CommandCounter, (Get-SafeLabel $Label)
    $outPath = Join-Path $RawDir "$base.out"
    $errPath = Join-Path $RawDir "$base.err"
    $started = Get-Date

    if ($RequiresAdmin -and ($NoAdmin -or -not $script:IsAdmin)) {
        Set-Content -LiteralPath $outPath -Value '' -Encoding UTF8
        Set-Content -LiteralPath $errPath -Value 'admin unavailable, disabled, or required' -Encoding UTF8
        $ended = Get-Date
        $MissingEvidence.Add("${Label}: admin unavailable, disabled, or required") | Out-Null
        Add-CommandMeta -Label $Label -Status 'skipped' -ExitCode $null -StartedAt $started -EndedAt $ended -Stdout $outPath -Stderr $errPath -Command $CommandText -SkipReason 'admin unavailable, disabled, or required'
        Write-VerboseLog "skipped $Label"
        return
    }

    Write-VerboseLog "running $Label"
    $exitCode = 0
    try {
        & $Script > $outPath 2> $errPath
        if (-not $?) { $exitCode = 1 }
    }
    catch {
        $exitCode = 1
        $_ | Out-String | Set-Content -LiteralPath $errPath -Encoding UTF8
        if (-not (Test-Path -LiteralPath $outPath)) {
            Set-Content -LiteralPath $outPath -Value '' -Encoding UTF8
        }
    }
    if ((Test-Path -LiteralPath $errPath) -and ((Get-Item -LiteralPath $errPath).Length -gt 0)) {
        $exitCode = 1
    }
    $ended = Get-Date
    if ($exitCode -ne 0) {
        $MissingEvidence.Add("${Label}: exit code $exitCode") | Out-Null
    }
    Add-CommandMeta -Label $Label -Status 'completed' -ExitCode $exitCode -StartedAt $started -EndedAt $ended -Stdout $outPath -Stderr $errPath -Command $CommandText -SkipReason ''
}

function Invoke-IfAvailable {
    param(
        [string]$Label,
        [string]$CommandName,
        [scriptblock]$Script,
        [string]$CommandText = '',
        [switch]$RequiresAdmin
    )
    if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
        Invoke-Collect -Label $Label -Script $Script -CommandText $CommandText -RequiresAdmin:$RequiresAdmin
    }
    else {
        $script:CommandCounter += 1
        $base = '{0:d3}_{1}' -f $script:CommandCounter, (Get-SafeLabel $Label)
        $outPath = Join-Path $RawDir "$base.out"
        $errPath = Join-Path $RawDir "$base.err"
        Set-Content -LiteralPath $outPath -Value '' -Encoding UTF8
        Set-Content -LiteralPath $errPath -Value "tool missing: $CommandName" -Encoding UTF8
        $now = Get-Date
        $MissingEvidence.Add("${Label}: tool missing: $CommandName") | Out-Null
        Add-CommandMeta -Label $Label -Status 'skipped' -ExitCode $null -StartedAt $now -EndedAt $now -Stdout $outPath -Stderr $errPath -Command $CommandText -SkipReason "tool missing: $CommandName"
    }
}

function ConvertTo-DiagnosticJson {
    param(
        [Parameter(ValueFromPipeline = $true)]
        $InputObject
    )

    begin {
        $items = New-Object System.Collections.ArrayList
    }

    process {
        if ($null -ne $InputObject) {
            $items.Add($InputObject) | Out-Null
        }
    }

    end {
        if ($items.Count -eq 0) {
            @() | ConvertTo-Json -Depth 12
        }
        elseif ($items.Count -eq 1) {
            $items[0] | ConvertTo-Json -Depth 12
        }
        else {
            $items.ToArray() | ConvertTo-Json -Depth 12
        }
    }
}

function Collect-StorageSnapshot {
    param([string]$Prefix)

    Invoke-IfAvailable "${Prefix}get_disk_text" 'Get-Disk' {
        Get-Disk | Sort-Object Number | Format-List *
    } 'Get-Disk | Format-List *'

    Invoke-IfAvailable "${Prefix}get_disk_json" 'Get-Disk' {
        Get-Disk |
            Sort-Object Number |
            Select-Object Number,FriendlyName,SerialNumber,UniqueId,Model,Manufacturer,BusType,MediaType,PartitionStyle,OperationalStatus,HealthStatus,Size,IsBoot,IsSystem,IsOffline,IsReadOnly,Path,Location |
            ConvertTo-DiagnosticJson
    } 'Get-Disk | Select ... | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}get_physicaldisk_text" 'Get-PhysicalDisk' {
        Get-PhysicalDisk | Sort-Object DeviceId | Format-List *
    } 'Get-PhysicalDisk | Format-List *'

    Invoke-IfAvailable "${Prefix}get_physicaldisk_json" 'Get-PhysicalDisk' {
        Get-PhysicalDisk |
            Sort-Object DeviceId |
            Select-Object DeviceId,FriendlyName,SerialNumber,UniqueId,Manufacturer,Model,BusType,MediaType,CanPool,CannotPoolReason,OperationalStatus,HealthStatus,Usage,Size,PhysicalLocation |
            ConvertTo-DiagnosticJson
    } 'Get-PhysicalDisk | Select ... | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}boot_disk_json" 'Get-Partition' {
        $driveLetter = ($env:SystemDrive -replace ':', '')
        $partition = Get-Partition -DriveLetter $driveLetter -ErrorAction Stop
        $disk = $partition | Get-Disk -ErrorAction Stop
        [pscustomobject]@{
            SystemDrive = $env:SystemDrive
            DriveLetter = $driveLetter
            DiskNumber = $disk.Number
            FriendlyName = $disk.FriendlyName
            SerialNumber = $disk.SerialNumber
            UniqueId = $disk.UniqueId
            BusType = $disk.BusType
            HealthStatus = $disk.HealthStatus
            OperationalStatus = $disk.OperationalStatus
            Size = $disk.Size
            IsBoot = $disk.IsBoot
            IsSystem = $disk.IsSystem
        } | ConvertTo-DiagnosticJson
    } 'Get-Partition -DriveLetter system | Get-Disk | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}partitions_json" 'Get-Partition' {
        Get-Partition | Sort-Object DiskNumber,PartitionNumber | ConvertTo-DiagnosticJson
    } 'Get-Partition | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}volumes_json" 'Get-Volume' {
        Get-Volume | Sort-Object DriveLetter,FileSystemLabel | ConvertTo-DiagnosticJson
    } 'Get-Volume | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}win32_diskdrive_text" 'Get-CimInstance' {
        Get-CimInstance Win32_DiskDrive | Sort-Object Index | Format-List *
    } 'Get-CimInstance Win32_DiskDrive | Format-List *'

    Invoke-IfAvailable "${Prefix}win32_diskdrive_json" 'Get-CimInstance' {
        Get-CimInstance Win32_DiskDrive |
            Sort-Object Index |
            Select-Object Index,DeviceID,Model,SerialNumber,FirmwareRevision,InterfaceType,MediaType,Size,Status,PNPDeviceID,Partitions,SCSIBus,SCSIPort,SCSITargetId,SCSILogicalUnit |
            ConvertTo-DiagnosticJson
    } 'Get-CimInstance Win32_DiskDrive | Select ... | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}storage_reliability_json" 'Get-StorageReliabilityCounter' {
        Get-PhysicalDisk | Get-StorageReliabilityCounter | ConvertTo-DiagnosticJson
    } 'Get-PhysicalDisk | Get-StorageReliabilityCounter | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}pnp_storage_text" 'Get-PnpDevice' {
        Get-PnpDevice |
            Where-Object { $_.FriendlyName -match 'NVMe|NVM|PCI Express|PCIe|Storage|Disk|Controller|Standard NVM' -or $_.InstanceId -match 'NVME|PCI|SCSI|STOR|DISK' -or $_.Class -match 'DiskDrive|SCSIAdapter|StorageController|System' } |
            Sort-Object Class,FriendlyName |
            Format-Table -AutoSize
    } 'Get-PnpDevice filtered | Format-Table'

    Invoke-IfAvailable "${Prefix}pnp_storage_json" 'Get-PnpDevice' {
        Get-PnpDevice |
            Where-Object { $_.FriendlyName -match 'NVMe|NVM|PCI Express|PCIe|Storage|Disk|Controller|Standard NVM' -or $_.InstanceId -match 'NVME|PCI|SCSI|STOR|DISK' -or $_.Class -match 'DiskDrive|SCSIAdapter|StorageController|System' } |
            Sort-Object Class,FriendlyName |
            Select-Object Class,FriendlyName,InstanceId,Status,Problem,Manufacturer,Present,Service |
            ConvertTo-DiagnosticJson
    } 'Get-PnpDevice filtered | ConvertTo-Json'

    Invoke-IfAvailable "${Prefix}win32_pnpentity_storage_json" 'Get-CimInstance' {
        Get-CimInstance Win32_PnPEntity |
            Where-Object { $_.Name -match 'NVMe|NVM|PCI Express|PCIe|Storage|Disk|Controller|Standard NVM' -or $_.DeviceID -match 'NVME|PCI|SCSI|STOR|DISK' -or $_.PNPClass -match 'DiskDrive|SCSIAdapter|StorageController|System' } |
            Sort-Object PNPClass,Name |
            Select-Object Name,DeviceID,PNPClass,Status,ConfigManagerErrorCode,Manufacturer,Service,Present |
            ConvertTo-DiagnosticJson
    } 'Get-CimInstance Win32_PnPEntity filtered | ConvertTo-Json'
}

function Collect-EventSnapshot {
    param([string]$Prefix)

    Invoke-IfAvailable "${Prefix}whea_events_json" 'Get-WinEvent' {
        Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-WHEA-Logger'; StartTime = (Get-Date).AddDays(-30) } -MaxEvents 300 |
            Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message |
            ConvertTo-DiagnosticJson
    } 'Get-WinEvent WHEA last 30 days'

    Invoke-IfAvailable "${Prefix}system_storage_events_json" 'Get-WinEvent' {
        Get-WinEvent -LogName System -MaxEvents 2000 |
            Where-Object {
                $_.ProviderName -match 'disk|stornvme|storahci|storport|Kernel-PnP|WHEA|partmgr|volmgr' -or
                $_.Message -match 'NVMe|NVM|PCI|PCIe|PCI Express|WHEA|disk|storage|controller|reset|timeout|error|fatal|corrected|uncorrected|surprise|link|bus'
            } |
            Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message |
            ConvertTo-DiagnosticJson
    } 'Get-WinEvent System storage filtered'

    Invoke-IfAvailable "${Prefix}diagnostics_performance_boot_json" 'Get-WinEvent' {
        Get-WinEvent -LogName 'Microsoft-Windows-Diagnostics-Performance/Operational' -MaxEvents 300 |
            Where-Object { $_.Id -in 100,101,102,103,104,105,106,107,108,109,110 } |
            Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,Message |
            ConvertTo-DiagnosticJson
    } 'Get-WinEvent Diagnostics-Performance boot events'
}

function Collect-PowerThermal {
    param([string]$Prefix)

    Invoke-IfAvailable "${Prefix}thermal_zone_json" 'Get-CimInstance' {
        Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature |
            Select-Object InstanceName,CurrentTemperature,CriticalTripPoint,PassiveTripPoint |
            ConvertTo-DiagnosticJson
    } 'Get-CimInstance root/wmi MSAcpi_ThermalZoneTemperature'

    Invoke-IfAvailable "${Prefix}temperature_probe_json" 'Get-CimInstance' {
        Get-CimInstance Win32_TemperatureProbe | ConvertTo-DiagnosticJson
    } 'Get-CimInstance Win32_TemperatureProbe'

    Invoke-IfAvailable "${Prefix}powercfg_batteryreport" 'powercfg.exe' {
        $report = Join-Path $RawDir "${Prefix}battery-report.html"
        & powercfg.exe /batteryreport /output $report /duration 7
        if (Test-Path -LiteralPath $report) {
            "battery report: $report"
        }
    } 'powercfg /batteryreport /output raw\battery-report.html /duration 7'

    Invoke-IfAvailable "${Prefix}powercfg_available_sleep_states" 'powercfg.exe' {
        & powercfg.exe /a
    } 'powercfg /a'
}

$script:IsAdmin = Test-IsAdmin
Write-Log "Creating diagnostic run at $RunDir"
if ($NoAdmin) {
    Write-Log "NoAdmin requested; admin-only evidence will be skipped."
}
elseif (-not $script:IsAdmin) {
    Write-Log "PowerShell is not elevated; collector will continue and record any permission gaps."
}

Invoke-Collect 'initial_date' { Get-Date | Format-List * } 'Get-Date'
Invoke-Collect 'initial_computer_info' { Get-ComputerInfo | Format-List * } 'Get-ComputerInfo'
Invoke-Collect 'initial_computer_info_json' { Get-ComputerInfo | ConvertTo-DiagnosticJson } 'Get-ComputerInfo | ConvertTo-Json'
Invoke-IfAvailable 'initial_systeminfo' 'systeminfo.exe' { & systeminfo.exe } 'systeminfo'
Invoke-IfAvailable 'initial_driverquery_storage' 'driverquery.exe' { & driverquery.exe /v /fo csv | Select-String -Pattern 'disk|stor|nvme|nvm|pci' } 'driverquery /v /fo csv filtered'

Collect-StorageSnapshot 'initial_'
Collect-EventSnapshot 'initial_'
Collect-PowerThermal 'initial_'

if ($ScanDevices) {
    Write-Log "WARNING: -ScanDevices requested. Running one Plug and Play device scan, then recollecting disk/PnP/event evidence."
    Invoke-IfAvailable 'device_scan_once' 'pnputil.exe' { & pnputil.exe /scan-devices } 'pnputil /scan-devices' -RequiresAdmin
    Collect-StorageSnapshot 'after_scan_'
    Collect-EventSnapshot 'after_scan_'
}

$toolNames = @(
    'Get-Disk',
    'Get-PhysicalDisk',
    'Get-Partition',
    'Get-Volume',
    'Get-PnpDevice',
    'Get-WinEvent',
    'Get-CimInstance',
    'Get-StorageReliabilityCounter',
    'powercfg.exe',
    'pnputil.exe',
    'systeminfo.exe',
    'driverquery.exe',
    'python.exe',
    'py.exe'
)

$tools = [ordered]@{}
foreach ($tool in $toolNames) {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    $tools[$tool] = [ordered]@{
        available = [bool]$cmd
        source = if ($cmd) { $cmd.Source } else { '' }
    }
}

$summary = [ordered]@{
    schema_version = '1.0'
    script_version = $ScriptVersion
    created_at = (Get-Date).ToUniversalTime().ToString('o')
    run_dir = $RunDir
    raw_dir = $RawDir
    commands_jsonl = $CommandsJsonl
    host = $env:COMPUTERNAME
    platform = 'Windows'
    windows_target = 'Windows 11 Home compatible'
    options = [ordered]@{
        no_admin = [bool]$NoAdmin
        redact = $true
        verbose = [bool]$VerboseOutput
        scan_devices = [bool]$ScanDevices
    }
    admin = [ordered]@{
        is_admin = [bool]$script:IsAdmin
        no_admin_requested = [bool]$NoAdmin
    }
    tools = $tools
    missing_evidence = @($MissingEvidence)
    redaction = [ordered]@{
        report_artifacts_redacted_by_default = $true
        raw_logs_may_contain_serials = $true
    }
    safety = [ordered]@{
        read_only_default = $true
        no_disk_initialization = $true
        no_format = $true
        no_mount = $true
        no_repair = $true
        no_partitioning = $true
        scan_devices_off_by_default = $true
    }
}

$summary | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $SummaryJson -Encoding UTF8
Write-Log "Collection complete: $RunDir"
Write-Host "RUN_DIR=$RunDir"
