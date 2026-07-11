use crate::instrument::{key_uses_modifier, map_exact_36, InstrumentProfile};
use crate::scheduler::{HighResolutionWaiter, TimelineAnchor};
use midly::{Format, MetaMessage, MidiMessage, Smf, Timing, TrackEventKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Window};

const DEFAULT_TEMPO_US_PER_QUARTER: u32 = 500_000;
const PLAYBACK_PRE_ROLL: Duration = Duration::from_millis(150);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum NoteMode {
    Closest = 0,
    Quantize = 1,
    TransposeOnly = 2,
    Pentatonic = 3,
    Chromatic = 4,
    Raw = 5,
    Python = 6,
    Wide = 7,
    Sharps = 8,
    Exact = 9,
}

impl From<u8> for NoteMode {
    fn from(value: u8) -> Self {
        match value {
            0 => Self::Closest,
            1 => Self::Quantize,
            2 => Self::TransposeOnly,
            3 => Self::Pentatonic,
            4 => Self::Chromatic,
            5 => Self::Raw,
            6 => Self::Python,
            7 => Self::Wide,
            8 => Self::Sharps,
            9 => Self::Exact,
            _ => Self::Exact,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum KeyMode {
    Keys21 = 0,
    Keys36 = 1,
}

impl From<u8> for KeyMode {
    fn from(value: u8) -> Self {
        match value {
            0 => Self::Keys21,
            1 => Self::Keys36,
            _ => Self::Keys36,
        }
    }
}

#[derive(Debug, Clone)]
pub enum BandFilter {
    Split { slot: usize, total_players: usize },
    Track { track_id: usize },
}

#[derive(Debug, Clone)]
pub struct MidiData {
    pub source_path: String,
    pub events: Vec<TimedEvent>,
    pub duration: f64,
    pub duration_us: u64,
    pub tempo_change_count: usize,
    pub percussion_note_count: usize,
    pub format_name: String,
    pub timing_name: String,
    pub tracks: Vec<MidiTrackInfo>,
    pub recommended_track_id: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimedEvent {
    pub time_us: u64,
    pub event_type: EventType,
    pub note: u8,
    pub velocity: u8,
    pub channel: u8,
    pub track_id: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventType {
    NoteOn,
    NoteOff,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiMetadata {
    pub duration: f64,
    pub bpm: u16,
    pub note_count: u32,
    pub note_density: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MidiTrackInfo {
    pub id: usize,
    pub name: String,
    pub note_count: u32,
    pub channel: Option<u8>,
    pub melody_score: f64,
    pub recommended: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityIssue {
    pub code: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatibilityReport {
    pub source_path: String,
    pub profile: InstrumentProfile,
    pub supported: bool,
    pub score: u8,
    pub expected_quality: String,
    pub smf_format: String,
    pub timing: String,
    pub duration_us: u64,
    pub note_count: usize,
    pub playable_note_count: usize,
    pub percussion_note_count: usize,
    pub track_count: usize,
    pub recommended_track_id: Option<usize>,
    pub recommended_track_name: Option<String>,
    pub tempo_change_count: usize,
    pub out_of_range_note_count: usize,
    pub octave_fitted_note_count: usize,
    pub modifier_note_count: usize,
    pub maximum_chord_size: usize,
    pub peak_onsets_per_second: usize,
    pub predicted_removed_note_count: usize,
    pub issues: Vec<CompatibilityIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlannedChord {
    pub time_us: u64,
    pub keys: Vec<String>,
    pub source_notes: Vec<u8>,
    pub track_ids: Vec<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackPlan {
    pub source_path: String,
    pub profile: InstrumentProfile,
    pub events: Vec<PlannedChord>,
    pub duration_us: u64,
    pub explicit_transpose: i8,
    pub octave_fit: bool,
    pub compatibility: CompatibilityReport,
}

#[derive(Debug, Clone, Default)]
struct PlaybackDiagnostics {
    notes_attempted: u64,
    notes_accepted_by_api: u64,
    notes_filtered: u64,
    input_failures: u64,
    max_relative_onset_error_ms: f64,
    total_relative_onset_error_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
struct PlaybackDiagnosticEvent {
    reason: String,
    notes_attempted: u64,
    notes_accepted_by_api: u64,
    notes_confirmed_heard: u64,
    notes_filtered: u64,
    input_failures: u64,
    average_relative_onset_error_ms: f64,
    max_relative_onset_error_ms: f64,
}

#[derive(Debug, Clone, Copy)]
struct TempoSegment {
    start_tick: u64,
    start_us: u64,
    tempo_us_per_quarter: u32,
}

#[derive(Debug, Clone)]
struct TempoMap {
    ticks_per_quarter: u64,
    segments: Vec<TempoSegment>,
    initial_tempo: u32,
    change_count: usize,
}

impl TempoMap {
    fn new(ticks_per_quarter: u64, changes: &[(u64, u32, usize, usize)]) -> Self {
        let mut ordered = changes.to_vec();
        ordered.sort_by_key(|(tick, _, track, order)| (*tick, *track, *order));

        let mut segments = vec![TempoSegment {
            start_tick: 0,
            start_us: 0,
            tempo_us_per_quarter: DEFAULT_TEMPO_US_PER_QUARTER,
        }];
        let mut current_tick = 0;
        let mut current_us: u64 = 0;
        let mut current_tempo = DEFAULT_TEMPO_US_PER_QUARTER;

        for (tick, tempo, _, _) in &ordered {
            if *tick > current_tick {
                current_us = current_us.saturating_add(ticks_to_us_exact(
                    *tick - current_tick,
                    current_tempo,
                    ticks_per_quarter,
                ));
                current_tick = *tick;
            }
            current_tempo = *tempo;
            if let Some(last) = segments
                .last_mut()
                .filter(|segment| segment.start_tick == *tick)
            {
                last.start_us = current_us;
                last.tempo_us_per_quarter = *tempo;
            } else {
                segments.push(TempoSegment {
                    start_tick: *tick,
                    start_us: current_us,
                    tempo_us_per_quarter: *tempo,
                });
            }
        }

        let initial_tempo = segments
            .iter()
            .rev()
            .find(|segment| segment.start_tick == 0)
            .map(|segment| segment.tempo_us_per_quarter)
            .unwrap_or(DEFAULT_TEMPO_US_PER_QUARTER);

        Self {
            ticks_per_quarter,
            segments,
            initial_tempo,
            change_count: ordered.len(),
        }
    }

    fn ticks_to_us(&self, tick: u64) -> u64 {
        let index = self
            .segments
            .partition_point(|segment| segment.start_tick <= tick)
            .saturating_sub(1);
        let segment = self.segments[index];
        segment.start_us.saturating_add(ticks_to_us_exact(
            tick.saturating_sub(segment.start_tick),
            segment.tempo_us_per_quarter,
            self.ticks_per_quarter,
        ))
    }
}

fn ticks_to_us_exact(ticks: u64, tempo_us_per_quarter: u32, ticks_per_quarter: u64) -> u64 {
    ((ticks as u128 * tempo_us_per_quarter as u128) / ticks_per_quarter.max(1) as u128)
        .min(u64::MAX as u128) as u64
}

fn emit_playback_diagnostics(window: &Window, diagnostics: &PlaybackDiagnostics, reason: &str) {
    let average = if diagnostics.notes_attempted > 0 {
        diagnostics.total_relative_onset_error_ms / diagnostics.notes_attempted as f64
    } else {
        0.0
    };
    let _ = window.emit(
        "playback-diagnostics",
        PlaybackDiagnosticEvent {
            reason: reason.to_string(),
            notes_attempted: diagnostics.notes_attempted,
            notes_accepted_by_api: diagnostics.notes_accepted_by_api,
            notes_confirmed_heard: 0,
            notes_filtered: diagnostics.notes_filtered,
            input_failures: diagnostics.input_failures,
            average_relative_onset_error_ms: average,
            max_relative_onset_error_ms: diagnostics.max_relative_onset_error_ms,
        },
    );
}

pub fn get_midi_metadata(path: &str) -> Result<MidiMetadata, String> {
    let data = load_midi(path)?;
    let note_count = data
        .events
        .iter()
        .filter(|event| event.event_type == EventType::NoteOn)
        .count() as u32;
    let note_density = if data.duration > 0.0 {
        note_count as f32 / data.duration as f32
    } else {
        0.0
    };
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let smf = Smf::parse(&bytes).map_err(|error| format!("Invalid MIDI file: {error}"))?;
    let (_, tempo_map) = validated_timing_and_tempo(&smf)?;
    let bpm = (60_000_000.0 / tempo_map.initial_tempo as f64).round() as u16;

    Ok(MidiMetadata {
        duration: data.duration,
        bpm,
        note_count,
        note_density,
    })
}

pub fn get_midi_tracks(path: &str) -> Result<Vec<MidiTrackInfo>, String> {
    Ok(load_midi(path)?.tracks)
}

pub fn load_midi(path: &str) -> Result<MidiData, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let smf = Smf::parse(&bytes).map_err(|error| format!("Invalid MIDI file: {error}"))?;
    parse_smf(&smf, path)
}

fn validated_timing_and_tempo(smf: &Smf<'_>) -> Result<(u64, TempoMap), String> {
    match smf.header.format {
        Format::SingleTrack | Format::Parallel => {}
        Format::Sequential => {
            return Err(
                "SMF format 2 contains independent sequences and cannot be played as one Konghou timeline. Convert it to MIDI format 0 or 1 first."
                    .to_string(),
            )
        }
    }

    let ticks_per_quarter = match smf.header.timing {
        Timing::Metrical(value) => value.as_int() as u64,
        Timing::Timecode(_, _) => {
            return Err(
                "SMPTE-timed MIDI is not supported for exact Konghou scheduling. Convert it to metrical PPQN timing first."
                    .to_string(),
            )
        }
    };

    let mut changes = Vec::new();
    for (track_index, track) in smf.tracks.iter().enumerate() {
        let mut tick = 0u64;
        for (event_index, event) in track.iter().enumerate() {
            tick = tick.saturating_add(event.delta.as_int() as u64);
            if let TrackEventKind::Meta(MetaMessage::Tempo(tempo)) = event.kind {
                changes.push((tick, tempo.as_int(), track_index, event_index));
            }
        }
    }

    Ok((
        ticks_per_quarter,
        TempoMap::new(ticks_per_quarter, &changes),
    ))
}

fn parse_smf(smf: &Smf<'_>, path: &str) -> Result<MidiData, String> {
    let (_, tempo_map) = validated_timing_and_tempo(smf)?;
    let mut events = Vec::new();
    let mut percussion_note_count = 0usize;
    let mut max_tick = 0u64;
    let mut track_names = HashMap::new();

    for (track_index, track) in smf.tracks.iter().enumerate() {
        let mut tick = 0u64;
        for event in track {
            tick = tick.saturating_add(event.delta.as_int() as u64);
            max_tick = max_tick.max(tick);

            match event.kind {
                TrackEventKind::Meta(MetaMessage::TrackName(name)) => {
                    track_names.insert(
                        track_index,
                        clean_track_name(&String::from_utf8_lossy(name)),
                    );
                }
                TrackEventKind::Meta(MetaMessage::InstrumentName(name)) => {
                    track_names
                        .entry(track_index)
                        .or_insert_with(|| clean_track_name(&String::from_utf8_lossy(name)));
                }
                TrackEventKind::Midi { channel, message } => {
                    let channel = channel.as_int();
                    let time_us = tempo_map.ticks_to_us(tick);
                    match message {
                        MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                            if channel == 9 {
                                percussion_note_count += 1;
                            }
                            events.push(TimedEvent {
                                time_us,
                                event_type: EventType::NoteOn,
                                note: key.as_int(),
                                velocity: vel.as_int(),
                                channel,
                                track_id: track_index,
                            });
                        }
                        MidiMessage::NoteOn { key, .. } | MidiMessage::NoteOff { key, .. } => {
                            events.push(TimedEvent {
                                time_us,
                                event_type: EventType::NoteOff,
                                note: key.as_int(),
                                velocity: 0,
                                channel,
                                track_id: track_index,
                            });
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
    }

    events.sort_by_key(|event| {
        (
            event.time_us,
            if event.event_type == EventType::NoteOff {
                0
            } else {
                1
            },
            event.track_id,
            event.note,
        )
    });

    let duration_us = tempo_map.ticks_to_us(max_tick);
    let mut tracks = score_tracks(&events, &track_names, duration_us);
    let recommended_track_id = tracks
        .iter()
        .max_by(|left, right| {
            left.melody_score
                .total_cmp(&right.melody_score)
                .then_with(|| right.id.cmp(&left.id))
        })
        .map(|track| track.id);
    for track in &mut tracks {
        track.recommended = Some(track.id) == recommended_track_id;
    }

    Ok(MidiData {
        source_path: path.to_string(),
        events,
        duration: duration_us as f64 / 1_000_000.0,
        duration_us,
        tempo_change_count: tempo_map.change_count,
        percussion_note_count,
        format_name: match smf.header.format {
            Format::SingleTrack => "SMF 0",
            Format::Parallel => "SMF 1",
            Format::Sequential => "SMF 2",
        }
        .to_string(),
        timing_name: format!("PPQN {}", tempo_map.ticks_per_quarter),
        tracks,
        recommended_track_id,
    })
}

fn clean_track_name(raw: &str) -> String {
    raw.chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, ' ' | '-' | '_' | '.' | '(' | ')')
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn score_tracks(
    events: &[TimedEvent],
    track_names: &HashMap<usize, String>,
    duration_us: u64,
) -> Vec<MidiTrackInfo> {
    let mut grouped: BTreeMap<usize, Vec<&TimedEvent>> = BTreeMap::new();
    for event in events
        .iter()
        .filter(|event| event.event_type == EventType::NoteOn && event.channel != 9)
    {
        grouped.entry(event.track_id).or_default().push(event);
    }

    grouped
        .into_iter()
        .map(|(track_id, notes)| {
            let note_count = notes.len();
            let unique_onsets = notes
                .iter()
                .map(|event| event.time_us)
                .collect::<HashSet<_>>()
                .len();
            let monophony = unique_onsets as f64 / note_count.max(1) as f64;
            let average_pitch =
                notes.iter().map(|event| event.note as f64).sum::<f64>() / note_count.max(1) as f64;
            let continuity = if notes.len() > 1 {
                let average_interval = notes
                    .windows(2)
                    .map(|pair| (pair[1].note as i32 - pair[0].note as i32).abs() as f64)
                    .sum::<f64>()
                    / (notes.len() - 1) as f64;
                1.0 / (1.0 + average_interval / 12.0)
            } else {
                0.5
            };
            let density = note_count as f64 / (duration_us as f64 / 1_000_000.0).max(1.0);
            let density_score = if density <= 12.0 {
                1.0
            } else {
                (12.0 / density).clamp(0.0, 1.0)
            };
            let pitch_score = ((average_pitch - 36.0) / 60.0).clamp(0.0, 1.0);
            let count_score = (note_count as f64 / 500.0).clamp(0.0, 1.0);
            let melody_score = monophony * 40.0
                + continuity * 25.0
                + pitch_score * 15.0
                + density_score * 10.0
                + count_score * 10.0;
            let channels: HashSet<u8> = notes.iter().map(|event| event.channel).collect();

            MidiTrackInfo {
                id: track_id,
                name: track_names
                    .get(&track_id)
                    .filter(|name| !name.is_empty())
                    .cloned()
                    .unwrap_or_else(|| format!("Track {}", track_id + 1)),
                note_count: note_count as u32,
                channel: (channels.len() == 1)
                    .then(|| *channels.iter().next().expect("one channel exists")),
                melody_score,
                recommended: false,
            }
        })
        .collect()
}

#[allow(dead_code)]
pub fn analyze_midi(
    path: &str,
    transpose_semitones: i8,
    octave_fit: bool,
) -> Result<CompatibilityReport, String> {
    let data = load_midi(path)?;
    Ok(build_playback_plan(
        &data,
        transpose_semitones,
        octave_fit,
        KeyMode::Keys36,
        NoteMode::Exact,
        None,
    )?
    .compatibility)
}

pub fn build_playback_plan(
    data: &MidiData,
    transpose_semitones: i8,
    octave_fit: bool,
    key_mode: KeyMode,
    note_mode: NoteMode,
    band_filter: Option<BandFilter>,
) -> Result<PlaybackPlan, String> {
    let profile = InstrumentProfile::wwm_konghou_36();
    let raw_notes: Vec<TimedEvent> = data
        .events
        .iter()
        .copied()
        .filter(|event| event.event_type == EventType::NoteOn && event.channel != 9)
        .collect();

    if raw_notes.is_empty() {
        return Err(
            "This MIDI has no pitched notes after General MIDI percussion is excluded.".to_string(),
        );
    }

    let selected = select_single_instrument_voice(
        &raw_notes,
        data.recommended_track_id,
        profile.max_clean_polyphony,
        band_filter,
    );

    let mut chords: BTreeMap<u64, Vec<TimedEvent>> = BTreeMap::new();
    for event in selected {
        chords.entry(event.time_us).or_default().push(event);
    }

    let mut planned = Vec::new();
    let mut fitted_count = 0usize;
    let mut modifier_count = 0usize;

    for (time_us, events) in chords {
        let mut keys = Vec::new();
        let mut source_notes = Vec::new();
        let mut track_ids = Vec::new();
        let mut seen_keys = HashSet::new();

        for event in events {
            let key = map_note_to_key(
                event.note as i32,
                transpose_semitones as i32,
                note_mode,
                key_mode,
                octave_fit,
            )?;
            if !seen_keys.insert(key.clone()) {
                continue;
            }
            if key_uses_modifier(&key) {
                modifier_count += 1;
            }
            if key_mode == KeyMode::Keys36 {
                let mapping =
                    map_exact_36(event.note as i32, transpose_semitones as i32, octave_fit)?;
                if mapping.octave_adjustment != 0 {
                    fitted_count += 1;
                }
            }
            keys.push(key);
            source_notes.push(event.note);
            track_ids.push(event.track_id);
        }

        if !keys.is_empty() {
            planned.push(PlannedChord {
                time_us,
                keys,
                source_notes,
                track_ids,
            });
        }
    }

    let playable_note_count = planned.iter().map(|chord| chord.keys.len()).sum::<usize>();
    let maximum_chord_size = raw_notes_by_time(&raw_notes)
        .values()
        .map(Vec::len)
        .max()
        .unwrap_or(0);
    let peak_onsets_per_second = peak_onset_rate(&raw_notes);
    let out_of_range_note_count = raw_notes
        .iter()
        .filter(|event| {
            let note = event.note as i32 + transpose_semitones as i32;
            !(profile.minimum_midi_note as i32..=profile.maximum_midi_note as i32).contains(&note)
        })
        .count();
    let predicted_removed_note_count = raw_notes.len().saturating_sub(playable_note_count);
    let mut issues = build_compatibility_issues(
        data,
        raw_notes.len(),
        predicted_removed_note_count,
        out_of_range_note_count,
        maximum_chord_size,
        peak_onsets_per_second,
        &profile,
        octave_fit,
    );
    if key_mode == KeyMode::Keys21 {
        issues.push(CompatibilityIssue {
            code: "legacy-21-key-transform".to_string(),
            severity: "warning".to_string(),
            message: "21-key mode is a legacy creative transform and is not pitch-exact for Konghou accidentals."
                .to_string(),
        });
    }

    let score = compatibility_score(
        raw_notes.len(),
        predicted_removed_note_count,
        data.percussion_note_count,
        maximum_chord_size,
        peak_onsets_per_second,
        &profile,
    );
    let expected_quality = match score {
        90..=100 => "excellent",
        75..=89 => "good",
        55..=74 => "limited",
        _ => "poor",
    }
    .to_string();
    let recommended_track_name = data.recommended_track_id.and_then(|id| {
        data.tracks
            .iter()
            .find(|track| track.id == id)
            .map(|track| track.name.clone())
    });

    let report = CompatibilityReport {
        source_path: data.source_path.clone(),
        profile: profile.clone(),
        supported: playable_note_count > 0 && score >= 35,
        score,
        expected_quality,
        smf_format: data.format_name.clone(),
        timing: data.timing_name.clone(),
        duration_us: data.duration_us,
        note_count: raw_notes.len(),
        playable_note_count,
        percussion_note_count: data.percussion_note_count,
        track_count: data.tracks.len(),
        recommended_track_id: data.recommended_track_id,
        recommended_track_name,
        tempo_change_count: data.tempo_change_count,
        out_of_range_note_count,
        octave_fitted_note_count: fitted_count,
        modifier_note_count: modifier_count,
        maximum_chord_size,
        peak_onsets_per_second,
        predicted_removed_note_count,
        issues,
    };

    Ok(PlaybackPlan {
        source_path: data.source_path.clone(),
        profile,
        events: planned,
        duration_us: data.duration_us,
        explicit_transpose: transpose_semitones,
        octave_fit,
        compatibility: report,
    })
}

fn raw_notes_by_time(notes: &[TimedEvent]) -> BTreeMap<u64, Vec<TimedEvent>> {
    let mut grouped = BTreeMap::new();
    for note in notes {
        grouped
            .entry(note.time_us)
            .or_insert_with(Vec::new)
            .push(*note);
    }
    grouped
}

fn select_single_instrument_voice(
    notes: &[TimedEvent],
    recommended_track_id: Option<usize>,
    max_polyphony: usize,
    band_filter: Option<BandFilter>,
) -> Vec<TimedEvent> {
    let mut filtered = Vec::new();
    match band_filter {
        Some(BandFilter::Track { track_id }) => {
            filtered.extend(
                notes
                    .iter()
                    .copied()
                    .filter(|note| note.track_id == track_id),
            );
        }
        Some(BandFilter::Split {
            slot,
            total_players,
        }) if total_players > 0 => {
            filtered.extend(
                notes
                    .iter()
                    .copied()
                    .enumerate()
                    .filter(|(index, _)| index % total_players == slot)
                    .map(|(_, note)| note),
            );
        }
        _ => filtered.extend_from_slice(notes),
    }

    let has_multiple_tracks = filtered
        .iter()
        .map(|event| event.track_id)
        .collect::<HashSet<_>>()
        .len()
        > 1;
    let mut previous_melody = None;
    let mut selected = Vec::new();

    for (_, mut chord) in raw_notes_by_time(&filtered) {
        if has_multiple_tracks
            && band_filter.is_none()
            && recommended_track_id.is_some()
            && !chord
                .iter()
                .any(|event| Some(event.track_id) == recommended_track_id)
        {
            continue;
        }

        chord.sort_by_key(|event| (event.note, std::cmp::Reverse(event.velocity)));
        chord.dedup_by_key(|event| event.note);
        let preferred: Vec<TimedEvent> = chord
            .iter()
            .copied()
            .filter(|event| Some(event.track_id) == recommended_track_id)
            .collect();
        let pool = if preferred.is_empty() {
            &chord
        } else {
            &preferred
        };
        let melody = choose_continuous_melody(pool, previous_melody);
        previous_melody = melody.map(|event| event.note);

        let mut chosen = Vec::new();
        if let Some(melody) = melody {
            chosen.push(melody);
        }
        if chosen.len() < max_polyphony {
            if let Some(bass) = chord
                .iter()
                .copied()
                .filter(|event| !chosen.iter().any(|chosen| chosen.note == event.note))
                .min_by_key(|event| event.note)
            {
                chosen.push(bass);
            }
        }
        while chosen.len() < max_polyphony {
            let melody_note = chosen.first().map(|event| event.note).unwrap_or(60);
            let Some(inner) = chord
                .iter()
                .copied()
                .filter(|event| !chosen.iter().any(|chosen| chosen.note == event.note))
                .min_by_key(|event| (event.note as i32 - melody_note as i32).abs())
            else {
                break;
            };
            chosen.push(inner);
        }
        chosen.sort_by_key(|event| event.note);
        selected.extend(chosen);
    }

    selected.sort_by_key(|event| (event.time_us, event.note));
    selected
}

fn choose_continuous_melody(
    candidates: &[TimedEvent],
    previous_note: Option<u8>,
) -> Option<TimedEvent> {
    candidates.iter().copied().min_by_key(|event| {
        if let Some(previous) = previous_note {
            (
                (event.note as i32 - previous as i32).abs(),
                std::cmp::Reverse(event.velocity),
                std::cmp::Reverse(event.note),
            )
        } else {
            (
                0,
                std::cmp::Reverse(event.velocity),
                std::cmp::Reverse(event.note),
            )
        }
    })
}

fn peak_onset_rate(notes: &[TimedEvent]) -> usize {
    let mut times = notes.iter().map(|note| note.time_us).collect::<Vec<_>>();
    times.sort_unstable();
    let mut left = 0usize;
    let mut peak = 0usize;
    for right in 0..times.len() {
        while left < right && times[right].saturating_sub(times[left]) >= 1_000_000 {
            left += 1;
        }
        peak = peak.max(right - left + 1);
    }
    peak
}

#[allow(clippy::too_many_arguments)]
fn build_compatibility_issues(
    data: &MidiData,
    note_count: usize,
    removed_count: usize,
    out_of_range_count: usize,
    maximum_chord_size: usize,
    peak_rate: usize,
    profile: &InstrumentProfile,
    octave_fit: bool,
) -> Vec<CompatibilityIssue> {
    let mut issues = Vec::new();
    if data.percussion_note_count > 0 {
        issues.push(CompatibilityIssue {
            code: "gm-percussion-excluded".to_string(),
            severity: "info".to_string(),
            message: format!(
                "{} General MIDI percussion notes on channel 10 will be excluded.",
                data.percussion_note_count
            ),
        });
    }
    if out_of_range_count > 0 {
        issues.push(CompatibilityIssue {
            code: "octave-fit".to_string(),
            severity: if octave_fit { "info" } else { "error" }.to_string(),
            message: if octave_fit {
                format!(
                    "{out_of_range_count} notes require pitch-preserving octave fit in multiples of 12 semitones."
                )
            } else {
                format!(
                    "{out_of_range_count} notes are outside the Konghou range; enable octave fit or change the explicit transpose."
                )
            },
        });
    }
    if maximum_chord_size > profile.max_clean_polyphony {
        issues.push(CompatibilityIssue {
            code: "polyphony-reduction".to_string(),
            severity: "warning".to_string(),
            message: format!(
                "The largest chord has {maximum_chord_size} notes; the current Konghou profile keeps at most {} voices.",
                profile.max_clean_polyphony
            ),
        });
    }
    if peak_rate as f64 > profile.max_clean_onsets_per_second {
        issues.push(CompatibilityIssue {
            code: "onset-density".to_string(),
            severity: "warning".to_string(),
            message: format!(
                "Peak density is {peak_rate} notes/second, above the uncalibrated safe target of {:.0}.",
                profile.max_clean_onsets_per_second
            ),
        });
    }
    if removed_count > 0 {
        issues.push(CompatibilityIssue {
            code: "voice-selection".to_string(),
            severity: if removed_count * 2 > note_count {
                "warning"
            } else {
                "info"
            }
            .to_string(),
            message: format!(
                "Deterministic melody and harmony selection predicts removing {removed_count} of {note_count} pitched notes."
            ),
        });
    }
    if data.tempo_change_count > 1 {
        issues.push(CompatibilityIssue {
            code: "tempo-map-preserved".to_string(),
            severity: "info".to_string(),
            message: format!(
                "All {} tempo events are preserved on the canonical microsecond timeline.",
                data.tempo_change_count
            ),
        });
    }
    issues
}

fn compatibility_score(
    note_count: usize,
    removed_count: usize,
    percussion_count: usize,
    maximum_chord_size: usize,
    peak_rate: usize,
    profile: &InstrumentProfile,
) -> u8 {
    let note_count = note_count.max(1) as f64;
    let removal_penalty = (removed_count as f64 / note_count * 40.0).min(40.0);
    let percussion_penalty = (percussion_count as f64 / note_count * 15.0).min(15.0);
    let chord_penalty = if maximum_chord_size > profile.max_clean_polyphony {
        ((maximum_chord_size - profile.max_clean_polyphony) as f64 * 3.0).min(15.0)
    } else {
        0.0
    };
    let density_penalty = if peak_rate as f64 > profile.max_clean_onsets_per_second {
        (((peak_rate as f64 / profile.max_clean_onsets_per_second) - 1.0) * 10.0).min(20.0)
    } else {
        0.0
    };
    (100.0 - removal_penalty - percussion_penalty - chord_penalty - density_penalty)
        .clamp(0.0, 100.0)
        .round() as u8
}

pub fn map_note_to_key(
    note: i32,
    transpose: i32,
    note_mode: NoteMode,
    key_mode: KeyMode,
    octave_fit: bool,
) -> Result<String, String> {
    if key_mode == KeyMode::Keys36 {
        return map_exact_36(note, transpose, octave_fit).map(|mapping| mapping.key);
    }

    Ok(match note_mode {
        NoteMode::Raw => legacy_raw(note + transpose),
        NoteMode::TransposeOnly => legacy_transpose_only(note, transpose),
        NoteMode::Pentatonic => legacy_pentatonic(note, transpose),
        NoteMode::Chromatic => legacy_chromatic(note, transpose),
        NoteMode::Wide => legacy_wide(note, transpose),
        NoteMode::Closest
        | NoteMode::Quantize
        | NoteMode::Python
        | NoteMode::Sharps
        | NoteMode::Exact => legacy_closest(note, transpose),
    })
}

const NATURAL_NOTES: [i32; 21] = [
    48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83,
];
const LEGACY_KEYS: [&str; 21] = [
    "z", "x", "c", "v", "b", "n", "m", "a", "s", "d", "f", "g", "h", "j", "q", "w", "e", "r", "t",
    "y", "u",
];

fn normalize_legacy(mut note: i32) -> i32 {
    while note < 48 {
        note += 12;
    }
    while note > 83 {
        note -= 12;
    }
    note
}

fn legacy_closest(note: i32, transpose: i32) -> String {
    let target = normalize_legacy(note + transpose);
    let index = NATURAL_NOTES
        .iter()
        .enumerate()
        .min_by_key(|(_, candidate)| (*candidate - target).abs())
        .map(|(index, _)| index)
        .unwrap_or(7);
    LEGACY_KEYS[index].to_string()
}

fn legacy_raw(note: i32) -> String {
    LEGACY_KEYS[note.rem_euclid(21) as usize].to_string()
}

fn legacy_transpose_only(note: i32, transpose: i32) -> String {
    let target = note + transpose;
    let degree = (target.rem_euclid(12) * 7 / 12) as usize;
    let octave = if target < 60 {
        0
    } else if target < 72 {
        1
    } else {
        2
    };
    LEGACY_KEYS[octave * 7 + degree].to_string()
}

fn legacy_pentatonic(note: i32, transpose: i32) -> String {
    let target = normalize_legacy(note + transpose);
    let degree = match target.rem_euclid(12) {
        0 | 1 => 0,
        2 | 3 => 1,
        4..=6 => 2,
        7 | 8 => 4,
        _ => 5,
    };
    let octave = if target < 60 {
        0
    } else if target < 72 {
        1
    } else {
        2
    };
    LEGACY_KEYS[octave * 7 + degree].to_string()
}

fn legacy_chromatic(note: i32, transpose: i32) -> String {
    let target = normalize_legacy(note + transpose);
    let degree = match target.rem_euclid(12) {
        0 | 1 => 0,
        2 => 1,
        3 | 4 => 2,
        5 | 6 => 3,
        7 | 8 => 4,
        9 => 5,
        _ => 6,
    };
    let octave = if target < 60 {
        0
    } else if target < 72 {
        1
    } else {
        2
    };
    LEGACY_KEYS[octave * 7 + degree].to_string()
}

fn legacy_wide(note: i32, transpose: i32) -> String {
    let target = note + transpose;
    let degree = match target.rem_euclid(12) {
        0 => 0,
        1 | 2 => 1,
        3 | 4 => 2,
        5 => 3,
        6 | 7 => 4,
        8 | 9 => 5,
        _ => 6,
    };
    let octave = if target < 54 {
        0
    } else if target < 66 {
        1
    } else {
        2
    };
    LEGACY_KEYS[octave * 7 + degree].to_string()
}

#[allow(clippy::too_many_arguments)]
pub fn play_midi(
    plan: PlaybackPlan,
    is_playing: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    loop_mode: Arc<AtomicBool>,
    speed: Arc<AtomicU16>,
    current_position: Arc<Mutex<f64>>,
    seek_offset: Arc<Mutex<f64>>,
    window: Window,
) {
    let is_playing_progress = Arc::clone(&is_playing);
    let is_paused_progress = Arc::clone(&is_paused);
    let current_position_progress = Arc::clone(&current_position);
    let window_progress = window.clone();
    std::thread::spawn(move || {
        while is_playing_progress.load(Ordering::SeqCst) {
            if !is_paused_progress.load(Ordering::SeqCst) {
                let position = *current_position_progress.lock().unwrap();
                let _ = window_progress.emit("playback-progress", position);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    });

    let waiter = HighResolutionWaiter::new();
    loop {
        let mut diagnostics = PlaybackDiagnostics {
            notes_filtered: plan.compatibility.predicted_removed_note_count as u64,
            ..PlaybackDiagnostics::default()
        };
        let offset_us = (*seek_offset.lock().unwrap() * 1_000_000.0) as u64;
        let initial_speed = speed.load(Ordering::SeqCst) as f64 / 100.0;
        let mut anchor =
            TimelineAnchor::new(Instant::now() + PLAYBACK_PRE_ROLL, offset_us, initial_speed);

        for chord in plan
            .events
            .iter()
            .filter(|event| event.time_us >= offset_us)
        {
            if !is_playing.load(Ordering::SeqCst) {
                let _ = crate::keyboard::release_all_modifiers();
                return;
            }

            loop {
                if !is_playing.load(Ordering::SeqCst) {
                    let _ = crate::keyboard::release_all_modifiers();
                    return;
                }

                if is_paused.load(Ordering::SeqCst) {
                    let paused_at = Instant::now();
                    while is_paused.load(Ordering::SeqCst) && is_playing.load(Ordering::SeqCst) {
                        waiter.sleep_for(Duration::from_millis(20));
                    }
                    anchor.shift_real_anchor(paused_at.elapsed());
                    continue;
                }

                let current_speed = speed.load(Ordering::SeqCst) as f64 / 100.0;
                if (current_speed - anchor.speed()).abs() > f64::EPSILON {
                    anchor.reanchor(Instant::now(), current_speed);
                }

                let deadline = anchor.deadline_for(chord.time_us);
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                waiter.sleep_for((deadline - now).min(Duration::from_millis(20)));
                let song_position = anchor.song_position_us(Instant::now());
                *current_position.lock().unwrap() = song_position as f64 / 1_000_000.0;
            }

            let deadline = anchor.deadline_for(chord.time_us);
            let onset_error_ms = Instant::now()
                .saturating_duration_since(deadline)
                .as_secs_f64()
                * 1000.0;
            diagnostics.notes_attempted += chord.keys.len() as u64;
            diagnostics.total_relative_onset_error_ms += onset_error_ms * chord.keys.len() as f64;
            diagnostics.max_relative_onset_error_ms =
                diagnostics.max_relative_onset_error_ms.max(onset_error_ms);

            let result = crate::keyboard::tap_chord(&chord.keys);
            diagnostics.notes_accepted_by_api += result.notes_accepted_by_api as u64;
            if !result.success {
                diagnostics.input_failures += 1;
            }
            if result.success {
                for key in &chord.keys {
                    let _ = window.emit("note-event", key);
                }
            }
            if diagnostics.notes_attempted % 128 < chord.keys.len() as u64 {
                emit_playback_diagnostics(&window, &diagnostics, "periodic");
            }
            *current_position.lock().unwrap() = chord.time_us as f64 / 1_000_000.0;
        }

        let _ = crate::keyboard::release_all_modifiers();
        emit_playback_diagnostics(&window, &diagnostics, "loop-complete");
        if !loop_mode.load(Ordering::SeqCst) {
            break;
        }
        *seek_offset.lock().unwrap() = 0.0;
        *current_position.lock().unwrap() = 0.0;
    }

    is_playing.store(false, Ordering::SeqCst);
    let _ = window.emit("playback-ended", ());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(time_us: u64, note: u8, track_id: usize, channel: u8) -> TimedEvent {
        TimedEvent {
            time_us,
            event_type: EventType::NoteOn,
            note,
            velocity: 90,
            channel,
            track_id,
        }
    }

    #[test]
    fn tempo_map_is_ppqn_independent_and_preserves_changes() {
        for ppqn in [96, 480, 960] {
            let changes = vec![(ppqn, 1_000_000, 0, 0)];
            let map = TempoMap::new(ppqn, &changes);
            assert_eq!(map.ticks_to_us(ppqn), 500_000);
            assert_eq!(map.ticks_to_us(ppqn * 2), 1_500_000);
        }
    }

    #[test]
    fn exact_36_mode_never_applies_the_old_sharps_shift() {
        for legacy_mode in [
            NoteMode::Python,
            NoteMode::Closest,
            NoteMode::Chromatic,
            NoteMode::TransposeOnly,
            NoteMode::Sharps,
            NoteMode::Exact,
        ] {
            assert_eq!(
                map_note_to_key(60, 0, legacy_mode, KeyMode::Keys36, false).unwrap(),
                "a"
            );
        }
    }

    #[test]
    fn melody_selection_uses_track_context_and_limits_chords() {
        let notes = vec![
            event(0, 36, 0, 0),
            event(0, 48, 0, 0),
            event(0, 60, 1, 0),
            event(0, 64, 1, 0),
            event(0, 67, 1, 0),
            event(500_000, 62, 1, 0),
        ];
        let selected = select_single_instrument_voice(&notes, Some(1), 3, None);
        assert!(selected.iter().any(|note| note.note == 67));
        assert!(selected.iter().any(|note| note.note == 62));
        assert_eq!(selected.iter().filter(|note| note.time_us == 0).count(), 3);
    }

    #[test]
    fn general_midi_percussion_is_not_selected() {
        let notes = [event(0, 60, 0, 0), event(0, 38, 1, 9)];
        let pitched: Vec<_> = notes
            .iter()
            .copied()
            .filter(|note| note.channel != 9)
            .collect();
        let selected = select_single_instrument_voice(&pitched, Some(0), 3, None);
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].note, 60);
    }

    #[test]
    fn peak_onset_rate_uses_a_sliding_one_second_window() {
        let notes = [
            event(900_000, 60, 0, 0),
            event(950_000, 62, 0, 0),
            event(1_050_000, 64, 0, 0),
            event(1_100_000, 65, 0, 0),
        ];
        assert_eq!(peak_onset_rate(&notes), 4);
    }

    #[test]
    fn continuity_prefers_nearby_melody_notes() {
        let candidates = vec![event(0, 62, 0, 0), event(0, 84, 0, 0)];
        assert_eq!(
            choose_continuous_melody(&candidates, Some(60))
                .unwrap()
                .note,
            62
        );
    }

    #[test]
    fn rejects_format_two_with_actionable_message() {
        let smf = Smf {
            header: midly::Header::new(
                Format::Sequential,
                Timing::Metrical(midly::num::u15::new(480)),
            ),
            tracks: Vec::new(),
        };
        let error = validated_timing_and_tempo(&smf).unwrap_err();
        assert!(error.contains("format 2"));
        assert!(error.contains("format 0 or 1"));
    }

    #[test]
    fn rejects_smpte_timing_with_actionable_message() {
        let smf = Smf {
            header: midly::Header::new(
                Format::SingleTrack,
                Timing::Timecode(midly::Fps::Fps30, 80),
            ),
            tracks: Vec::new(),
        };
        let error = validated_timing_and_tempo(&smf).unwrap_err();
        assert!(error.contains("SMPTE"));
        assert!(error.contains("PPQN"));
    }
}
