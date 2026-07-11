//! Real-time MIDI device input handling.

use midir::{MidiInput, MidiInputConnection};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI8, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

use crate::keyboard;
use crate::midi::{KeyMode, NoteMode};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MidiConnectionState {
    NoDevices,
    DevicesAvailable,
    Connecting,
    Connected,
    Listening,
    Disconnected,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveNoteEvent {
    pub midi_note: u8,
    pub key: String,
    pub note_name: String,
    pub velocity: u8,
    pub accepted_by_api: bool,
}

pub struct MidiInputState {
    connection: Option<MidiInputConnection<()>>,
    available_ports: Vec<String>,
    selected_port: Option<usize>,
    state: MidiConnectionState,
}

impl Default for MidiInputState {
    fn default() -> Self {
        Self::new()
    }
}

impl MidiInputState {
    pub fn new() -> Self {
        Self {
            connection: None,
            available_ports: Vec::new(),
            selected_port: None,
            state: MidiConnectionState::NoDevices,
        }
    }

    pub fn get_state(&self) -> MidiConnectionState {
        self.state
    }

    #[allow(dead_code)]
    pub fn get_available_ports(&self) -> &[String] {
        &self.available_ports
    }

    #[allow(dead_code)]
    pub fn get_selected_port(&self) -> Option<usize> {
        self.selected_port
    }
}

pub fn list_midi_devices(midi_state: &mut MidiInputState) -> Vec<String> {
    let mut ports = Vec::new();
    match MidiInput::new("WWM Midi Project Scanner") {
        Ok(midi_in) => {
            for port in midi_in.ports() {
                if let Ok(name) = midi_in.port_name(&port) {
                    ports.push(name);
                }
            }
        }
        Err(error) => eprintln!("Failed to create MIDI input for scanning: {error}"),
    }

    midi_state.available_ports = ports.clone();
    midi_state.state = if ports.is_empty() {
        MidiConnectionState::NoDevices
    } else {
        MidiConnectionState::DevicesAvailable
    };
    ports
}

#[allow(clippy::too_many_arguments)]
pub fn start_listening(
    midi_state: Arc<Mutex<MidiInputState>>,
    device_index: usize,
    app_handle: AppHandle,
    note_mode: Arc<AtomicU8>,
    key_mode: Arc<AtomicU8>,
    octave_shift: Arc<AtomicI8>,
    transpose: Arc<AtomicI8>,
    is_listening: Arc<AtomicBool>,
) -> Result<String, String> {
    let mut state = midi_state
        .lock()
        .map_err(|error| format!("Lock error: {error}"))?;
    state.connection = None;
    if device_index >= state.available_ports.len() {
        return Err("Invalid device index".to_string());
    }
    let device_name = state.available_ports[device_index].clone();
    state.state = MidiConnectionState::Connecting;
    state.selected_port = Some(device_index);
    drop(state);

    let midi_in = MidiInput::new("WWM Midi Project Live")
        .map_err(|error| format!("Failed to create MIDI input: {error}"))?;
    let ports = midi_in.ports();
    if device_index >= ports.len() {
        return Err("Device no longer available".to_string());
    }

    let app_handle_clone = app_handle.clone();
    let note_mode_clone = note_mode.clone();
    let key_mode_clone = key_mode.clone();
    let octave_shift_clone = octave_shift.clone();
    let transpose_clone = transpose.clone();
    let is_listening_clone = is_listening.clone();
    let connection = midi_in
        .connect(
            &ports[device_index],
            "wwm-live-input",
            move |_timestamp, message, _| {
                if is_listening_clone.load(Ordering::SeqCst) {
                    handle_midi_message(
                        message,
                        &app_handle_clone,
                        &note_mode_clone,
                        &key_mode_clone,
                        &octave_shift_clone,
                        &transpose_clone,
                    );
                }
            },
            (),
        )
        .map_err(|error| format!("Failed to connect to MIDI device: {error}"))?;

    let mut state = midi_state
        .lock()
        .map_err(|error| format!("Lock error: {error}"))?;
    state.connection = Some(connection);
    state.state = MidiConnectionState::Connected;
    is_listening.store(true, Ordering::SeqCst);
    let _ = app_handle.emit("midi-device-connected", &device_name);
    Ok(device_name)
}

pub fn stop_listening(
    midi_state: Arc<Mutex<MidiInputState>>,
    is_listening: Arc<AtomicBool>,
    app_handle: &AppHandle,
) -> Result<(), String> {
    is_listening.store(false, Ordering::SeqCst);
    let mut state = midi_state
        .lock()
        .map_err(|error| format!("Lock error: {error}"))?;
    state.connection = None;
    state.state = if state.available_ports.is_empty() {
        MidiConnectionState::NoDevices
    } else {
        MidiConnectionState::DevicesAvailable
    };
    let _ = app_handle.emit("midi-device-disconnected", ());
    Ok(())
}

fn handle_midi_message(
    message: &[u8],
    app_handle: &AppHandle,
    note_mode: &Arc<AtomicU8>,
    key_mode: &Arc<AtomicU8>,
    octave_shift: &Arc<AtomicI8>,
    transpose: &Arc<AtomicI8>,
) {
    if message.len() < 3 {
        return;
    }

    let note = message[1];
    let velocity = message[2];
    let is_note_on = (message[0] & 0xF0) == 0x90 && velocity > 0;
    if !is_note_on {
        return;
    }

    let current_key_mode = KeyMode::from(key_mode.load(Ordering::SeqCst));
    let current_note_mode = NoteMode::from(note_mode.load(Ordering::SeqCst));
    let total_transpose = transpose.load(Ordering::SeqCst) as i32
        + if current_key_mode == KeyMode::Keys21 {
            octave_shift.load(Ordering::SeqCst) as i32 * 12
        } else {
            0
        };
    let key = match crate::midi::map_note_to_key(
        note as i32,
        total_transpose,
        current_note_mode,
        current_key_mode,
        true,
    ) {
        Ok(key) => key,
        Err(error) => {
            eprintln!("Live MIDI note {note} was rejected: {error}");
            return;
        }
    };

    let result = keyboard::tap_chord(std::slice::from_ref(&key));
    let event = LiveNoteEvent {
        midi_note: note,
        key,
        note_name: midi_note_to_name(note),
        velocity,
        accepted_by_api: result.success,
    };
    let _ = app_handle.emit("live-note-event", &event);
}

pub fn map_note_to_key(
    note: i32,
    transpose: i32,
    note_mode: NoteMode,
    key_mode: KeyMode,
) -> Result<String, String> {
    crate::midi::map_note_to_key(note, transpose, note_mode, key_mode, true)
}

fn midi_note_to_name(note: u8) -> String {
    const NOTE_NAMES: [&str; 12] = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    let octave = note as i32 / 12 - 1;
    format!("{}{}", NOTE_NAMES[(note % 12) as usize], octave)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_36_key_mapping_uses_shared_exact_contract() {
        assert_eq!(
            map_note_to_key(61, 0, NoteMode::Python, KeyMode::Keys36).unwrap(),
            "shift+a"
        );
        assert_eq!(
            map_note_to_key(60, 0, NoteMode::Sharps, KeyMode::Keys36).unwrap(),
            "a"
        );
    }
}
