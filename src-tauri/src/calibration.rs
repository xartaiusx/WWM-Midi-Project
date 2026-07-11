use crate::instrument::{map_exact_36, InstrumentProfile};
use crate::keyboard::{self, InputResult, InputTiming};
use crate::scheduler::HighResolutionWaiter;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: usize = 2;
static CALIBRATION_CANCELLED: AtomicBool = AtomicBool::new(false);
static CALIBRATION_RUNNING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum CalibrationKind {
    PitchSweep,
    TimingStress,
    Drift,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitchMeasurement {
    pub midi_note: u8,
    pub expected_hz: f64,
    pub detected_hz: Option<f64>,
    pub cents_error: Option<f64>,
    pub onset_latency_ms: Option<f64>,
    pub relative_onset_error_ms: Option<f64>,
    pub rms: f64,
    pub uses_modifier: bool,
    pub accepted_by_input_api: bool,
    pub passed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationReport {
    pub profile: InstrumentProfile,
    pub kind: CalibrationKind,
    pub passed: bool,
    pub expected_note_count: usize,
    pub detected_note_count: usize,
    pub correct_pitch_count: usize,
    pub extra_note_count: usize,
    pub modifier_note_count: usize,
    pub modifier_reliable_count: usize,
    pub onset_recall_percent: f64,
    pub median_latency_ms: Option<f64>,
    pub p95_relative_onset_error_ms: Option<f64>,
    pub cumulative_drift_ms: Option<f64>,
    pub p95_chord_spread_ms: Option<f64>,
    pub maximum_clean_onsets_per_second: Option<u32>,
    #[serde(default)]
    pub certified_rate_onset_recall_percent: Option<f64>,
    #[serde(default)]
    pub minimum_clean_tap_ms: Option<u64>,
    #[serde(default)]
    pub minimum_reliable_modifier_lead_ms: Option<u64>,
    #[serde(default)]
    pub minimum_reliable_modifier_release_ms: Option<u64>,
    pub recommended_input_timing: InputTiming,
    pub measurements: Vec<PitchMeasurement>,
    pub input_failures: usize,
    pub notes_confirmed_heard: usize,
    pub notes_accepted_by_api: usize,
    pub notes_accepted_but_not_heard: usize,
    pub saved_to: Option<String>,
    pub messages: Vec<String>,
}

#[derive(Debug, Clone)]
struct ScheduledAction {
    scheduled_us: u64,
    notes: Vec<u8>,
    timing: InputTiming,
    rate_group: Option<u32>,
    timing_probe: Option<TimingProbe>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimingProbe {
    Tap(u64),
    ModifierLead(u64),
    ModifierRelease(u64),
}

#[derive(Debug)]
struct PerformedAction {
    scheduled: ScheduledAction,
    input: InputResult,
}

#[derive(Debug)]
struct CapturedAudio {
    mono_samples: Vec<f32>,
    sample_rate: u32,
}

struct CalibrationRunGuard;

impl CalibrationRunGuard {
    fn acquire() -> Result<Self, String> {
        CALIBRATION_RUNNING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| "A Konghou calibration stage is already running.".to_string())?;
        Ok(Self)
    }
}

impl Drop for CalibrationRunGuard {
    fn drop(&mut self) {
        CALIBRATION_RUNNING.store(false, Ordering::SeqCst);
    }
}

pub fn run_konghou_calibration(
    kind: CalibrationKind,
    local_album_dir: &Path,
) -> Result<CalibrationReport, String> {
    let _run_guard = CalibrationRunGuard::acquire()?;
    CALIBRATION_CANCELLED.store(false, Ordering::SeqCst);
    keyboard::prepare_target()?;
    let default_timing = keyboard::get_input_timing();
    let schedule = build_schedule(kind, default_timing);
    let duration = schedule
        .last()
        .map(|action| Duration::from_micros(action.scheduled_us) + Duration::from_secs(2))
        .unwrap_or(Duration::from_secs(2));

    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let capture = std::thread::Builder::new()
        .name("konghou-wasapi-calibration".to_string())
        .spawn(move || capture_loopback(duration, ready_tx))
        .map_err(|error| format!("Failed to start WASAPI calibration capture: {error}"))?;
    let capture_started = match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(started)) => started,
        Ok(Err(error)) => return Err(error),
        Err(_) => {
            CALIBRATION_CANCELLED.store(true, Ordering::SeqCst);
            return Err("WASAPI loopback did not become ready within five seconds.".to_string());
        }
    };

    let waiter = HighResolutionWaiter::new();
    let anchor = Instant::now();
    let capture_anchor_offset_us = anchor
        .saturating_duration_since(capture_started)
        .as_micros()
        .min(u64::MAX as u128) as u64;
    let mut performed = Vec::with_capacity(schedule.len());
    let mut cancelled = false;
    for action in schedule {
        if CALIBRATION_CANCELLED.load(Ordering::SeqCst) {
            cancelled = true;
            break;
        }
        let deadline = anchor + Duration::from_micros(action.scheduled_us);
        if !waiter.wait_until(deadline, || !CALIBRATION_CANCELLED.load(Ordering::SeqCst)) {
            cancelled = true;
            break;
        }
        let keys = action
            .notes
            .iter()
            .map(|note| map_exact_36(*note as i32, 0, false).map(|mapping| mapping.key))
            .collect::<Result<Vec<_>, _>>()?;
        let result = keyboard::tap_chord_with_timing(&keys, action.timing);
        performed.push(PerformedAction {
            scheduled: action,
            input: result,
        });
    }

    let captured = capture
        .join()
        .map_err(|_| "WASAPI calibration capture thread terminated unexpectedly.".to_string())??;
    if cancelled {
        return Err("Konghou calibration was cancelled.".to_string());
    }
    let mut report = analyze_capture(
        kind,
        &performed,
        &captured,
        default_timing,
        capture_anchor_offset_us,
    );

    std::fs::create_dir_all(local_album_dir)
        .map_err(|error| format!("Failed to access local album directory: {error}"))?;
    let output_path = local_album_dir.join(format!(
        ".konghou-calibration-{}.local.json",
        calibration_kind_slug(kind)
    ));
    let latest_path = local_album_dir.join(".konghou-calibration.local.json");
    report.saved_to = Some(output_path.to_string_lossy().to_string());
    let json = serde_json::to_vec_pretty(&report)
        .map_err(|error| format!("Failed to serialize calibration report: {error}"))?;
    std::fs::write(&output_path, json)
        .map_err(|error| format!("Failed to save local calibration report: {error}"))?;
    std::fs::copy(&output_path, &latest_path)
        .map_err(|error| format!("Failed to update latest local calibration report: {error}"))?;

    if report.passed && matches!(kind, CalibrationKind::TimingStress) {
        keyboard::set_input_timing(report.recommended_input_timing);
    }
    Ok(report)
}

fn calibration_kind_slug(kind: CalibrationKind) -> &'static str {
    match kind {
        CalibrationKind::PitchSweep => "pitch-sweep",
        CalibrationKind::TimingStress => "timing-stress",
        CalibrationKind::Drift => "drift",
    }
}

pub fn cancel_konghou_calibration() {
    CALIBRATION_CANCELLED.store(true, Ordering::SeqCst);
}

fn build_schedule(kind: CalibrationKind, default_timing: InputTiming) -> Vec<ScheduledAction> {
    match kind {
        CalibrationKind::PitchSweep => (48u8..=83)
            .enumerate()
            .map(|(index, note)| ScheduledAction {
                scheduled_us: 750_000 + index as u64 * 450_000,
                notes: vec![note],
                timing: InputTiming {
                    tap_ms: 20,
                    ..default_timing
                },
                rate_group: None,
                timing_probe: None,
            })
            .collect(),
        CalibrationKind::TimingStress => {
            let mut actions = Vec::new();
            let mut cursor = 750_000u64;
            for tap_ms in [5, 10, 20, 40, 80, 160] {
                actions.push(ScheduledAction {
                    scheduled_us: cursor,
                    notes: vec![60],
                    timing: InputTiming {
                        tap_ms,
                        ..default_timing
                    },
                    rate_group: None,
                    timing_probe: Some(TimingProbe::Tap(tap_ms)),
                });
                cursor += 700_000;
            }
            for lead_ms in [0, 1, 2, 4, 8, 12] {
                actions.push(ScheduledAction {
                    scheduled_us: cursor,
                    notes: vec![61],
                    timing: InputTiming {
                        modifier_lead_ms: lead_ms,
                        tap_ms: 20,
                        ..default_timing
                    },
                    rate_group: None,
                    timing_probe: Some(TimingProbe::ModifierLead(lead_ms)),
                });
                cursor += 700_000;
            }
            for release_ms in [0, 1, 2, 4, 8, 12] {
                actions.push(ScheduledAction {
                    scheduled_us: cursor,
                    notes: vec![61],
                    timing: InputTiming {
                        tap_ms: 20,
                        modifier_release_ms: release_ms,
                        ..default_timing
                    },
                    rate_group: None,
                    timing_probe: Some(TimingProbe::ModifierRelease(release_ms)),
                });
                cursor += 700_000;
            }
            for rate in [4u32, 6, 8, 10, 12, 15] {
                cursor += 600_000;
                let interval = 1_000_000 / rate as u64;
                for index in 0..12u64 {
                    actions.push(ScheduledAction {
                        scheduled_us: cursor + index * interval,
                        notes: vec![48 + (index % 12) as u8],
                        timing: InputTiming {
                            tap_ms: default_timing.tap_ms.max(12),
                            ..default_timing
                        },
                        rate_group: Some(rate),
                        timing_probe: None,
                    });
                }
                cursor += 12 * interval;
            }
            cursor += 750_000;
            for notes in [vec![60, 64], vec![60, 64, 67], vec![61, 66, 70]] {
                actions.push(ScheduledAction {
                    scheduled_us: cursor,
                    notes,
                    timing: InputTiming {
                        tap_ms: default_timing.tap_ms.max(20),
                        ..default_timing
                    },
                    rate_group: None,
                    timing_probe: None,
                });
                cursor += 1_000_000;
            }
            actions
        }
        CalibrationKind::Drift => (0..300u64)
            .map(|index| ScheduledAction {
                scheduled_us: 1_000_000 + index * 1_000_000,
                notes: vec![if index % 2 == 0 { 60 } else { 67 }],
                timing: InputTiming {
                    tap_ms: default_timing.tap_ms.max(12),
                    ..default_timing
                },
                rate_group: None,
                timing_probe: None,
            })
            .collect(),
    }
}

#[cfg(target_os = "windows")]
fn capture_loopback(
    duration: Duration,
    ready: std::sync::mpsc::SyncSender<Result<Instant, String>>,
) -> Result<CapturedAudio, String> {
    let result = capture_loopback_inner(duration, &ready);
    if let Err(error) = &result {
        let _ = ready.try_send(Err(error.clone()));
    }
    result
}

#[cfg(target_os = "windows")]
fn capture_loopback_inner(
    duration: Duration,
    ready: &std::sync::mpsc::SyncSender<Result<Instant, String>>,
) -> Result<CapturedAudio, String> {
    use std::collections::VecDeque;
    use wasapi::{initialize_mta, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat};

    initialize_mta()
        .ok()
        .map_err(|error| format!("Failed to initialize WASAPI COM: {error}"))?;
    let enumerator = DeviceEnumerator::new()
        .map_err(|error| format!("Failed to enumerate audio devices: {error}"))?;
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|error| format!("No default Windows render device is available: {error}"))?;
    let mut client = device
        .get_iaudioclient()
        .map_err(|error| format!("Failed to open the Windows render device: {error}"))?;
    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        SAMPLE_RATE as usize,
        CHANNELS,
        None,
    );
    let (_, minimum_period) = client
        .get_device_period()
        .map_err(|error| format!("Failed to query WASAPI device timing: {error}"))?;
    client
        .initialize_client(
            &format,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: true,
                buffer_duration_hns: minimum_period,
            },
        )
        .map_err(|error| format!("Failed to initialize WASAPI loopback: {error}"))?;
    let event = client
        .set_get_eventhandle()
        .map_err(|error| format!("Failed to create the WASAPI capture event: {error}"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|error| format!("Failed to create the WASAPI capture client: {error}"))?;
    let mut bytes = VecDeque::new();
    client
        .start_stream()
        .map_err(|error| format!("Failed to start WASAPI loopback: {error}"))?;
    let started = Instant::now();
    ready
        .send(Ok(started))
        .map_err(|_| "Calibration was cancelled before WASAPI became ready.".to_string())?;
    while started.elapsed() < duration && !CALIBRATION_CANCELLED.load(Ordering::SeqCst) {
        let _ = event.wait_for_event(100);
        capture
            .read_from_device_to_deque(&mut bytes)
            .map_err(|error| format!("WASAPI loopback read failed: {error}"))?;
    }
    client
        .stop_stream()
        .map_err(|error| format!("Failed to stop WASAPI loopback: {error}"))?;

    let bytes: Vec<u8> = bytes.into_iter().collect();
    let mut mono_samples = Vec::with_capacity(bytes.len() / (4 * CHANNELS));
    for frame in bytes.chunks_exact(4 * CHANNELS) {
        let mut sum = 0.0f32;
        for channel in 0..CHANNELS {
            let start = channel * 4;
            sum += f32::from_le_bytes(frame[start..start + 4].try_into().unwrap());
        }
        mono_samples.push(sum / CHANNELS as f32);
    }

    Ok(CapturedAudio {
        mono_samples,
        sample_rate: SAMPLE_RATE,
    })
}

#[cfg(not(target_os = "windows"))]
fn capture_loopback(
    _duration: Duration,
    ready: std::sync::mpsc::SyncSender<Result<Instant, String>>,
) -> Result<CapturedAudio, String> {
    let error = "Konghou calibration requires Windows WASAPI loopback.".to_string();
    let _ = ready.send(Err(error.clone()));
    Err(error)
}

fn analyze_capture(
    kind: CalibrationKind,
    performed: &[PerformedAction],
    captured: &CapturedAudio,
    current_timing: InputTiming,
    capture_anchor_offset_us: u64,
) -> CalibrationReport {
    let mut raw_measurements = Vec::new();
    let mut chord_spreads = Vec::new();
    let mut rate_results: std::collections::BTreeMap<u32, Vec<bool>> =
        std::collections::BTreeMap::new();
    let mut tap_results: std::collections::BTreeMap<u64, Vec<bool>> =
        std::collections::BTreeMap::new();
    let mut modifier_lead_results: std::collections::BTreeMap<u64, Vec<bool>> =
        std::collections::BTreeMap::new();
    let mut modifier_release_results: std::collections::BTreeMap<u64, Vec<bool>> =
        std::collections::BTreeMap::new();

    for action in performed {
        let mut chord_onsets = Vec::new();
        let expected_capture_us = action
            .scheduled
            .scheduled_us
            .saturating_add(capture_anchor_offset_us);
        for note in &action.scheduled.notes {
            let expected_hz = midi_frequency(*note);
            let onset = find_tone_onset(
                &captured.mono_samples,
                captured.sample_rate,
                expected_capture_us,
                expected_hz,
            );
            let (detected_hz, cents_error, rms) = onset
                .and_then(|onset_us| {
                    chord_onsets.push(onset_us);
                    pitch_at(
                        &captured.mono_samples,
                        captured.sample_rate,
                        onset_us + 35_000,
                    )
                    .map(|(frequency, rms)| {
                        let cents = 1200.0 * (frequency / expected_hz).log2();
                        (Some(frequency), Some(cents), rms)
                    })
                })
                .unwrap_or((None, None, 0.0));
            let latency_ms =
                onset.map(|value| (value as i64 - expected_capture_us as i64) as f64 / 1000.0);
            let accepted = action.input.success;
            let passed = accepted
                && detected_hz.is_some()
                && cents_error.is_some_and(|cents| cents.abs() <= 35.0);
            raw_measurements.push((
                PitchMeasurement {
                    midi_note: *note,
                    expected_hz,
                    detected_hz,
                    cents_error,
                    onset_latency_ms: latency_ms,
                    relative_onset_error_ms: None,
                    rms,
                    uses_modifier: map_exact_36(*note as i32, 0, false)
                        .is_ok_and(|mapping| mapping.key.contains('+')),
                    accepted_by_input_api: accepted,
                    passed,
                },
                action.scheduled.rate_group,
                action.scheduled.timing_probe,
            ));
        }

        if chord_onsets.len() == action.scheduled.notes.len() && chord_onsets.len() > 1 {
            let minimum = *chord_onsets.iter().min().unwrap();
            let maximum = *chord_onsets.iter().max().unwrap();
            chord_spreads.push((maximum - minimum) as f64 / 1000.0);
        }
    }

    let latencies = raw_measurements
        .iter()
        .filter_map(|(measurement, _, _)| measurement.onset_latency_ms)
        .collect::<Vec<_>>();
    let median_latency = percentile(&latencies, 0.5);
    let mut relative_errors = Vec::new();
    for (measurement, rate, probe) in &mut raw_measurements {
        if let (Some(latency), Some(median)) = (measurement.onset_latency_ms, median_latency) {
            let relative = latency - median;
            measurement.relative_onset_error_ms = Some(relative);
            relative_errors.push(relative.abs());
        }
        if let Some(rate) = rate {
            rate_results
                .entry(*rate)
                .or_default()
                .push(measurement.passed);
        }
        match probe {
            Some(TimingProbe::Tap(milliseconds)) => tap_results
                .entry(*milliseconds)
                .or_default()
                .push(measurement.passed),
            Some(TimingProbe::ModifierLead(milliseconds)) => modifier_lead_results
                .entry(*milliseconds)
                .or_default()
                .push(measurement.passed),
            Some(TimingProbe::ModifierRelease(milliseconds)) => modifier_release_results
                .entry(*milliseconds)
                .or_default()
                .push(measurement.passed),
            None => {}
        }
    }

    let measurements = raw_measurements
        .into_iter()
        .map(|(measurement, _, _)| measurement)
        .collect::<Vec<_>>();
    let detected_note_count = measurements
        .iter()
        .filter(|measurement| measurement.detected_hz.is_some())
        .count();
    let correct_pitch_count = measurements
        .iter()
        .filter(|measurement| measurement.passed)
        .count();
    let modifier = measurements
        .iter()
        .filter(|measurement| measurement.uses_modifier)
        .collect::<Vec<_>>();
    let modifier_reliable_count = modifier
        .iter()
        .filter(|measurement| measurement.passed)
        .count();
    let notes_accepted_by_api = performed
        .iter()
        .map(|action| action.input.notes_accepted_by_api)
        .sum();
    let input_failures = performed
        .iter()
        .filter(|action| !action.input.success)
        .count();
    let maximum_clean_rate = rate_results
        .iter()
        .filter(|(_, results)| results.iter().all(|passed| *passed))
        .map(|(rate, _)| *rate)
        .max();
    let certified_rate_onset_recall_percent = maximum_clean_rate
        .and_then(|rate| rate_results.get(&rate))
        .map(|results| {
            results.iter().filter(|passed| **passed).count() as f64 / results.len().max(1) as f64
                * 100.0
        });
    let minimum_clean_tap_ms = minimum_passing_probe(&tap_results);
    let minimum_reliable_modifier_lead_ms = minimum_passing_probe(&modifier_lead_results);
    let minimum_reliable_modifier_release_ms = minimum_passing_probe(&modifier_release_results);
    let p95_relative = percentile(&relative_errors, 0.95);
    let cumulative_drift = if matches!(kind, CalibrationKind::Drift) {
        measurements
            .first()
            .and_then(|first| first.onset_latency_ms)
            .zip(measurements.last().and_then(|last| last.onset_latency_ms))
            .map(|(first, last)| last - first)
    } else {
        None
    };
    let p95_chord_spread = percentile(&chord_spreads, 0.95);
    let expected_chord_measurements = performed
        .iter()
        .filter(|action| action.scheduled.notes.len() > 1)
        .count();
    let all_chords_measured = chord_spreads.len() == expected_chord_measurements;
    let extra_note_count = count_unmatched_onsets(
        &captured.mono_samples,
        captured.sample_rate,
        performed,
        capture_anchor_offset_us,
    );
    let onset_recall_percent = if measurements.is_empty() {
        0.0
    } else {
        detected_note_count as f64 / measurements.len() as f64 * 100.0
    };

    let passed = match kind {
        CalibrationKind::PitchSweep => {
            correct_pitch_count == 36
                && modifier_reliable_count == modifier.len()
                && extra_note_count == 0
        }
        CalibrationKind::TimingStress => {
            input_failures == 0
                && minimum_clean_tap_ms.is_some()
                && minimum_reliable_modifier_lead_ms.is_some()
                && minimum_reliable_modifier_release_ms.is_some()
                && certified_rate_onset_recall_percent == Some(100.0)
                && p95_relative.is_some_and(|value| value <= 25.0)
                && all_chords_measured
                && p95_chord_spread.is_some_and(|value| value <= 25.0)
        }
        CalibrationKind::Drift => {
            onset_recall_percent == 100.0
                && cumulative_drift.is_some_and(|value| value.abs() < 20.0)
        }
    };

    let recommended_timing = InputTiming {
        modifier_lead_ms: if matches!(kind, CalibrationKind::TimingStress) {
            minimum_reliable_modifier_lead_ms.unwrap_or(current_timing.modifier_lead_ms)
        } else {
            current_timing.modifier_lead_ms
        },
        tap_ms: if matches!(kind, CalibrationKind::TimingStress) {
            minimum_clean_tap_ms.unwrap_or(current_timing.tap_ms)
        } else {
            current_timing.tap_ms
        },
        modifier_release_ms: if matches!(kind, CalibrationKind::TimingStress) {
            minimum_reliable_modifier_release_ms.unwrap_or(current_timing.modifier_release_ms)
        } else {
            current_timing.modifier_release_ms
        },
    };
    let mut messages = Vec::new();
    if !passed {
        messages.push("Calibration did not meet the certification thresholds; existing input timing remains active.".to_string());
    }
    if extra_note_count > 0 {
        messages.push(format!(
            "Detected {extra_note_count} unmatched audio transients. Reduce game music or other system audio and rerun calibration."
        ));
    }

    CalibrationReport {
        profile: InstrumentProfile::wwm_konghou_36(),
        kind,
        passed,
        expected_note_count: measurements.len(),
        detected_note_count,
        correct_pitch_count,
        extra_note_count,
        modifier_note_count: modifier.len(),
        modifier_reliable_count,
        onset_recall_percent,
        median_latency_ms: median_latency,
        p95_relative_onset_error_ms: p95_relative,
        cumulative_drift_ms: cumulative_drift,
        p95_chord_spread_ms: p95_chord_spread,
        maximum_clean_onsets_per_second: maximum_clean_rate,
        certified_rate_onset_recall_percent,
        minimum_clean_tap_ms,
        minimum_reliable_modifier_lead_ms,
        minimum_reliable_modifier_release_ms,
        recommended_input_timing: recommended_timing,
        measurements,
        input_failures,
        notes_confirmed_heard: correct_pitch_count,
        notes_accepted_by_api,
        notes_accepted_but_not_heard: notes_accepted_by_api.saturating_sub(correct_pitch_count),
        saved_to: None,
        messages,
    }
}

fn minimum_passing_probe(results: &std::collections::BTreeMap<u64, Vec<bool>>) -> Option<u64> {
    results
        .iter()
        .find(|(_, attempts)| !attempts.is_empty() && attempts.iter().all(|passed| *passed))
        .map(|(milliseconds, _)| *milliseconds)
}

fn midi_frequency(note: u8) -> f64 {
    440.0 * 2.0f64.powf((note as f64 - 69.0) / 12.0)
}

fn sample_index(sample_rate: u32, time_us: u64) -> usize {
    (time_us as u128 * sample_rate as u128 / 1_000_000) as usize
}

fn find_tone_onset(
    samples: &[f32],
    sample_rate: u32,
    expected_us: u64,
    frequency: f64,
) -> Option<u64> {
    let search_start = sample_index(sample_rate, expected_us.saturating_sub(50_000));
    let search_end = sample_index(sample_rate, expected_us + 300_000).min(samples.len());
    let frame_size = (sample_rate as usize / 100).max(128);
    let hop = frame_size / 4;
    if search_end <= search_start + frame_size {
        return None;
    }
    let baseline_start = search_start.saturating_sub(frame_size * 8);
    let baseline = tone_energy(
        &samples[baseline_start..search_start],
        sample_rate,
        frequency,
    );
    let threshold = (baseline * 4.0).max(0.000_01);

    let mut cursor = search_start;
    while cursor + frame_size <= search_end {
        let energy = tone_energy(
            &samples[cursor..cursor + frame_size],
            sample_rate,
            frequency,
        );
        if energy > threshold {
            return Some(cursor as u64 * 1_000_000 / sample_rate as u64);
        }
        cursor += hop;
    }
    None
}

fn tone_energy(samples: &[f32], sample_rate: u32, frequency: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let omega = 2.0 * std::f64::consts::PI * frequency / sample_rate as f64;
    let coefficient = 2.0 * omega.cos();
    let mut previous = 0.0;
    let mut previous_two = 0.0;
    for sample in samples {
        let current = *sample as f64 + coefficient * previous - previous_two;
        previous_two = previous;
        previous = current;
    }
    let power =
        previous_two * previous_two + previous * previous - coefficient * previous * previous_two;
    power.max(0.0) / (samples.len() * samples.len()) as f64
}

fn pitch_at(samples: &[f32], sample_rate: u32, time_us: u64) -> Option<(f64, f64)> {
    let start = sample_index(sample_rate, time_us);
    let available = samples.get(start..)?;
    let downsample = 2usize;
    let window = 4096usize;
    let signal = available
        .iter()
        .step_by(downsample)
        .take(window)
        .map(|sample| *sample as f64)
        .collect::<Vec<_>>();
    if signal.len() < window {
        return None;
    }
    let mean = signal.iter().sum::<f64>() / signal.len() as f64;
    let signal = signal
        .into_iter()
        .map(|sample| sample - mean)
        .collect::<Vec<_>>();
    let rms =
        (signal.iter().map(|sample| sample * sample).sum::<f64>() / signal.len() as f64).sqrt();
    if rms < 0.0005 {
        return None;
    }

    let reduced_rate = sample_rate as f64 / downsample as f64;
    let minimum_tau = (reduced_rate / 1_200.0).floor().max(2.0) as usize;
    let maximum_tau = (reduced_rate / 100.0).ceil() as usize;
    let mut difference = vec![0.0; maximum_tau + 1];
    for tau in 1..=maximum_tau {
        difference[tau] = signal[..signal.len() - tau]
            .iter()
            .zip(&signal[tau..])
            .map(|(left, right)| {
                let delta = left - right;
                delta * delta
            })
            .sum();
    }
    let mut cumulative = 0.0;
    let mut normalized = vec![1.0; maximum_tau + 1];
    for tau in 1..=maximum_tau {
        cumulative += difference[tau];
        normalized[tau] = if cumulative > 0.0 {
            difference[tau] * tau as f64 / cumulative
        } else {
            1.0
        };
    }

    let mut tau = minimum_tau;
    while tau < maximum_tau {
        if normalized[tau] < 0.18 && normalized[tau] <= normalized[tau + 1] {
            break;
        }
        tau += 1;
    }
    if tau >= maximum_tau {
        tau = (minimum_tau..=maximum_tau)
            .min_by(|left, right| normalized[*left].total_cmp(&normalized[*right]))?;
    }
    let refined_tau = if tau > 1 && tau < maximum_tau {
        let left = normalized[tau - 1];
        let center = normalized[tau];
        let right = normalized[tau + 1];
        let denominator = 2.0 * (2.0 * center - right - left);
        if denominator.abs() > f64::EPSILON {
            tau as f64 + (right - left) / denominator
        } else {
            tau as f64
        }
    } else {
        tau as f64
    };
    Some((reduced_rate / refined_tau, rms))
}

fn count_unmatched_onsets(
    samples: &[f32],
    sample_rate: u32,
    performed: &[PerformedAction],
    capture_anchor_offset_us: u64,
) -> usize {
    let frame = (sample_rate as usize / 100).max(128);
    let hop = frame / 2;
    let mut energies = Vec::new();
    let mut cursor = 0usize;
    while cursor + frame <= samples.len() {
        let rms = (samples[cursor..cursor + frame]
            .iter()
            .map(|sample| *sample as f64 * *sample as f64)
            .sum::<f64>()
            / frame as f64)
            .sqrt();
        energies.push((cursor, rms));
        cursor += hop;
    }
    let baseline = percentile(
        &energies.iter().map(|(_, value)| *value).collect::<Vec<_>>(),
        0.5,
    )
    .unwrap_or(0.0);
    let threshold = (baseline * 4.0).max(0.002);
    let mut onsets = Vec::new();
    let mut last = 0usize;
    for (index, (sample, energy)) in energies.iter().enumerate().skip(1) {
        if *energy > threshold
            && energies[index - 1].1 <= threshold
            && sample.saturating_sub(last) > sample_rate as usize / 10
        {
            onsets.push(*sample as u64 * 1_000_000 / sample_rate as u64);
            last = *sample;
        }
    }

    onsets
        .iter()
        .filter(|onset| {
            !performed.iter().any(|action| {
                let expected = action
                    .scheduled
                    .scheduled_us
                    .saturating_add(capture_anchor_offset_us);
                **onset >= expected.saturating_sub(75_000) && **onset <= expected + 350_000
            })
        })
        .count()
}

fn percentile(values: &[f64], percentile: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() - 1) as f64 * percentile.clamp(0.0, 1.0)).round() as usize;
    sorted.get(index).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn yin_estimator_finds_a_440_hz_tone() {
        let samples = (0..SAMPLE_RATE as usize)
            .map(|index| {
                (2.0 * std::f32::consts::PI * 440.0 * index as f32 / SAMPLE_RATE as f32).sin() * 0.2
            })
            .collect::<Vec<_>>();
        let (frequency, _) = pitch_at(&samples, SAMPLE_RATE, 100_000).unwrap();
        assert!((frequency - 440.0).abs() < 2.0);
    }

    #[test]
    fn pitch_sweep_covers_every_konghou_note_once() {
        let schedule = build_schedule(CalibrationKind::PitchSweep, InputTiming::default());
        assert_eq!(schedule.len(), 36);
        assert_eq!(schedule.first().unwrap().notes, vec![48]);
        assert_eq!(schedule.last().unwrap().notes, vec![83]);
    }

    #[test]
    fn drift_schedule_is_five_minutes() {
        let schedule = build_schedule(CalibrationKind::Drift, InputTiming::default());
        assert_eq!(schedule.len(), 300);
        assert_eq!(schedule.last().unwrap().scheduled_us, 300_000_000);
    }

    #[test]
    fn timing_schedule_sweeps_each_input_timing_dimension() {
        let schedule = build_schedule(CalibrationKind::TimingStress, InputTiming::default());
        assert!(schedule
            .iter()
            .any(|action| action.timing_probe == Some(TimingProbe::Tap(5))));
        assert!(schedule
            .iter()
            .any(|action| action.timing_probe == Some(TimingProbe::ModifierLead(0))));
        assert!(schedule
            .iter()
            .any(|action| action.timing_probe == Some(TimingProbe::ModifierRelease(12))));
    }

    #[test]
    fn minimum_passing_probe_uses_the_smallest_fully_reliable_value() {
        let results = std::collections::BTreeMap::from([
            (0, vec![false]),
            (1, vec![true, false]),
            (2, vec![true, true]),
            (4, vec![true, true]),
        ]);
        assert_eq!(minimum_passing_probe(&results), Some(2));
    }
}
