// Virtual keyboard input using PostMessage to game window
// Sends WM_KEYDOWN/WM_KEYUP directly - doesn't affect other apps!

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Configurable modifier delay in milliseconds (default 0ms = instant)
static MODIFIER_DELAY_MS: AtomicU64 = AtomicU64::new(0);

// Input mode: false = PostMessage (default), true = SendInput (for cloud gaming)
static USE_SEND_INPUT: AtomicBool = AtomicBool::new(false);

use std::collections::HashMap;
use std::sync::RwLock as StdRwLock;

// Custom key bindings for each note position
// Maps logical key (e.g., "low_0") to physical key (e.g., "z")
lazy_static::lazy_static! {
    static ref CUSTOM_KEY_BINDINGS: StdRwLock<HashMap<String, String>> = StdRwLock::new(HashMap::new());
}

// Default key bindings (QWERTY layout)
pub const DEFAULT_LOW_KEYS: [&str; 7] = ["z", "x", "c", "v", "b", "n", "m"];
pub const DEFAULT_MID_KEYS: [&str; 7] = ["a", "s", "d", "f", "g", "h", "j"];
pub const DEFAULT_HIGH_KEYS: [&str; 7] = ["q", "w", "e", "r", "t", "y", "u"];

/// Set input mode: true = SendInput (cloud gaming), false = PostMessage (local)
pub fn set_send_input_mode(enabled: bool) {
    USE_SEND_INPUT.store(enabled, Ordering::SeqCst);
    clear_window_cache();
    println!(
        "[KEYBOARD] Input mode: {}",
        if enabled {
            "SendInput (cloud)"
        } else {
            "PostMessage (local)"
        }
    );
}

/// Get current input mode
pub fn get_send_input_mode() -> bool {
    USE_SEND_INPUT.load(Ordering::SeqCst)
}

/// Set custom key bindings for notes
/// keys format: { "low": ["z","x",...], "mid": ["a","s",...], "high": ["q","w",...] }
pub fn set_note_key_bindings(low: Vec<String>, mid: Vec<String>, high: Vec<String>) {
    if let Ok(mut bindings) = CUSTOM_KEY_BINDINGS.write() {
        bindings.clear();
        for (i, key) in low.iter().enumerate() {
            if i < 7 {
                bindings.insert(format!("low_{}", i), key.to_lowercase());
            }
        }
        for (i, key) in mid.iter().enumerate() {
            if i < 7 {
                bindings.insert(format!("mid_{}", i), key.to_lowercase());
            }
        }
        for (i, key) in high.iter().enumerate() {
            if i < 7 {
                bindings.insert(format!("high_{}", i), key.to_lowercase());
            }
        }
        println!(
            "[KEYBOARD] Custom key bindings set: low={:?}, mid={:?}, high={:?}",
            low, mid, high
        );
    }
}

/// Get current note key bindings
pub fn get_note_key_bindings() -> (Vec<String>, Vec<String>, Vec<String>) {
    let bindings = CUSTOM_KEY_BINDINGS.read().ok();

    let low: Vec<String> = (0..7)
        .map(|i| {
            bindings
                .as_ref()
                .and_then(|b| b.get(&format!("low_{}", i)))
                .cloned()
                .unwrap_or_else(|| DEFAULT_LOW_KEYS[i].to_string())
        })
        .collect();

    let mid: Vec<String> = (0..7)
        .map(|i| {
            bindings
                .as_ref()
                .and_then(|b| b.get(&format!("mid_{}", i)))
                .cloned()
                .unwrap_or_else(|| DEFAULT_MID_KEYS[i].to_string())
        })
        .collect();

    let high: Vec<String> = (0..7)
        .map(|i| {
            bindings
                .as_ref()
                .and_then(|b| b.get(&format!("high_{}", i)))
                .cloned()
                .unwrap_or_else(|| DEFAULT_HIGH_KEYS[i].to_string())
        })
        .collect();

    (low, mid, high)
}

/// Get the physical key for a logical note key
fn get_bound_key(logical_key: &str) -> String {
    // Map the default key names to their positions
    let (octave, index) = match logical_key {
        // Low octave
        "z" => ("low", 0),
        "x" => ("low", 1),
        "c" => ("low", 2),
        "v" => ("low", 3),
        "b" => ("low", 4),
        "n" => ("low", 5),
        "m" => ("low", 6),
        // Mid octave
        "a" => ("mid", 0),
        "s" => ("mid", 1),
        "d" => ("mid", 2),
        "f" => ("mid", 3),
        "g" => ("mid", 4),
        "h" => ("mid", 5),
        "j" => ("mid", 6),
        // High octave
        "q" => ("high", 0),
        "w" => ("high", 1),
        "e" => ("high", 2),
        "r" => ("high", 3),
        "t" => ("high", 4),
        "y" => ("high", 5),
        "u" => ("high", 6),
        // Unknown - return as-is
        _ => return logical_key.to_string(),
    };

    let binding_key = format!("{}_{}", octave, index);

    if let Ok(bindings) = CUSTOM_KEY_BINDINGS.read() {
        if let Some(bound) = bindings.get(&binding_key) {
            return bound.clone();
        }
    }

    // Return default
    logical_key.to_string()
}

/// Reset key bindings to defaults
pub fn reset_note_key_bindings() {
    if let Ok(mut bindings) = CUSTOM_KEY_BINDINGS.write() {
        bindings.clear();
    }
    println!("[KEYBOARD] Key bindings reset to defaults");
}

// Cached window handle and last check time
static CACHED_HWND: AtomicIsize = AtomicIsize::new(0);
lazy_static::lazy_static! {
    static ref LAST_WINDOW_CHECK: Mutex<Option<Instant>> = Mutex::new(None);
}
const WINDOW_CACHE_DURATION: Duration = Duration::from_secs(5);

/// Set the delay between modifier key and main key press
pub fn set_modifier_delay(delay_ms: u64) {
    MODIFIER_DELAY_MS.store(delay_ms, Ordering::SeqCst);
}

/// Get the current modifier delay
pub fn get_modifier_delay() -> u64 {
    MODIFIER_DELAY_MS.load(Ordering::SeqCst)
}

#[cfg(target_os = "windows")]
use windows::core::PWSTR;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM, RECT, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{
    MapVirtualKeyW, SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_SCANCODE, MAPVK_VK_TO_VSC,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId,
    PostMessageW, SetForegroundWindow, ShowWindow, SW_RESTORE, WM_KEYDOWN, WM_KEYUP,
};

const TARGET_WINDOW_KEYWORDS: [&str; 3] = ["where winds meet", "wwm", "wwm.exe"];
const TARGET_PROCESS_NAMES: [&str; 1] = ["wwm.exe"];
const EXCLUDED_WINDOW_KEYWORDS: [&str; 18] = [
    "midi player",
    "overlay",
    "discord",
    "telegram",
    "slack",
    "teams",
    "notepad",
    "visual studio",
    "vscode",
    "google chrome",
    "mozilla firefox",
    "microsoft edge",
    "opera",
    "brave",
    "vivaldi",
    "safari",
    "youtube",
    "twitch",
];

#[derive(Debug, Clone, serde::Serialize)]
pub struct TargetWindowDiagnostics {
    pub found: bool,
    pub title: Option<String>,
    pub process_name: Option<String>,
    pub process_path: Option<String>,
    pub matched_by: Option<String>,
    pub is_focused: bool,
    pub input_mode: String,
}

#[derive(Debug, Clone)]
#[cfg(target_os = "windows")]
struct TargetWindowInfo {
    title: String,
    process_name: Option<String>,
    process_path: Option<String>,
    matched_by: String,
}

// Custom window keywords added by user
use std::sync::RwLock;
static CUSTOM_WINDOW_KEYWORDS: RwLock<Vec<String>> = RwLock::new(Vec::new());

pub fn set_custom_window_keywords(keywords: Vec<String>) {
    if let Ok(mut guard) = CUSTOM_WINDOW_KEYWORDS.write() {
        *guard = keywords;
    }
    clear_window_cache();
}

pub fn get_custom_window_keywords() -> Vec<String> {
    CUSTOM_WINDOW_KEYWORDS
        .read()
        .map(|g| g.clone())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
struct EnumData {
    target: Option<HWND>,
}

fn is_excluded_window_title(title_lower: &str) -> bool {
    EXCLUDED_WINDOW_KEYWORDS
        .iter()
        .any(|keyword| title_lower.contains(keyword))
}

fn process_name_from_path(path: &str) -> Option<String> {
    path.rsplit(['\\', '/'])
        .find(|part| !part.trim().is_empty())
        .map(|name| name.to_lowercase())
}

fn match_target_metadata(
    title: &str,
    process_name: Option<&str>,
    process_path: Option<&str>,
    custom_keywords: &[String],
) -> Option<String> {
    let title_lower = title.to_lowercase();
    if title_lower.trim().is_empty() || is_excluded_window_title(&title_lower) {
        return None;
    }

    if let Some(keyword) = TARGET_WINDOW_KEYWORDS
        .iter()
        .find(|keyword| title_lower.contains(*keyword))
    {
        return Some(format!("title:{keyword}"));
    }

    let normalized_process = process_name
        .filter(|name| !name.trim().is_empty())
        .map(|name| name.to_lowercase())
        .or_else(|| process_path.and_then(process_name_from_path));

    if let Some(process) = normalized_process {
        if TARGET_PROCESS_NAMES.iter().any(|target| process == *target) {
            return Some(format!("process:{process}"));
        }
    }

    custom_keywords
        .iter()
        .map(|keyword| keyword.trim().to_lowercase())
        .find(|keyword| !keyword.is_empty() && title_lower.contains(keyword))
        .map(|keyword| format!("custom:{keyword}"))
}

#[cfg(target_os = "windows")]
fn get_window_title(hwnd: HWND) -> Option<String> {
    let mut title = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, &mut title) };
    if len <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&title[..len as usize]))
}

#[cfg(target_os = "windows")]
fn get_window_process_info(hwnd: HWND) -> (Option<String>, Option<String>) {
    unsafe {
        let mut process_id = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut process_id));
        if process_id == 0 {
            return (None, None);
        }

        let process_handle =
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, BOOL(0), process_id) {
                Ok(handle) => handle,
                Err(_) => return (None, None),
            };

        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let process_path = QueryFullProcessImageNameW(
            process_handle,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .ok()
        .and_then(|_| {
            if size == 0 {
                None
            } else {
                Some(String::from_utf16_lossy(&buffer[..size as usize]))
            }
        });

        let _ = CloseHandle(process_handle);
        let process_name = process_path.as_deref().and_then(process_name_from_path);

        (process_name, process_path)
    }
}

#[cfg(target_os = "windows")]
fn get_target_window_info(hwnd: HWND, log: bool) -> Option<TargetWindowInfo> {
    let title = get_window_title(hwnd)?;
    let (process_name, process_path) = get_window_process_info(hwnd);
    let custom_keywords = get_custom_window_keywords();
    let matched_by = match_target_metadata(
        &title,
        process_name.as_deref(),
        process_path.as_deref(),
        &custom_keywords,
    )?;

    if log {
        println!(
            "[WINDOW] Found matching window: '{}' process='{}' matched_by='{}' hwnd={:?}",
            title.to_lowercase(),
            process_name.as_deref().unwrap_or("unknown"),
            matched_by,
            hwnd.0
        );
    }

    Some(TargetWindowInfo {
        title,
        process_name,
        process_path,
        matched_by,
    })
}

#[cfg(target_os = "windows")]
fn matches_target_window(hwnd: HWND, log: bool) -> bool {
    get_target_window_info(hwnd, log).is_some()
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_windows_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let data = &mut *(lparam.0 as *mut EnumData);
    if matches_target_window(hwnd, true) {
        data.target = Some(hwnd);
        return BOOL(0);
    }
    BOOL(1)
}

// ============ Background keyboard injection ============
// Attaches to game thread, focuses game, sends input, restores focus
// This allows sending keys to game while doing other things

/// Find game window (with caching to avoid repeated searches)
#[cfg(target_os = "windows")]
fn find_game_window() -> Option<HWND> {
    // Check if we have a valid cached handle
    let cached = CACHED_HWND.load(Ordering::SeqCst);
    let mut last_check = LAST_WINDOW_CHECK.lock().unwrap();

    let should_refresh = if cached == 0 {
        true
    } else if let Some(last) = *last_check {
        last.elapsed() > WINDOW_CACHE_DURATION
    } else {
        true
    };

    if !should_refresh && cached != 0 {
        return Some(HWND(cached as *mut std::ffi::c_void));
    }

    // Search for window
    unsafe {
        let mut data = EnumData { target: None };
        let _ = EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut data as *mut _ as isize),
        );

        if let Some(hwnd) = data.target {
            // Cache the result
            CACHED_HWND.store(hwnd.0 as isize, Ordering::SeqCst);
            *last_check = Some(Instant::now());
            println!("[WINDOW] Cached game window hwnd={:?}", hwnd.0);
            Some(hwnd)
        } else {
            // Clear cache if window not found
            CACHED_HWND.store(0, Ordering::SeqCst);
            *last_check = None;
            None
        }
    }
}

/// Clear the cached window handle (call when starting new playback)
#[allow(dead_code)]
pub fn clear_window_cache() {
    CACHED_HWND.store(0, Ordering::SeqCst);
    if let Ok(mut last_check) = LAST_WINDOW_CHECK.lock() {
        *last_check = None;
    }
}

/// Get current game window rectangle in screen coordinates
#[cfg(target_os = "windows")]
pub fn get_game_window_rect() -> Option<(i32, i32, i32, i32)> {
    if let Some(hwnd) = find_game_window() {
        unsafe {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_ok() {
                let width = (rect.right - rect.left).max(0);
                let height = (rect.bottom - rect.top).max(0);
                return Some((rect.left, rect.top, width, height));
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
pub fn get_game_window_rect() -> Option<(i32, i32, i32, i32)> {
    None
}

// Modifier key codes
#[cfg(target_os = "windows")]
const VK_SHIFT: u32 = 0x10;
#[cfg(target_os = "windows")]
const VK_CONTROL: u32 = 0x11;

/// Key with optional modifier
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
pub enum Modifier {
    None,
    Shift,
    Ctrl,
}

/// Convert key string to virtual key code and modifier
/// Format: "key" for normal, "shift+key" for shift, "ctrl+key" for ctrl
#[cfg(target_os = "windows")]
fn parse_key(key: &str) -> Option<(u32, Modifier)> {
    let key_lower = key.to_lowercase();

    // Check for modifier prefix
    if let Some(base_key) = key_lower.strip_prefix("shift+") {
        // First resolve custom binding, then convert to VK
        let bound_key = get_bound_key(base_key);
        return char_to_vk(&bound_key).map(|vk| (vk, Modifier::Shift));
    }
    if let Some(base_key) = key_lower.strip_prefix("ctrl+") {
        let bound_key = get_bound_key(base_key);
        return char_to_vk(&bound_key).map(|vk| (vk, Modifier::Ctrl));
    }

    // First resolve custom binding, then convert to VK
    let bound_key = get_bound_key(&key_lower);
    char_to_vk(&bound_key).map(|vk| (vk, Modifier::None))
}

/// Convert a single character key to virtual key code
/// This maps the actual keyboard character to its VK code
#[cfg(target_os = "windows")]
fn char_to_vk(key: &str) -> Option<u32> {
    match key {
        // Letters A-Z (VK codes 0x41-0x5A)
        "a" => Some(0x41),
        "b" => Some(0x42),
        "c" => Some(0x43),
        "d" => Some(0x44),
        "e" => Some(0x45),
        "f" => Some(0x46),
        "g" => Some(0x47),
        "h" => Some(0x48),
        "i" => Some(0x49),
        "j" => Some(0x4A),
        "k" => Some(0x4B),
        "l" => Some(0x4C),
        "m" => Some(0x4D),
        "n" => Some(0x4E),
        "o" => Some(0x4F),
        "p" => Some(0x50),
        "q" => Some(0x51),
        "r" => Some(0x52),
        "s" => Some(0x53),
        "t" => Some(0x54),
        "u" => Some(0x55),
        "v" => Some(0x56),
        "w" => Some(0x57),
        "x" => Some(0x58),
        "y" => Some(0x59),
        "z" => Some(0x5A),
        // Numbers 0-9 (VK codes 0x30-0x39)
        "0" => Some(0x30),
        "1" => Some(0x31),
        "2" => Some(0x32),
        "3" => Some(0x33),
        "4" => Some(0x34),
        "5" => Some(0x35),
        "6" => Some(0x36),
        "7" => Some(0x37),
        "8" => Some(0x38),
        "9" => Some(0x39),
        // Common punctuation
        ";" | "semicolon" => Some(0xBA),
        "," | "comma" => Some(0xBC),
        "." | "period" => Some(0xBE),
        "/" | "slash" => Some(0xBF),
        _ => None,
    }
}

/// Build lParam for WM_KEYDOWN (scan code in bits 16-23)
#[cfg(target_os = "windows")]
fn make_keydown_lparam(vk: u32) -> LPARAM {
    unsafe {
        let scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
        // Bits: 0-15 = repeat count (1), 16-23 = scan code, 24 = extended, 29 = context, 30 = prev state, 31 = transition
        let lparam = 1u32 | ((scan & 0xFF) << 16);
        LPARAM(lparam as isize)
    }
}

/// Build lParam for WM_KEYUP (scan code + release flags)
#[cfg(target_os = "windows")]
fn make_keyup_lparam(vk: u32) -> LPARAM {
    unsafe {
        let scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
        // Bits 30 and 31 set for key release
        let lparam = 1u32 | ((scan & 0xFF) << 16) | (1 << 30) | (1 << 31);
        LPARAM(lparam as isize)
    }
}

/// Get virtual key code for modifier
#[cfg(target_os = "windows")]
fn modifier_to_vk(modifier: Modifier) -> Option<u32> {
    match modifier {
        Modifier::Shift => Some(VK_SHIFT),
        Modifier::Ctrl => Some(VK_CONTROL),
        Modifier::None => None,
    }
}

/// Reset modifier counts (no-op now, kept for compatibility)
pub fn reset_modifier_counts() {
    // No longer using reference counting
}

fn input_mode_label() -> String {
    if get_send_input_mode() {
        "SendInput".to_string()
    } else {
        "PostMessage".to_string()
    }
}

// ============ SendInput-based functions (for cloud gaming) ============

#[cfg(target_os = "windows")]
fn send_input_key_down(vk: u32) {
    unsafe {
        let scan_code = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) as u16;
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(vk as u16),
                    wScan: scan_code,
                    dwFlags: KEYEVENTF_SCANCODE,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(target_os = "windows")]
fn send_input_key_up(vk: u32) {
    unsafe {
        let scan_code = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) as u16;
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(vk as u16),
                    wScan: scan_code,
                    dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(&[input], std::mem::size_of::<INPUT>() as i32);
    }
}

/// Send modifier + key down in a single atomic SendInput call (instant, no delay)
#[cfg(target_os = "windows")]
fn send_input_combo_down(mod_vk: u32, key_vk: u32) {
    unsafe {
        let mod_scan = MapVirtualKeyW(mod_vk, MAPVK_VK_TO_VSC) as u16;
        let key_scan = MapVirtualKeyW(key_vk, MAPVK_VK_TO_VSC) as u16;

        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(
                            mod_vk as u16,
                        ),
                        wScan: mod_scan,
                        dwFlags: KEYEVENTF_SCANCODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(
                            key_vk as u16,
                        ),
                        wScan: key_scan,
                        dwFlags: KEYEVENTF_SCANCODE,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Send key up + modifier up in a single atomic SendInput call (instant, no delay)
#[cfg(target_os = "windows")]
fn send_input_combo_up(key_vk: u32, mod_vk: u32) {
    unsafe {
        let key_scan = MapVirtualKeyW(key_vk, MAPVK_VK_TO_VSC) as u16;
        let mod_scan = MapVirtualKeyW(mod_vk, MAPVK_VK_TO_VSC) as u16;

        let inputs = [
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(
                            key_vk as u16,
                        ),
                        wScan: key_scan,
                        dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
            INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: windows::Win32::UI::Input::KeyboardAndMouse::INPUT_0 {
                    ki: KEYBDINPUT {
                        wVk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY(
                            mod_vk as u16,
                        ),
                        wScan: mod_scan,
                        dwFlags: KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP,
                        time: 0,
                        dwExtraInfo: 0,
                    },
                },
            },
        ];
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

// ============ Key down/up with mode switching ============

#[cfg(target_os = "windows")]
pub fn key_down(key: &str) {
    if let Some((vk, modifier)) = parse_key(key) {
        if USE_SEND_INPUT.load(Ordering::SeqCst) {
            // SendInput mode - global keyboard simulation
            // Only send if a game window is currently focused (prevent typing in Discord etc)
            if !is_wwm_focused().unwrap_or(false) {
                return;
            }
            // Use atomic combo for modifier keys (instant, no delay)
            if let Some(mod_vk) = modifier_to_vk(modifier) {
                send_input_combo_down(mod_vk, vk);
            } else {
                send_input_key_down(vk);
            }
        } else {
            // PostMessage mode - targeted to game window
            if let Some(hwnd) = find_game_window() {
                unsafe {
                    // Send modifier + key instantly (back-to-back, no delay)
                    if let Some(mod_vk) = modifier_to_vk(modifier) {
                        let mod_lparam = make_keydown_lparam(mod_vk);
                        let key_lparam = make_keydown_lparam(vk);
                        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(mod_vk as usize), mod_lparam);
                        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(vk as usize), key_lparam);
                    } else {
                        let lparam = make_keydown_lparam(vk);
                        let _ = PostMessageW(hwnd, WM_KEYDOWN, WPARAM(vk as usize), lparam);
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn key_up(key: &str) {
    if let Some((vk, modifier)) = parse_key(key) {
        if USE_SEND_INPUT.load(Ordering::SeqCst) {
            // SendInput mode - global keyboard simulation
            // Only send if a game window is currently focused (prevent typing in Discord etc)
            if !is_wwm_focused().unwrap_or(false) {
                return;
            }
            // Use atomic combo for modifier keys (instant, no delay)
            if let Some(mod_vk) = modifier_to_vk(modifier) {
                send_input_combo_up(vk, mod_vk);
            } else {
                send_input_key_up(vk);
            }
        } else {
            // PostMessage mode - targeted to game window
            if let Some(hwnd) = find_game_window() {
                unsafe {
                    // Release key + modifier instantly (back-to-back, no delay)
                    if let Some(mod_vk) = modifier_to_vk(modifier) {
                        let key_lparam = make_keyup_lparam(vk);
                        let mod_lparam = make_keyup_lparam(mod_vk);
                        let _ = PostMessageW(hwnd, WM_KEYUP, WPARAM(vk as usize), key_lparam);
                        let _ = PostMessageW(hwnd, WM_KEYUP, WPARAM(mod_vk as usize), mod_lparam);
                    } else {
                        let lparam = make_keyup_lparam(vk);
                        let _ = PostMessageW(hwnd, WM_KEYUP, WPARAM(vk as usize), lparam);
                    }
                }
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn key_down(_key: &str) {
    // Non-Windows: no-op for now
}

#[cfg(not(target_os = "windows"))]
pub fn key_up(_key: &str) {
    // Non-Windows: no-op for now
}

#[cfg(not(target_os = "windows"))]
pub fn reset_modifier_counts() {
    // Non-Windows: no-op
}

#[cfg(not(target_os = "windows"))]
#[allow(dead_code)]
pub fn clear_window_cache() {
    // Non-Windows: no-op
}

// ============ Old Enigo-based method (commented out) ============
/*
lazy_static::lazy_static! {
    static ref ENIGO: Mutex<Enigo> = Mutex::new(
        Enigo::new(&Settings::default()).expect("Failed to initialize Enigo")
    );
}

pub fn key_down(key: &str) {
    let mut enigo = ENIGO.lock().unwrap();

    if let Some(k) = string_to_key(key) {
        let _ = enigo.key(k, Direction::Press);
    }
}

pub fn key_up(key: &str) {
    let mut enigo = ENIGO.lock().unwrap();

    if let Some(k) = string_to_key(key) {
        let _ = enigo.key(k, Direction::Release);
    }
}

fn string_to_key(key: &str) -> Option<Key> {
    match key.to_lowercase().as_str() {
        "z" => Some(Key::Unicode('z')),
        "x" => Some(Key::Unicode('x')),
        "c" => Some(Key::Unicode('c')),
        "v" => Some(Key::Unicode('v')),
        "b" => Some(Key::Unicode('b')),
        "n" => Some(Key::Unicode('n')),
        "m" => Some(Key::Unicode('m')),
        "a" => Some(Key::Unicode('a')),
        "s" => Some(Key::Unicode('s')),
        "d" => Some(Key::Unicode('d')),
        "f" => Some(Key::Unicode('f')),
        "g" => Some(Key::Unicode('g')),
        "h" => Some(Key::Unicode('h')),
        "j" => Some(Key::Unicode('j')),
        "q" => Some(Key::Unicode('q')),
        "w" => Some(Key::Unicode('w')),
        "e" => Some(Key::Unicode('e')),
        "r" => Some(Key::Unicode('r')),
        "t" => Some(Key::Unicode('t')),
        "y" => Some(Key::Unicode('y')),
        "u" => Some(Key::Unicode('u')),
        _ => None,
    }
}
*/

/// Check if game window exists (for status indicator)
#[cfg(target_os = "windows")]
pub fn is_game_window_found() -> bool {
    find_game_window().is_some()
}

#[cfg(not(target_os = "windows"))]
pub fn is_game_window_found() -> bool {
    true
}

#[cfg(target_os = "windows")]
pub fn get_target_window_diagnostics() -> TargetWindowDiagnostics {
    let info = find_game_window().and_then(|hwnd| get_target_window_info(hwnd, false));
    let is_focused = unsafe {
        let hwnd = GetForegroundWindow();
        !hwnd.0.is_null() && matches_target_window(hwnd, false)
    };

    TargetWindowDiagnostics {
        found: info.is_some(),
        title: info.as_ref().map(|i| i.title.clone()),
        process_name: info.as_ref().and_then(|i| i.process_name.clone()),
        process_path: info.as_ref().and_then(|i| i.process_path.clone()),
        matched_by: info.as_ref().map(|i| i.matched_by.clone()),
        is_focused,
        input_mode: input_mode_label(),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn get_target_window_diagnostics() -> TargetWindowDiagnostics {
    TargetWindowDiagnostics {
        found: true,
        title: Some("Non-Windows target".to_string()),
        process_name: None,
        process_path: None,
        matched_by: Some("platform:non-windows".to_string()),
        is_focused: true,
        input_mode: input_mode_label(),
    }
}

#[cfg(target_os = "windows")]
pub fn is_wwm_focused() -> Result<bool, String> {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return Ok(false);
        }
        Ok(matches_target_window(hwnd, false))
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_wwm_focused() -> Result<bool, String> {
    // For non-Windows platforms, always return true for now
    Ok(true)
}

#[cfg(target_os = "windows")]
pub fn focus_black_desert_window() -> Result<(), String> {
    unsafe {
        let mut data = EnumData { target: None };
        EnumWindows(
            Some(enum_windows_proc),
            LPARAM(&mut data as *mut _ as isize),
        )
        .map_err(|e| e.to_string())?;

        if let Some(hwnd) = data.target {
            let _ = ShowWindow(hwnd, SW_RESTORE);
            std::thread::sleep(std::time::Duration::from_millis(50));
            let _ = SetForegroundWindow(hwnd);
            std::thread::sleep(std::time::Duration::from_millis(100));
            Ok(())
        } else {
            Err("Target window not found. Add a custom window keyword in Settings.".into())
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub fn focus_black_desert_window() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::match_target_metadata;

    #[test]
    fn where_winds_meet_title_matches() {
        let custom = Vec::new();
        assert_eq!(
            match_target_metadata("Where Winds Meet", None, None, &custom).as_deref(),
            Some("title:where winds meet")
        );
    }

    #[test]
    fn wwm_process_matches_when_title_changes() {
        let custom = Vec::new();
        assert_eq!(
            match_target_metadata("Unexpected Game Window", Some("wwm.exe"), None, &custom)
                .as_deref(),
            Some("process:wwm.exe")
        );
    }

    #[test]
    fn wwm_process_path_matches_when_name_is_missing() {
        let custom = Vec::new();
        assert_eq!(
            match_target_metadata(
                "Unexpected Game Window",
                None,
                Some(r"C:\Program Files (x86)\Steam\steamapps\common\Where Winds Meet\wwm.exe"),
                &custom,
            )
            .as_deref(),
            Some("process:wwm.exe")
        );
    }

    #[test]
    fn midi_player_window_does_not_match_itself() {
        let custom = Vec::new();
        assert_eq!(
            match_target_metadata("WWM MIDI Player", None, None, &custom),
            None
        );
    }

    #[test]
    fn browser_and_chat_titles_do_not_match_game_keywords() {
        let custom = Vec::new();
        for title in [
            "Where Winds Meet - Google Chrome",
            "Where Winds Meet Guild - Microsoft Edge",
            "Where Winds Meet voice chat - Discord",
        ] {
            assert_eq!(match_target_metadata(title, None, None, &custom), None);
        }
    }
}
