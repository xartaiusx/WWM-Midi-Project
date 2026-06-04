# System Diagnostics

Windows 11 Home-compatible diagnostic toolkit for an MSI laptop where a secondary M.2 NVMe SSD is physically installed but not detected.

This toolkit is read-only by default. It collects Windows storage, PnP, NVMe/controller, event log, boot timing, thermal, and power evidence, then generates a Markdown report with findings, confidence, urgency, and recommended next steps.

## What This Can And Cannot Prove

This workflow can show whether Windows sees an NVMe disk, a physical disk, a Win32 disk drive, a PnP NVMe/storage controller, storage reliability counters, WHEA/PCIe/storage errors, boot timing warnings, or thermal/power side effects.

This workflow cannot directly prove M.2 slot power if the SSD never enumerates. If no disk or controller appears, software can only report that no visible Windows evidence was found. The drive may be unseated, electrically inert, disabled by firmware, failing before enumeration, or dead.

The report will not claim the slot or drive is powered unless a drive/controller enumerates.

## Files

- `collect-windows.ps1`: read-only Windows 11 Home collector.
- `analyze-windows.py`: deterministic analyzer that writes `report.md` and `findings.json`.
- `run-windows.ps1`: convenience wrapper that runs collection and analysis.
- `runs/`: timestamped output directories created at runtime.

## Windows 11 Home Compatibility

The scripts use built-in Windows PowerShell/CIM/storage cmdlets and common Windows utilities available on Windows 11 Home:

- `Get-Disk`
- `Get-PhysicalDisk`
- `Get-Partition`
- `Get-Volume`
- `Get-PnpDevice`
- `Get-WinEvent`
- `Get-CimInstance`
- `Get-StorageReliabilityCounter` when available
- `powercfg`
- `pnputil` only when `-ScanDevices` is explicitly requested

Administrator elevation is helpful for fuller event/storage data, but the collector continues without it and records skipped or failed evidence.

## Safe Data Collected

The collector logs every action with timestamps, exit code, stdout path, stderr path, command text, and skip reason.

Collected evidence includes:

- date/time and computer information
- Windows version and system information
- disk inventory from `Get-Disk`
- physical disk inventory from `Get-PhysicalDisk`
- boot/system drive to disk mapping
- partitions and volumes
- Win32 disk drive inventory
- PnP disk/storage/NVMe/PCIe/controller devices
- storage reliability counters where available
- WHEA hardware error events
- System log storage, NVMe, PCIe, disk, storport, and Kernel-PnP events
- Diagnostics-Performance boot events
- ACPI thermal zone and temperature probe data where exposed
- battery/power report from `powercfg /batteryreport`

## Unsafe Operations Intentionally Excluded

The toolkit does not initialize, online/offline, repair, format, partition, mount, clear, wipe, sanitize, or write to disks.

Excluded operations include:

- `Initialize-Disk`
- `Clear-Disk`
- `Format-Volume`
- `New-Partition`
- `Repair-Volume`
- `Set-Disk`
- `Set-Partition`
- `diskpart`
- firmware flashing
- filesystem repair tools
- vendor destructive NVMe utilities

Device scanning is excluded from the default path. It is available only with the explicit `-ScanDevices` flag, prints a warning, runs one `pnputil /scan-devices`, and then recollects disk/PnP/event evidence.

## Usage

Open PowerShell in this folder:

```powershell
.\run-windows.ps1
```

If script execution is blocked:

```powershell
powershell -ExecutionPolicy Bypass -File .\run-windows.ps1
```

Run without admin-only attempts:

```powershell
.\run-windows.ps1 -NoAdmin
```

Run with extra progress:

```powershell
.\run-windows.ps1 -VerboseOutput
```

Use a specific Python 3 executable if `python.exe` or `py.exe` is not on PATH:

```powershell
.\run-windows.ps1 -PythonPath "C:\Path\To\python.exe"
```

Explicitly keep report redaction enabled:

```powershell
.\run-windows.ps1 -Redact
```

Optional Windows device scan, off by default:

```powershell
.\run-windows.ps1 -ScanDevices
```

Do not use `-ScanDevices` unless you intentionally want Windows to ask Plug and Play to scan for device changes. It is not a disk write, but it is a hardware discovery action and can disturb unstable hardware.

## Output Layout

Each run creates:

```text
runs/YYYYMMDD-HHMMSS-computer/
  raw/
  commands.jsonl
  summary.json
  report.md
  findings.json
```

Raw logs may contain serial numbers and other identifiers. The default Markdown report and analyzer JSON redact serial numbers and likely long serial-like identifiers.

## Classification

The analyzer reports one primary status:

- A. Detected normally
- B. Controller/device detected but no disk
- C. Not detected, but PCIe/WHEA/storage errors present
- D. Not detected and no relevant errors
- E. Ambiguous / incomplete evidence

The Windows system disk is treated as the current boot drive. A secondary candidate is reported only when there is evidence beyond the boot disk, or when the boot disk is not NVMe and an NVMe disk/controller is visible.

## References

- Microsoft `Get-Disk`: https://learn.microsoft.com/en-us/powershell/module/storage/get-disk
- Microsoft `Get-PhysicalDisk`: https://learn.microsoft.com/en-us/powershell/module/storage/get-physicaldisk
- Microsoft `Get-WinEvent`: https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.diagnostics/get-winevent
- Microsoft `Get-PnpDevice`: https://learn.microsoft.com/en-us/powershell/module/pnpdevice/get-pnpdevice
- Microsoft `Get-CimInstance`: https://learn.microsoft.com/en-us/powershell/module/cimcmdlets/get-ciminstance
- Microsoft `pnputil`: https://learn.microsoft.com/en-us/windows-hardware/drivers/devtest/pnputil
