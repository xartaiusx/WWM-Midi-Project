use serde::{Deserialize, Serialize};

pub const KONGHOU_PROFILE_ID: &str = "wwm-konghou-36";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InstrumentProfile {
    pub id: String,
    pub name: String,
    pub minimum_midi_note: u8,
    pub maximum_midi_note: u8,
    pub key_count: u8,
    pub max_clean_polyphony: usize,
    pub max_clean_onsets_per_second: f64,
    pub default_modifier_lead_ms: u64,
    pub default_tap_ms: u64,
    pub default_modifier_release_ms: u64,
}

impl InstrumentProfile {
    pub fn wwm_konghou_36() -> Self {
        Self {
            id: KONGHOU_PROFILE_ID.to_string(),
            name: "Konghou Exact 36".to_string(),
            minimum_midi_note: 48,
            maximum_midi_note: 83,
            key_count: 36,
            max_clean_polyphony: 3,
            max_clean_onsets_per_second: 12.0,
            default_modifier_lead_ms: 2,
            default_tap_ms: 12,
            default_modifier_release_ms: 2,
        }
    }
}

impl Default for InstrumentProfile {
    fn default() -> Self {
        Self::wwm_konghou_36()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappedPitch {
    pub source_note: i32,
    pub transposed_note: i32,
    pub fitted_note: i32,
    pub octave_adjustment: i32,
    pub key: String,
}

pub fn map_exact_36(
    note: i32,
    transpose_semitones: i32,
    octave_fit: bool,
) -> Result<MappedPitch, String> {
    let profile = InstrumentProfile::wwm_konghou_36();
    let transposed_note = note + transpose_semitones;
    let (fitted_note, octave_adjustment) = fit_note_to_profile(
        transposed_note,
        profile.minimum_midi_note as i32,
        profile.maximum_midi_note as i32,
        octave_fit,
    )?;

    let octave = ((fitted_note - profile.minimum_midi_note as i32) / 12) as usize;
    let pitch_class = fitted_note.rem_euclid(12);

    Ok(MappedPitch {
        source_note: note,
        transposed_note,
        fitted_note,
        octave_adjustment,
        key: pitch_class_to_key(pitch_class, octave).to_string(),
    })
}

pub fn fit_note_to_profile(
    note: i32,
    minimum: i32,
    maximum: i32,
    octave_fit: bool,
) -> Result<(i32, i32), String> {
    if (minimum..=maximum).contains(&note) {
        return Ok((note, 0));
    }

    if !octave_fit {
        return Err(format!(
            "MIDI note {note} is outside the Konghou range {minimum}-{maximum}. Enable octave fit or choose an explicit transpose."
        ));
    }

    let mut fitted = note;
    let mut adjustment = 0;
    while fitted < minimum {
        fitted += 12;
        adjustment += 12;
    }
    while fitted > maximum {
        fitted -= 12;
        adjustment -= 12;
    }

    if !(minimum..=maximum).contains(&fitted) {
        return Err(format!(
            "MIDI note {note} cannot be octave-fitted into the Konghou range {minimum}-{maximum}."
        ));
    }

    Ok((fitted, adjustment))
}

#[allow(dead_code)]
pub fn exact_36_keys() -> Vec<String> {
    (48..=83)
        .map(|note| {
            map_exact_36(note, 0, false)
                .expect("the authoritative Konghou range must map")
                .key
        })
        .collect()
}

pub fn key_uses_modifier(key: &str) -> bool {
    key.starts_with("shift+") || key.starts_with("ctrl+")
}

fn pitch_class_to_key(pitch_class: i32, octave: usize) -> &'static str {
    const KEYS: [[&str; 12]; 3] = [
        [
            "z", "shift+z", "x", "ctrl+c", "c", "v", "shift+v", "b", "shift+b", "n", "ctrl+m", "m",
        ],
        [
            "a", "shift+a", "s", "ctrl+d", "d", "f", "shift+f", "g", "shift+g", "h", "ctrl+j", "j",
        ],
        [
            "q", "shift+q", "w", "ctrl+e", "e", "r", "shift+r", "t", "shift+t", "y", "ctrl+u", "u",
        ],
    ];

    KEYS[octave.min(2)][pitch_class.rem_euclid(12) as usize]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_36_konghou_pitches_exactly() {
        let expected = [
            "z", "shift+z", "x", "ctrl+c", "c", "v", "shift+v", "b", "shift+b", "n", "ctrl+m", "m",
            "a", "shift+a", "s", "ctrl+d", "d", "f", "shift+f", "g", "shift+g", "h", "ctrl+j", "j",
            "q", "shift+q", "w", "ctrl+e", "e", "r", "shift+r", "t", "shift+t", "y", "ctrl+u", "u",
        ];

        assert_eq!(exact_36_keys(), expected);
    }

    #[test]
    fn explicit_transpose_changes_pitch_once() {
        let mapped = map_exact_36(60, 1, false).unwrap();
        assert_eq!(mapped.fitted_note, 61);
        assert_eq!(mapped.key, "shift+a");
        assert_eq!(mapped.octave_adjustment, 0);
    }

    #[test]
    fn octave_fit_never_changes_pitch_class() {
        for note in 0..=127 {
            let mapped = map_exact_36(note, 0, true).unwrap();
            assert!((48..=83).contains(&mapped.fitted_note));
            assert_eq!(mapped.fitted_note.rem_euclid(12), note.rem_euclid(12));
            assert_eq!(mapped.octave_adjustment.rem_euclid(12), 0);
        }
    }

    #[test]
    fn out_of_range_is_actionable_without_octave_fit() {
        let error = map_exact_36(47, 0, false).unwrap_err();
        assert!(error.contains("Enable octave fit"));
    }
}
