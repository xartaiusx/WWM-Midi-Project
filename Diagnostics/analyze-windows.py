#!/usr/bin/env python3
"""Analyze Windows 11 Home M.2/NVMe diagnostic artifacts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_VERSION = "2026.06.03"

SERIAL_LABEL_RE = re.compile(
    r"(?i)\b(serial(?:\s+number)?|serialnumber|uniqueid|deviceid|instanceid|pnpdeviceid)"
    r"(\s*[:=]\s*[\"']?)([A-Za-z0-9&\\._#{}-]{6,})"
)
LONG_SERIAL_LIKE_RE = re.compile(r"\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{16,}\b")
GUID_RE = re.compile(r"^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$")
PCI_VENDOR_RE = re.compile(r"^(PCI|SCSI|STORAGE|USB|ACPI|ROOT)\\", re.IGNORECASE)
RUN_FOLDER_RE = re.compile(r"^\d{8}-\d{6}-[A-Za-z0-9._-]+$")
DIAGNOSTIC_LABEL_RE = re.compile(
    r"^(?:initial|after_scan|get|win32|pnp|system|diagnostics|thermal|temperature|powercfg|"
    r"driverquery|computer|whea|storage|boot|partitions|volumes|date)_",
    re.IGNORECASE,
)
RAW_OUTPUT_LABEL_RE = re.compile(r"^\d{3}_[A-Za-z0-9_.-]+$")

NVME_RE = re.compile(r"\b(NVMe|NVM Express|NVM|stornvme|Standard NVM)\b", re.IGNORECASE)
STORAGE_RE = re.compile(r"(storage|disk|controller|storport|stornvme|partmgr|volmgr|pnp|pci|pcie|pci express)", re.IGNORECASE)
CRITICAL_RE = re.compile(r"(fatal|uncorrected|uncorrectable|hardware error|surprise removed|reset to device|device was not migrated|device not started|controller error|bad block|timeout)", re.IGNORECASE)
WARNING_RE = re.compile(r"(whea|corrected|warning|reset|timeout|failed|error|stornvme|storport|kernel-pnp|link|bus)", re.IGNORECASE)
EVENT_SIGNAL_RE = re.compile(
    r"(whea|error|failed|failure|fatal|warning|timeout|reset|surprise|removed|bad block|"
    r"not migrated|not started|controller error|corrected|uncorrected)",
    re.IGNORECASE,
)
NOISE_EVENT_RE = re.compile(
    r"(credential guard auto enablement|is healthy\. no action is needed|microsoft-windows-httpservice|"
    r"found passthru disk)",
    re.IGNORECASE,
)


@dataclass
class CommandRecord:
    label: str
    status: str
    exit_code: int | None
    stdout: Path
    stderr: Path
    timed_out: bool = False
    skip_reason: str = ""
    command: str = ""


@dataclass
class WindowsEvidence:
    get_disks: list[dict[str, Any]] = field(default_factory=list)
    physical_disks: list[dict[str, Any]] = field(default_factory=list)
    win32_disks: list[dict[str, Any]] = field(default_factory=list)
    pnp_devices: list[dict[str, Any]] = field(default_factory=list)
    boot_disk: dict[str, Any] = field(default_factory=dict)
    reliability: list[dict[str, Any]] = field(default_factory=list)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Analyze Windows System Diagnostics artifacts.")
    parser.add_argument("run_dir", help="Path to a timestamped run directory")
    parser.add_argument("--redact", action="store_true", default=True, help="Redact serials in exported artifacts")
    parser.add_argument("--verbose", action="store_true", help="Print analysis progress")
    return parser.parse_args()


def read_text(path: Path, limit: int = 30_000_000) -> str:
    try:
        with path.open("rb") as handle:
            data = handle.read(limit + 1)
    except OSError:
        return ""
    if len(data) > limit:
        data = data[:limit] + b"\n[TRUNCATED BY ANALYZER]\n"
    if data.startswith(b"\xff\xfe"):
        return data.decode("utf-16-le", errors="replace").lstrip("\ufeff")
    if data.startswith(b"\xfe\xff"):
        return data.decode("utf-16-be", errors="replace").lstrip("\ufeff")
    if data[:200].count(b"\x00") > 20:
        return data.decode("utf-16-le", errors="replace").lstrip("\ufeff")
    return data.decode("utf-8-sig", errors="replace")


def load_json(path: Path, default: Any) -> Any:
    text = read_text(path).strip()
    if not text:
        return default
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return default


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def load_commands(run_dir: Path) -> list[CommandRecord]:
    records: list[CommandRecord] = []
    for line in read_text(run_dir / "commands.jsonl").splitlines():
        line = line.strip().lstrip("\ufeff")
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        records.append(
            CommandRecord(
                label=str(raw.get("label", "")),
                status=str(raw.get("status", "")),
                exit_code=raw.get("exit_code"),
                stdout=Path(str(raw.get("stdout", ""))),
                stderr=Path(str(raw.get("stderr", ""))),
                timed_out=bool(raw.get("timed_out", False)),
                skip_reason=str(raw.get("skip_reason", "")),
                command=str(raw.get("command", "")),
            )
        )
    return records


def label_records(commands: list[CommandRecord], suffix: str) -> list[CommandRecord]:
    return [record for record in commands if record.label.endswith(suffix)]


def latest_success(commands: list[CommandRecord], suffix: str) -> CommandRecord | None:
    matches = [record for record in label_records(commands, suffix) if record.status == "completed" and record.exit_code == 0]
    return matches[-1] if matches else None


def latest_any(commands: list[CommandRecord], suffix: str) -> CommandRecord | None:
    matches = label_records(commands, suffix)
    return matches[-1] if matches else None


def json_from_label(commands: list[CommandRecord], suffix: str) -> Any:
    record = latest_success(commands, suffix)
    if not record:
        return []
    return load_json(record.stdout, [])


def ci_get(item: dict[str, Any], *keys: str, default: Any = "") -> Any:
    lowered = {str(k).lower(): v for k, v in item.items()}
    for key in keys:
        if key.lower() in lowered:
            value = lowered[key.lower()]
            return default if value is None else value
    return default


def redact_serials(text: str, aggressive: bool = True) -> str:
    def label_repl(match: re.Match[str]) -> str:
        label = match.group(1).lower()
        value = match.group(3)
        if label in {"deviceid", "instanceid", "pnpdeviceid"} and PCI_VENDOR_RE.match(value):
            return match.group(0)
        return f"{match.group(1)}{match.group(2)}[REDACTED_SERIAL]"

    text = SERIAL_LABEL_RE.sub(label_repl, text)
    if not aggressive:
        return text

    def long_repl(match: re.Match[str]) -> str:
        token = match.group(0)
        if GUID_RE.match(token) or RUN_FOLDER_RE.match(token) or DIAGNOSTIC_LABEL_RE.match(token) or RAW_OUTPUT_LABEL_RE.match(token):
            return token
        return "[REDACTED_SERIAL]"

    return LONG_SERIAL_LIKE_RE.sub(long_repl, text)


def build_evidence(commands: list[CommandRecord]) -> WindowsEvidence:
    evidence = WindowsEvidence()
    evidence.get_disks = [x for x in as_list(json_from_label(commands, "get_disk_json")) if isinstance(x, dict)]
    evidence.physical_disks = [x for x in as_list(json_from_label(commands, "get_physicaldisk_json")) if isinstance(x, dict)]
    evidence.win32_disks = [x for x in as_list(json_from_label(commands, "win32_diskdrive_json")) if isinstance(x, dict)]
    evidence.pnp_devices.extend(x for x in as_list(json_from_label(commands, "pnp_storage_json")) if isinstance(x, dict))
    evidence.pnp_devices.extend(x for x in as_list(json_from_label(commands, "win32_pnpentity_storage_json")) if isinstance(x, dict))
    boot = json_from_label(commands, "boot_disk_json")
    if isinstance(boot, dict):
        evidence.boot_disk = boot
    evidence.reliability = [x for x in as_list(json_from_label(commands, "storage_reliability_json")) if isinstance(x, dict)]
    return evidence


def disk_is_nvme(item: dict[str, Any]) -> bool:
    fields = [
        ci_get(item, "BusType"),
        ci_get(item, "InterfaceType"),
        ci_get(item, "FriendlyName"),
        ci_get(item, "Model"),
        ci_get(item, "PNPDeviceID"),
        ci_get(item, "DeviceID"),
        ci_get(item, "Path"),
        ci_get(item, "Location"),
    ]
    return any(NVME_RE.search(str(value)) for value in fields)


def disk_identity(item: dict[str, Any]) -> str:
    for key in ("Number", "DeviceId", "Index", "FriendlyName", "Model", "DeviceID", "UniqueId"):
        value = ci_get(item, key)
        if value != "":
            return str(value)
    return ""


def boot_identity(evidence: WindowsEvidence) -> tuple[str, bool]:
    boot = evidence.boot_disk
    if boot:
        number = ci_get(boot, "DiskNumber")
        bus = str(ci_get(boot, "BusType"))
        if number != "":
            return str(number), bool(NVME_RE.search(bus))
    for disk in evidence.get_disks:
        if bool(ci_get(disk, "IsBoot", default=False)) or bool(ci_get(disk, "IsSystem", default=False)):
            return str(ci_get(disk, "Number")), disk_is_nvme(disk)
    return "", False


def nvme_disk_candidates(evidence: WindowsEvidence) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for source, items in (
        ("Get-Disk", evidence.get_disks),
        ("Get-PhysicalDisk", evidence.physical_disks),
        ("Win32_DiskDrive", evidence.win32_disks),
    ):
        for item in items:
            if disk_is_nvme(item):
                row = dict(item)
                row["_source"] = source
                row["_identity"] = disk_identity(item)
                rows.append(row)
    return rows


def pnp_nvme_controllers(evidence: WindowsEvidence) -> list[dict[str, Any]]:
    controllers: list[dict[str, Any]] = []
    for item in evidence.pnp_devices:
        blob = " ".join(str(ci_get(item, key)) for key in ("FriendlyName", "Name", "InstanceId", "DeviceID", "Class", "PNPClass", "Service"))
        is_controller = re.search(r"(controller|standard nvm|stornvme|scsiadapter|storagecontroller)", blob, re.IGNORECASE)
        if NVME_RE.search(blob) and is_controller:
            controllers.append(item)
    return controllers


def pnp_problem_devices(evidence: WindowsEvidence) -> list[dict[str, Any]]:
    problems: list[dict[str, Any]] = []
    for item in evidence.pnp_devices:
        blob = " ".join(str(ci_get(item, key)) for key in ("FriendlyName", "Name", "InstanceId", "DeviceID", "Class", "PNPClass", "Service"))
        present = ci_get(item, "Present", default=True)
        if str(present).lower() == "false":
            continue
        is_relevant_device = NVME_RE.search(blob) or re.search(r"(scsiadapter|storagecontroller|storage controller|stornvme|standard nvm|controller)", blob, re.IGNORECASE)
        if not is_relevant_device:
            continue
        status = str(ci_get(item, "Status"))
        problem = str(ci_get(item, "Problem", "ConfigManagerErrorCode"))
        if STORAGE_RE.search(blob) and ((status and status.upper() not in {"OK", "UNKNOWN", ""}) or problem not in {"", "0", "None"}):
            problems.append(item)
    return problems


def parse_events(commands: list[CommandRecord]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for suffix in ("whea_events_json", "system_storage_events_json", "diagnostics_performance_boot_json"):
        for item in as_list(json_from_label(commands, suffix)):
            if isinstance(item, dict):
                item = dict(item)
                item["_source"] = suffix
                events.append(item)
    return events


def collect_error_findings(commands: list[CommandRecord], events: list[dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    findings: dict[str, list[dict[str, str]]] = {"Critical": [], "Warning": [], "Informational": []}
    seen: set[tuple[str, str]] = set()

    for event in events:
        provider = str(ci_get(event, "ProviderName"))
        level = str(ci_get(event, "LevelDisplayName"))
        message = str(ci_get(event, "Message"))
        blob = f"{provider} {level} {message}"
        if NOISE_EVENT_RE.search(blob):
            continue
        if not EVENT_SIGNAL_RE.search(blob):
            continue
        if provider.lower() == "microsoft-windows-kernel-pnp" and not re.search(r"(nvme|nvm|scsi|disk|storage|stor|vmd|rst|pci express|pcie)", message, re.IGNORECASE):
            continue
        if not (STORAGE_RE.search(blob) or NVME_RE.search(blob) or "whea" in blob.lower()):
            continue
        if CRITICAL_RE.search(blob) or level.lower() in {"critical", "error"}:
            severity = "Critical"
        elif WARNING_RE.search(blob) or level.lower() == "warning":
            severity = "Warning"
        else:
            severity = "Informational"
        time_created = str(ci_get(event, "TimeCreated"))
        event_id = str(ci_get(event, "Id"))
        excerpt = redact_serials(f"{time_created} {provider} event {event_id}: {message}".strip(), aggressive=True)
        excerpt = re.sub(r"\s+", " ", excerpt)[:600]
        key = (severity, excerpt)
        if key in seen:
            continue
        seen.add(key)
        findings[severity].append({"source": str(event.get("_source", "event")), "excerpt": excerpt})

    for severity in findings:
        findings[severity] = findings[severity][:12]
    return findings


def missing_evidence(summary: dict[str, Any], commands: list[CommandRecord]) -> list[str]:
    missing = [str(item) for item in summary.get("missing_evidence", []) if item]
    core_suffixes = ["get_disk_json", "get_physicaldisk_json", "win32_diskdrive_json", "pnp_storage_json", "system_storage_events_json"]
    for suffix in core_suffixes:
        if not latest_success(commands, suffix):
            missing.append(f"{suffix}: unavailable")
    for record in commands:
        if record.status == "skipped" and record.skip_reason:
            missing.append(f"{record.label}: {record.skip_reason}")
        if record.timed_out:
            missing.append(f"{record.label}: command timed out")
    deduped: list[str] = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)
    return deduped


def classify(summary: dict[str, Any], commands: list[CommandRecord], evidence: WindowsEvidence, errors: dict[str, list[dict[str, str]]]) -> dict[str, Any]:
    boot_number, boot_is_nvme = boot_identity(evidence)
    nvme_disks = nvme_disk_candidates(evidence)
    controllers = pnp_nvme_controllers(evidence)
    pnp_problems = pnp_problem_devices(evidence)

    secondary_visible = False
    for disk in evidence.get_disks:
        if not disk_is_nvme(disk):
            continue
        number = str(ci_get(disk, "Number"))
        if boot_number == "" or number != boot_number:
            secondary_visible = True

    if not secondary_visible:
        get_disk_available = bool(evidence.get_disks)
        win32_nvme_ids = {disk_identity(row) for row in evidence.win32_disks if disk_is_nvme(row) and disk_identity(row) != ""}
        physical_nvme_ids = {disk_identity(row) for row in evidence.physical_disks if disk_is_nvme(row) and disk_identity(row) != ""}
        if boot_is_nvme:
            # Avoid treating the same boot disk reported by multiple Windows APIs as multiple physical drives.
            secondary_visible = False if get_disk_available else max(len(win32_nvme_ids), len(physical_nvme_ids)) > 1
        else:
            secondary_visible = any(disk_is_nvme(row) for row in evidence.get_disks) if get_disk_available else max(len(win32_nvme_ids), len(physical_nvme_ids)) > 0

    controller_without_disk = False
    expected_boot_controller_count = 1 if boot_is_nvme else 0
    if len(controllers) > max(expected_boot_controller_count, len({row.get("_identity", "") for row in nvme_disks})):
        controller_without_disk = True
    if not nvme_disks and controllers:
        controller_without_disk = True
    if pnp_problems and not secondary_visible:
        controller_without_disk = True

    relevant_errors = bool(errors["Critical"] or errors["Warning"])
    missing = missing_evidence(summary, commands)
    core_disk_available = bool(latest_success(commands, "get_disk_json") or latest_success(commands, "win32_diskdrive_json"))
    pnp_available = bool(latest_success(commands, "pnp_storage_json") or latest_success(commands, "win32_pnpentity_storage_json"))
    events_available = bool(latest_success(commands, "system_storage_events_json") or latest_success(commands, "whea_events_json"))
    critically_incomplete = (not core_disk_available and not pnp_available) or (not events_available and not (secondary_visible or controller_without_disk))

    if secondary_visible:
        status = "A. Detected normally"
        meaning = "A secondary NVMe disk is visible to Windows."
        next_action = "Review health, partitions, volumes, and backup status without initializing or formatting the disk."
    elif controller_without_disk:
        status = "B. Controller/device detected but no disk"
        meaning = "Windows sees an NVMe/storage controller or problem storage device, but no corresponding secondary disk is visible."
        next_action = "Compare Device Manager controller count to expected physical drives and inspect PnP/problem-device plus event-log details."
    elif critically_incomplete:
        status = "E. Ambiguous / incomplete evidence"
        meaning = "Core Windows disk, PnP, or event evidence is missing, so the secondary drive cannot be classified reliably."
        next_action = "Rerun from an elevated PowerShell window unless intentionally using -NoAdmin."
    elif relevant_errors:
        status = "C. Not detected, but PCIe/WHEA/storage errors present"
        meaning = "The secondary NVMe is not visible, but Windows logged hardware, PCIe, NVMe, storage, disk, or PnP error indicators."
        next_action = "Power down, unplug charger, reseat the SSD, inspect the connector and SSD, then retest BIOS and Windows visibility."
    else:
        status = "D. Not detected and no relevant errors"
        meaning = "The secondary NVMe does not appear in collected Windows evidence and no relevant errors were found."
        next_action = "Power down, reseat the SSD, check BIOS/UEFI visibility, and test the SSD in a USB NVMe enclosure if it remains absent."

    if status.startswith("E"):
        confidence = "Low"
    elif status.startswith("A"):
        confidence = "High" if core_disk_available and pnp_available else "Medium"
    elif status.startswith("B"):
        confidence = "Medium" if pnp_available else "Low"
    elif status.startswith("C"):
        confidence = "High" if events_available and core_disk_available else "Medium"
    else:
        confidence = "Medium" if core_disk_available and pnp_available and events_available else "Low"

    if errors["Critical"]:
        urgency = "High"
    elif errors["Warning"]:
        urgency = "Medium"
    else:
        urgency = "Low"

    return {
        "status": status,
        "meaning": meaning,
        "confidence": confidence,
        "urgency": urgency,
        "next_action": next_action,
        "boot_disk_number": boot_number,
        "boot_is_nvme": boot_is_nvme,
        "secondary_visible": secondary_visible,
        "controller_without_disk": controller_without_disk,
        "nvme_disk_candidate_count": len(nvme_disks),
        "nvme_controller_candidate_count": len(controllers),
        "pnp_problem_device_count": len(pnp_problems),
        "more_than_one_nvme_disk_candidate": secondary_visible,
        "missing_evidence": missing,
    }


def visibility_matrix(evidence: WindowsEvidence, events: list[dict[str, Any]], errors: dict[str, list[dict[str, str]]], classification: dict[str, Any], commands: list[CommandRecord]) -> list[dict[str, str]]:
    diagnostics_boot = latest_success(commands, "diagnostics_performance_boot_json") is not None
    thermal = latest_success(commands, "thermal_zone_json") is not None or latest_success(commands, "temperature_probe_json") is not None
    battery = latest_success(commands, "powercfg_batteryreport") is not None
    reliability = bool(evidence.reliability)
    nvme_disks = nvme_disk_candidates(evidence)
    controllers = pnp_nvme_controllers(evidence)
    pnp_problems = pnp_problem_devices(evidence)

    return [
        {
            "Layer": "Firmware/boot timing proxy",
            "Tool/source": "Diagnostics-Performance event log",
            "Evidence found": "Collected" if diagnostics_boot else "Unavailable",
            "Interpretation": "Boot timing is indirect only; it cannot prove M.2 slot power.",
        },
        {
            "Layer": "PCIe/PnP bus",
            "Tool/source": "Get-PnpDevice, Win32_PnPEntity",
            "Evidence found": f"{len(controllers)} NVMe controller candidate(s), {len(pnp_problems)} problem storage device(s)",
            "Interpretation": "PnP enumeration implies a responding device/controller; absence does not prove lack of power.",
        },
        {
            "Layer": "NVMe controller",
            "Tool/source": "PnP storage/controller devices",
            "Evidence found": f"{len(controllers)} controller candidate(s)",
            "Interpretation": "A controller candidate means Windows sees an NVMe/controller path.",
        },
        {
            "Layer": "Disk visibility",
            "Tool/source": "Get-Disk, Get-PhysicalDisk, Win32_DiskDrive",
            "Evidence found": f"{len(nvme_disks)} NVMe disk observation(s) across APIs; secondary visible: {'yes' if classification.get('secondary_visible') else 'no'}",
            "Interpretation": "A disk candidate is the strongest normal Windows visibility signal.",
        },
        {
            "Layer": "SMART/health proxy",
            "Tool/source": "Get-StorageReliabilityCounter, health fields",
            "Evidence found": "Collected" if reliability else "Unavailable or no supported device",
            "Interpretation": "Windows reliability counters can assess visible devices, not absent devices.",
        },
        {
            "Layer": "Event logs",
            "Tool/source": "WHEA, System storage, Kernel-PnP",
            "Evidence found": f"{len(errors['Critical'])} critical, {len(errors['Warning'])} warning, {len(errors['Informational'])} informational excerpt(s)",
            "Interpretation": "WHEA/storage/PnP errors can suggest link, controller, or communication trouble.",
        },
        {
            "Layer": "Thermal/power side effects",
            "Tool/source": "ACPI thermal CIM, powercfg",
            "Evidence found": ", ".join(name for name, ok in [("thermal", thermal), ("battery report", battery)] if ok) or "Unavailable",
            "Interpretation": "These are indirect side effects and cannot prove slot power by themselves.",
        },
    ]


def markdown_table(rows: list[dict[str, Any]], columns: list[str]) -> str:
    lines = ["| " + " | ".join(columns) + " |", "| " + " | ".join("---" for _ in columns) + " |"]
    for row in rows:
        values = []
        for column in columns:
            value = str(row.get(column, ""))
            value = value.replace("\n", " ").replace("|", "\\|")
            values.append(value)
        lines.append("| " + " | ".join(values) + " |")
    return "\n".join(lines)


def performance_checklist(commands: list[CommandRecord]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    disks = [item for item in as_list(json_from_label(commands, "logical_disk_free_json")) if isinstance(item, dict)]
    if disks:
        notes: list[str] = []
        for disk in disks:
            size = float(ci_get(disk, "Size", default=0) or 0)
            free = float(ci_get(disk, "FreeSpace", default=0) or 0)
            percent = (free / size * 100.0) if size else 0.0
            notes.append(f"{ci_get(disk, 'DeviceID', default='?')} {percent:.1f}% free")
        rows.append(
            {
                "Area": "Free space",
                "Evidence": "; ".join(notes),
                "Action": "Keep enough SSD space available for Windows, game updates, build artifacts, and the release album.",
            }
        )
    else:
        rows.append({"Area": "Free space", "Evidence": "Unavailable", "Action": "Rerun if storage pressure is suspected."})

    startup = [item for item in as_list(json_from_label(commands, "startup_commands_json")) if isinstance(item, dict)]
    rows.append(
        {
            "Area": "Startup apps",
            "Evidence": f"{len(startup)} startup command(s) collected" if startup else "Unavailable or none found",
            "Action": "Review unnecessary startup/background apps before long play or build sessions.",
        }
    )

    active_scheme_record = latest_success(commands, "powercfg_active_scheme")
    active_scheme = read_text(active_scheme_record.stdout, 5000).strip() if active_scheme_record else "Unavailable"
    rows.append(
        {
            "Area": "Power mode",
            "Evidence": active_scheme,
            "Action": "Use an appropriate plugged-in/high-performance mode when testing game latency.",
        }
    )

    gamebar = latest_success(commands, "gamebar_registry_json")
    rows.append(
        {
            "Area": "Windowed game settings",
            "Evidence": "Game Bar/GameDVR/UserGpuPreferences collected" if gamebar else "Unavailable",
            "Action": "Check Windows Graphics settings for windowed-game optimizations and per-app GPU preference.",
        }
    )

    top_processes = latest_success(commands, "top_processes_json")
    rows.append(
        {
            "Area": "Background load",
            "Evidence": "Top CPU/working-set processes collected" if top_processes else "Unavailable",
            "Action": "Close high-load unused apps when diagnosing overlay or game stutter.",
        }
    )

    return rows


def detected_rows(evidence: WindowsEvidence, classification: dict[str, Any]) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    boot_number = classification.get("boot_disk_number", "")

    for source, items in (
        ("Get-Disk", evidence.get_disks),
        ("Get-PhysicalDisk", evidence.physical_disks),
        ("Win32_DiskDrive", evidence.win32_disks),
    ):
        for item in items:
            name = str(ci_get(item, "FriendlyName", "Model", "DeviceID", default=""))
            bus = str(ci_get(item, "BusType", "InterfaceType", default=""))
            identity = disk_identity(item)
            if not disk_is_nvme(item) and source != "Get-Disk":
                continue
            if source == "Win32_DiskDrive":
                source_number = ci_get(item, "Index", default="")
            elif source == "Get-PhysicalDisk":
                source_number = ci_get(item, "DeviceId", default="")
            else:
                source_number = ci_get(item, "Number", default="")
            role = "boot/system" if str(source_number) == str(boot_number) else "secondary candidate" if disk_is_nvme(item) else "non-NVMe disk"
            serial = str(ci_get(item, "SerialNumber", "UniqueId", default=""))
            rows.append(
                {
                    "Source": source,
                    "Name/id": identity or name,
                    "Model/controller": name,
                    "Bus/status": f"{bus} {ci_get(item, 'HealthStatus', 'Status', default='')}".strip(),
                    "Serial": "[REDACTED_SERIAL]" if serial else "",
                    "Role/notes": role,
                }
            )

    for item in pnp_nvme_controllers(evidence):
        name = str(ci_get(item, "FriendlyName", "Name", default=""))
        status = str(ci_get(item, "Status", default=""))
        rows.append(
            {
                "Source": "PnP",
                "Name/id": str(ci_get(item, "Class", "PNPClass", default="controller")),
                "Model/controller": name,
                "Bus/status": status,
                "Serial": "",
                "Role/notes": "NVMe/controller candidate",
            }
        )

    if not rows:
        return [{"Source": "-", "Name/id": "No disk/controller rows found", "Model/controller": "", "Bus/status": "", "Serial": "", "Role/notes": ""}]

    seen: set[tuple[str, str, str]] = set()
    deduped: list[dict[str, str]] = []
    for row in rows:
        key = (row["Source"], row["Name/id"], row["Model/controller"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return deduped


def recommendations(classification: dict[str, Any]) -> list[str]:
    recs = [classification["next_action"]]
    if classification["missing_evidence"]:
        recs.append("Rerun from an elevated PowerShell window if fuller disk, PnP, or event evidence is needed.")
    recs.extend(
        [
            "Check BIOS/UEFI storage visibility before Windows loads.",
            "Open Device Manager and look for NVMe/storage controller problem icons without changing devices.",
            "Power off the laptop fully.",
            "Unplug the charger.",
            "Open the laptop only when safe to do so.",
            "Reseat the SSD fully in the M.2 slot.",
            "Inspect the connector, screw/standoff alignment, and SSD edge contacts.",
            "If still absent, test the SSD in a USB NVMe enclosure or another known-good M.2 slot.",
        ]
    )
    return recs


def write_report(
    run_dir: Path,
    summary: dict[str, Any],
    commands: list[CommandRecord],
    evidence: WindowsEvidence,
    events: list[dict[str, Any]],
    errors: dict[str, list[dict[str, str]]],
    classification: dict[str, Any],
    matrix: list[dict[str, str]],
) -> None:
    secondary_text = "detected" if classification["secondary_visible"] else "not detected as a Windows disk"
    error_text = "WHEA/PCIe/NVMe/storage error indicators were found" if errors["Critical"] or errors["Warning"] else "No relevant WHEA/PCIe/NVMe/storage error indicators were found"
    executive = (
        f"The suspected secondary NVMe is {secondary_text}. {error_text}. "
        f"Primary classification: {classification['status']} with {classification['confidence'].lower()} confidence "
        f"and {classification['urgency'].lower()} urgency. Software cannot prove M.2 slot power when no controller or disk enumerates."
    )

    command_rows = [
        {
            "Label": record.label,
            "Status": record.status,
            "Exit": "" if record.exit_code is None else str(record.exit_code),
            "Stdout": str(record.stdout),
        }
        for record in commands
    ]

    tools = summary.get("tools", {}) if isinstance(summary.get("tools"), dict) else {}
    missing_tools = [name for name, info in tools.items() if isinstance(info, dict) and not info.get("available", False)]

    lines = [
        "# Windows M.2 NVMe Diagnostic Report",
        "",
        "## Executive Summary",
        "",
        executive,
        "",
        "## Visibility Matrix",
        "",
        markdown_table(matrix, ["Layer", "Tool/source", "Evidence found", "Interpretation"]),
        "",
        "## Windows Performance Checklist",
        "",
        markdown_table(performance_checklist(commands), ["Area", "Evidence", "Action"]),
        "",
        "## Detected Drives And Controllers",
        "",
        f"- Boot disk number: `{classification.get('boot_disk_number') or 'unknown'}`",
        f"- Boot disk appears NVMe: `{'yes' if classification.get('boot_is_nvme') else 'no'}`",
        f"- More than one NVMe disk candidate appears: `{'yes' if classification.get('more_than_one_nvme_disk_candidate') else 'no'}`",
        "",
        markdown_table(detected_rows(evidence, classification), ["Source", "Name/id", "Model/controller", "Bus/status", "Serial", "Role/notes"]),
        "",
        "## Error Findings",
        "",
    ]

    for severity in ("Critical", "Warning", "Informational"):
        lines.extend([f"### {severity}", ""])
        items = errors[severity]
        if not items:
            lines.extend(["No matching excerpts found.", ""])
            continue
        for item in items:
            lines.append(f"- `{item['source']}`: {item['excerpt']}")
        lines.append("")

    lines.extend(
        [
            "## Interpretation",
            "",
            f"Classification: **{classification['status']}**.",
            "",
            classification["meaning"],
            "",
            "If the secondary SSD does not enumerate as a Windows disk, PnP device, or storage controller, software cannot prove whether the M.2 slot is powered. Absence of evidence can mean no enumeration, not necessarily no electrical power.",
            "",
            "## Recommended Next Actions",
            "",
            f"Urgency: **{classification['urgency']}**.",
            "",
        ]
    )
    for rec in recommendations(classification):
        lines.append(f"- {rec}")

    lines.extend(
        [
            "",
            "## Appendix",
            "",
            f"- Script version/date: `{SCRIPT_VERSION}` / `{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}`",
            f"- Run directory: `{run_dir}`",
            f"- Raw logs: `{run_dir / 'raw'}`",
            "- Redaction status: enabled for this report and `findings.json`; raw logs may contain serials.",
            f"- Missing tools: `{', '.join(missing_tools) if missing_tools else 'none detected by collector'}`",
            f"- Event records analyzed: `{len(events)}`",
            "",
            "### Missing Or Incomplete Evidence",
            "",
        ]
    )
    if classification["missing_evidence"]:
        for item in classification["missing_evidence"]:
            lines.append(f"- {redact_serials(item)}")
    else:
        lines.append("- None reported.")

    lines.extend(["", "### Command Inventory", "", markdown_table(command_rows, ["Label", "Status", "Exit", "Stdout"]), ""])
    (run_dir / "report.md").write_text(redact_serials("\n".join(lines) + "\n", aggressive=True), encoding="utf-8")


def write_findings(
    run_dir: Path,
    evidence: WindowsEvidence,
    events: list[dict[str, Any]],
    errors: dict[str, list[dict[str, str]]],
    classification: dict[str, Any],
    matrix: list[dict[str, str]],
) -> None:
    payload = {
        "schema_version": "1.0",
        "script_version": SCRIPT_VERSION,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "run_dir": str(run_dir),
        "classification": classification,
        "visibility_matrix": matrix,
        "detected": {
            "get_disk_count": len(evidence.get_disks),
            "physical_disk_count": len(evidence.physical_disks),
            "win32_disk_count": len(evidence.win32_disks),
            "nvme_disk_candidate_count": len(nvme_disk_candidates(evidence)),
            "nvme_controller_candidate_count": len(pnp_nvme_controllers(evidence)),
            "pnp_problem_device_count": len(pnp_problem_devices(evidence)),
        },
        "errors": errors,
        "event_count_analyzed": len(events),
        "redaction": {
            "enabled": True,
            "raw_logs_may_contain_serials": True,
            "report_artifacts_redacted": True,
        },
        "recommended_next_actions": recommendations(classification),
    }
    text = json.dumps(payload, indent=2, sort_keys=True)
    (run_dir / "findings.json").write_text(redact_serials(text, aggressive=True) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    run_dir = Path(args.run_dir.lstrip("\ufeff")).expanduser().resolve()
    if not run_dir.exists():
        print(f"Run directory does not exist: {run_dir}", file=sys.stderr)
        return 2

    summary = load_json(run_dir / "summary.json", {})
    commands = load_commands(run_dir)
    evidence = build_evidence(commands)
    events = parse_events(commands)
    errors = collect_error_findings(commands, events)
    classification = classify(summary, commands, evidence, errors)
    matrix = visibility_matrix(evidence, events, errors, classification, commands)

    write_report(run_dir, summary, commands, evidence, events, errors, classification, matrix)
    write_findings(run_dir, evidence, events, errors, classification, matrix)

    if args.verbose:
        print(f"Analyzed {run_dir}")
    print(f"REPORT={run_dir / 'report.md'}")
    print(f"CLASSIFICATION={classification['status']}")
    print(f"CONFIDENCE={classification['confidence']}")
    print(f"URGENCY={classification['urgency']}")
    print(f"NEXT_ACTION={classification['next_action']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
