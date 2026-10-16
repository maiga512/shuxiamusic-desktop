mod audio_device;
mod commands;
mod db;
mod hotkeys;
mod models;
mod now_playing;
mod permissions;
mod process_util;
mod system_power;
mod windowed_fs;

use commands::cover_proxy::*;
use commands::dlna::*;
use commands::download_engine::download_finalize_metadata;
use commands::local_music::*;
use commands::lyric_window::*;
use commands::media_stream_proxy::*;
use commands::misc::*;
use commands::mpv_player::*;
use commands::native_audio::*;
use commands::node_sidecar::*;
use commands::plugin::*;
use commands::songlist::*;
use db::Database;
use hotkeys::{apply_global_hotkeys, handle_shortcut};
use now_playing::{hotkeys_set_recording, init_now_playing, now_playing_update};
use now_playing::media_diag_log;
use permissions::permissions_request_microphone;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

/// Shared desktop lyric lock state, toggled via `toogleDesktopLyricLock` event.
pub(crate) static LYRIC_LOCK_STATE: Mutex<bool> = Mutex::new(false);

/// Track fullscreen state for emitting `app-fullscreen-changed` events.
static LAST_FULLSCREEN: AtomicBool = AtomicBool::new(false);
static MENU_BAR_MARQUEE_STARTED: AtomicBool = AtomicBool::new(false);
static CLOSE_REQUEST_ACK: AtomicBool = AtomicBool::new(false);

const MENU_BAR_LYRIC_CONFIG_KEY: &str = "mac_status_bar_lyric";
const MENU_BAR_LYRIC_LAST_SONG_KEY: &str = "mac_status_bar_lyric_last_song_title";
const INVISIBLE_PLACEHOLDER: &str = "\u{200B}";
// Electron src/main/index.ts MAC_TRAY_GUID — keeps NSStatusItem position across relaunches.
#[cfg(target_os = "macos")]
const MAC_TRAY_GUID: &str = "f4f8a5d8-9eb2-4f98-8fd7-3a3d5ec9b2cf";
// Electron menuBarLyric.ts: fixed visual width 22 (CJK counts as 2).
const DISPLAY_WIDTH: usize = 22;
const DEFAULT_SCROLL_GAP: &str = "   ";
const ASCII_SCROLL_GAP: &str = " ";
const HALF_WIDTH_PADDING_CHAR: char = ' ';
const FULL_WIDTH_PADDING_CHAR: char = '\u{3000}';
// Hold the full line briefly so the eye can land before marquee starts.
const SCROLL_START_DELAY_MS: u64 = 900;
// NSStatusItem can only retitle by glyphs. We advance 1 visual unit per tick
// and synthesize a half-width lead-in when a CJK glyph is mid-exit, so the
// marquee eases out instead of PowerPoint-jumping a whole character.
const SCROLL_INTERVAL_MS: u64 = 110;
const SCROLL_STEP_VISUAL_UNITS: usize = 1;

#[cfg(target_os = "macos")]
fn hide_macos_window_buttons(window: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window.cast::<AnyObject>();
    if ns_window.is_null() {
        return;
    }

    // Keep the native window frame for its rounded corners and shadow, but use the
    // app's existing custom title-bar controls instead of the AppKit traffic lights.
    for button_kind in [0usize, 1, 2] {
        let button: *mut AnyObject =
            unsafe { msg_send![ns_window, standardWindowButton: button_kind] };
        if !button.is_null() {
            let _: () = unsafe { msg_send![button, setHidden: true] };
        }
    }
}

#[cfg(target_os = "macos")]
fn cap_wkwebview_url_cache() {
    use objc2::{msg_send, runtime::AnyObject};

    let Some(nsurl_cache) = objc2::runtime::AnyClass::get(c"NSURLCache") else {
        return;
    };
    let shared: *mut AnyObject = unsafe { msg_send![nsurl_cache, sharedURLCache] };
    if shared.is_null() {
        return;
    }
    // WKWebView decoded covers live in this process. Cap the HTTP memory
    // cache so localhost does not keep hundreds of megabytes of original
    // album art after scrolling playlists.
    let _: () = unsafe { msg_send![shared, setMemoryCapacity: 32usize * 1024 * 1024] };
}

#[derive(Default)]
struct MenuBarLyricState {
    song_name: String,
    artist: String,
    persisted_song_title: String,
    lyrics: Vec<String>,
    current_index: isize,
    play_status: bool,
    source_text: String,
    scroll_offset: usize,
    last_title: String,
    scroll_wait_until: Option<Instant>,
}

fn menu_bar_lyric_state() -> &'static Mutex<MenuBarLyricState> {
    static STATE: OnceLock<Mutex<MenuBarLyricState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(MenuBarLyricState::default()))
}

fn normalize_menu_bar_text(text: &str) -> String {
    text.chars()
        .filter(|c| !matches!(*c, '\u{200B}'..='\u{200D}' | '\u{FEFF}'))
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn get_menu_bar_chars(text: &str) -> Vec<char> {
    text.chars().collect()
}

fn is_ascii_dominant_text(text: &str) -> bool {
    let chars = get_menu_bar_chars(text)
        .into_iter()
        .filter(|c| !c.is_whitespace())
        .collect::<Vec<_>>();
    if chars.is_empty() {
        return false;
    }
    let ascii_count = chars.iter().filter(|c| c.is_ascii()).count();
    ascii_count * 100 >= chars.len() * 85
}

fn get_menu_bar_scroll_gap(text: &str) -> &'static str {
    if is_ascii_dominant_text(text) {
        ASCII_SCROLL_GAP
    } else {
        DEFAULT_SCROLL_GAP
    }
}

fn is_wide_menu_bar_char(ch: char) -> bool {
    // Electron WIDE_CHAR_PATTERN = /[^\x00-\xFF]/
    (ch as u32) > 0xFF
}

fn get_menu_bar_visual_width(text: &str) -> usize {
    get_menu_bar_chars(text)
        .into_iter()
        .map(|ch| if is_wide_menu_bar_char(ch) { 2 } else { 1 })
        .sum()
}

fn slice_menu_bar_by_visual_width(text: &str, max_width: usize) -> String {
    let mut width = 0usize;
    let mut result = String::new();
    for ch in get_menu_bar_chars(text) {
        let char_width = if is_wide_menu_bar_char(ch) { 2 } else { 1 };
        if width + char_width > max_width {
            break;
        }
        result.push(ch);
        width += char_width;
    }
    result
}

fn pad_menu_bar_text(text: &str, width: usize) -> String {
    let display_text = slice_menu_bar_by_visual_width(text, width);
    let mut remaining = width.saturating_sub(get_menu_bar_visual_width(&display_text));
    if remaining == 0 {
        return display_text;
    }

    let mut padded = display_text;
    while remaining >= 2 {
        padded.push(FULL_WIDTH_PADDING_CHAR);
        remaining -= 2;
    }
    if remaining > 0 {
        padded.push(HALF_WIDTH_PADDING_CHAR);
    }
    padded
}

fn format_menu_bar_song_title(name: &str, artist: &str) -> String {
    [
        normalize_menu_bar_text(name),
        normalize_menu_bar_text(artist),
    ]
    .into_iter()
    .filter(|item| !item.is_empty())
    .collect::<Vec<_>>()
    .join(" - ")
}

fn build_menu_bar_source_text(state: &MenuBarLyricState) -> String {
    let current_lyric = if state.current_index >= 0 {
        state
            .lyrics
            .get(state.current_index as usize)
            .cloned()
            .unwrap_or_default()
    } else {
        String::new()
    };

    let song_title = format_menu_bar_song_title(&state.song_name, &state.artist);
    [
        current_lyric,
        song_title,
        state.persisted_song_title.clone(),
    ]
    .into_iter()
    .find(|item| !item.is_empty())
    .unwrap_or_default()
}

fn recompute_menu_bar_source_text(state: &mut MenuBarLyricState) {
    let next = build_menu_bar_source_text(state);
    if next != state.source_text {
        state.source_text = next;
        state.scroll_offset = 0;
        state.scroll_wait_until =
            Some(Instant::now() + Duration::from_millis(SCROLL_START_DELAY_MS));
    }
}

fn compute_menu_bar_display_title(state: &MenuBarLyricState) -> String {
    if state.source_text.is_empty() {
        return String::new();
    }

    let display_width = DISPLAY_WIDTH;
    if get_menu_bar_visual_width(&state.source_text) <= display_width {
        return pad_menu_bar_text(&state.source_text, display_width);
    }

    // Scroll by visual-width units. When the offset lands mid-CJK glyph, drop
    // that glyph and lead with a half-width space so the rest of the line
    // shifts by one unit instead of waiting for the next full-char jump.
    let marquee_source = format!(
        "{}{}",
        state.source_text,
        get_menu_bar_scroll_gap(&state.source_text)
    );
    let marquee_chars = get_menu_bar_chars(&marquee_source);
    if marquee_chars.is_empty() {
        return pad_menu_bar_text(&state.source_text, display_width);
    }

    let total_visual = get_menu_bar_visual_width(&marquee_source).max(1);
    let mut skip = state.scroll_offset % total_visual;
    let mut start_index = 0usize;
    let mut lead_half = false;
    while start_index < marquee_chars.len() {
        let width = if is_wide_menu_bar_char(marquee_chars[start_index]) {
            2
        } else {
            1
        };
        if skip == 0 {
            break;
        }
        if skip < width {
            // Mid-wide glyph: treat as half-exited. Skip the glyph and insert
            // a half-width lead so the visible line advances this tick.
            lead_half = true;
            start_index += 1;
            break;
        }
        skip = skip.saturating_sub(width);
        start_index += 1;
    }

    let doubled: Vec<char> = marquee_chars
        .iter()
        .cloned()
        .chain(marquee_chars.iter().cloned())
        .collect();
    let mut window = String::new();
    let mut used = 0usize;
    if lead_half {
        window.push(HALF_WIDTH_PADDING_CHAR);
        used = 1;
    }
    for ch in doubled.into_iter().skip(start_index) {
        let width = if is_wide_menu_bar_char(ch) { 2 } else { 1 };
        if used + width > display_width {
            break;
        }
        window.push(ch);
        used += width;
        if used >= display_width {
            break;
        }
    }
    pad_menu_bar_text(&window, display_width)
}

fn menu_bar_tray(app: &tauri::AppHandle) -> Option<tauri::tray::TrayIcon> {
    #[cfg(target_os = "macos")]
    {
        app.tray_by_id(MAC_TRAY_GUID)
            .or_else(|| app.tray_by_id("main"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.tray_by_id("main")
    }
}

fn is_status_bar_lyric_enabled(app: &tauri::AppHandle) -> bool {
    app.try_state::<Database>()
        .and_then(|db| db.get_setting(MENU_BAR_LYRIC_CONFIG_KEY))
        .map(|v| v == "true")
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn is_tray_interactive(app: &tauri::AppHandle) -> bool {
    is_status_bar_lyric_enabled(app)
}

#[cfg(not(target_os = "macos"))]
fn is_tray_interactive(_app: &tauri::AppHandle) -> bool {
    true
}

fn desktop_lyric_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("desktop-lyric")
        .and_then(|win| win.is_visible().ok())
        .unwrap_or(false)
}

fn desktop_lyric_locked() -> bool {
    LYRIC_LOCK_STATE.lock().map(|state| *state).unwrap_or(false)
}

fn build_tray_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let prev = MenuItem::with_id(app, "prev", "上一首", true, None::<&str>)?;
    let play_pause = MenuItem::with_id(app, "play_pause", "播放/暂停", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let main_window_visible = app
        .get_webview_window("main")
        .and_then(|win| {
            let visible = win.is_visible().ok()?;
            let minimized = win.is_minimized().unwrap_or(false);
            Some(visible && !minimized)
        })
        .unwrap_or(false);
    let main_window_label = if main_window_visible {
        "隐藏主窗口"
    } else {
        "显示主窗口"
    };
    let show = MenuItem::with_id(
        app,
        "toggle_main_window",
        main_window_label,
        true,
        None::<&str>,
    )?;
    let toggle_desktop_lyric_label = if desktop_lyric_visible(app) {
        "隐藏桌面歌词"
    } else {
        "显示桌面歌词"
    };
    let toggle_desktop_lyric = MenuItem::with_id(
        app,
        "toggle_desktop_lyric",
        toggle_desktop_lyric_label,
        true,
        None::<&str>,
    )?;
    let toggle_lock_label = if desktop_lyric_locked() {
        "解锁桌面歌词"
    } else {
        "锁定桌面歌词"
    };
    let toggle_desktop_lyric_lock = MenuItem::with_id(
        app,
        "toggle_desktop_lyric_lock",
        toggle_lock_label,
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &prev,
            &play_pause,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &show,
            &PredefinedMenuItem::separator(app)?,
            &toggle_desktop_lyric,
            &toggle_desktop_lyric_lock,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )
}

fn refresh_menu_bar_lyric(app: &tauri::AppHandle) {
    let Some(tray) = menu_bar_tray(app) else {
        return;
    };

    if !is_status_bar_lyric_enabled(app) {
        #[cfg(target_os = "macos")]
        {
            if let Ok(mut state) = menu_bar_lyric_state().lock() {
                state.source_text.clear();
                state.scroll_offset = 0;
                state.scroll_wait_until = None;
                if state.last_title != INVISIBLE_PLACEHOLDER {
                    state.last_title = INVISIBLE_PLACEHOLDER.to_string();
                    let _ = tray.set_title(Some(INVISIBLE_PLACEHOLDER));
                }
            } else {
                let _ = tray.set_title(Some(INVISIBLE_PLACEHOLDER));
            }
            let _ = tray.set_tooltip(Some(""));
        }
        return;
    }

    let _ = tray.set_tooltip(Some("树夏Music"));

    #[cfg(target_os = "macos")]
    {
        let title = {
            let mut state = match menu_bar_lyric_state().lock() {
                Ok(state) => state,
                Err(_) => return,
            };
            recompute_menu_bar_source_text(&mut state);
            let title = compute_menu_bar_display_title(&state);
            if title == state.last_title {
                return;
            }
            state.last_title = title.clone();
            title
        };
        let _ = tray.set_title(Some(&title));
    }
}

pub(crate) fn update_tray_menu(app: &tauri::AppHandle) {
    let Some(tray) = menu_bar_tray(app) else {
        return;
    };

    if !is_tray_interactive(app) {
        let _ = tray.set_tooltip(Some(""));
        let _ = tray.set_menu(None::<Menu<tauri::Wry>>);
        #[cfg(target_os = "macos")]
        {
            let _ = tray.set_title(Some(INVISIBLE_PLACEHOLDER));
        }
        return;
    }

    if let Ok(menu) = build_tray_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
    refresh_menu_bar_lyric(app);
}

fn parse_event_payload(payload: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(payload)
        .unwrap_or_else(|_| serde_json::Value::String(payload.to_string()))
}

fn apply_app_progress(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let progress = payload
        .get("progress")
        .and_then(|value| value.as_f64())
        .unwrap_or(-1.0);
    let paused = payload
        .get("paused")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let state = if progress < 0.0 || !progress.is_finite() {
        ProgressBarState {
            status: Some(ProgressBarStatus::None),
            progress: None,
        }
    } else {
        ProgressBarState {
            status: Some(if paused {
                ProgressBarStatus::Paused
            } else {
                ProgressBarStatus::Normal
            }),
            progress: Some((progress.clamp(0.0, 1.0) * 100.0).round() as u64),
        }
    };
    let _ = window.set_progress_bar(state);
}

fn plain_menu_bar_lyric_line(line: &serde_json::Value) -> String {
    if let Some(text) = line.as_str() {
        return normalize_menu_bar_text(text);
    }

    if let Some(words) = line.get("words").and_then(|value| value.as_array()) {
        return normalize_menu_bar_text(
            &words
                .iter()
                .filter_map(|word| word.get("word").and_then(|value| value.as_str()))
                .collect::<Vec<_>>()
                .join(""),
        );
    }

    ["text", "lyric", "line"]
        .iter()
        .find_map(|key| line.get(*key).and_then(|value| value.as_str()))
        .map(normalize_menu_bar_text)
        .unwrap_or_default()
}

fn apply_menu_bar_song_change(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let (name, artist) = if let Some(text) = payload.as_str() {
        (normalize_menu_bar_text(text), String::new())
    } else {
        (
            payload
                .get("name")
                .or_else(|| payload.get("title"))
                .and_then(|value| value.as_str())
                .map(normalize_menu_bar_text)
                .unwrap_or_default(),
            payload
                .get("artist")
                .or_else(|| payload.get("singer"))
                .and_then(|value| value.as_str())
                .map(normalize_menu_bar_text)
                .unwrap_or_default(),
        )
    };

    let title = format_menu_bar_song_title(&name, &artist);
    if !title.is_empty() {
        if let Some(db) = app.try_state::<Database>() {
            db.set_setting(MENU_BAR_LYRIC_LAST_SONG_KEY, &title);
        }
    }

    if let Ok(mut state) = menu_bar_lyric_state().lock() {
        state.song_name = name;
        state.artist = artist;
        if !title.is_empty() {
            state.persisted_song_title = title;
        }
        // Electron setSong clears lyrics/index before refresh so old lyric
        // lines never flash under the new song title.
        state.lyrics.clear();
        state.current_index = -1;
        recompute_menu_bar_source_text(&mut state);
    }
    refresh_menu_bar_lyric(app);
}

fn apply_menu_bar_lyric_change(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let lyrics = payload
        .as_array()
        .map(|lines| {
            lines
                .iter()
                .map(plain_menu_bar_lyric_line)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if let Ok(mut state) = menu_bar_lyric_state().lock() {
        state.lyrics = lyrics;
        state.current_index = -1;
        recompute_menu_bar_source_text(&mut state);
    }
    refresh_menu_bar_lyric(app);
}

fn apply_menu_bar_lyric_index(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let index = payload.as_i64().unwrap_or(-1) as isize;
    if let Ok(mut state) = menu_bar_lyric_state().lock() {
        state.current_index = index;
        recompute_menu_bar_source_text(&mut state);
    }
    refresh_menu_bar_lyric(app);
}

fn apply_menu_bar_play_status(app: &tauri::AppHandle, payload: &serde_json::Value) {
    if let Ok(mut state) = menu_bar_lyric_state().lock() {
        state.play_status = payload.as_bool().unwrap_or(false);
        recompute_menu_bar_source_text(&mut state);
    }
    refresh_menu_bar_lyric(app);
}

fn apply_menu_bar_direct_text(app: &tauri::AppHandle, payload: &serde_json::Value) {
    let text = payload
        .as_str()
        .map(normalize_menu_bar_text)
        .unwrap_or_default();
    if let Ok(mut state) = menu_bar_lyric_state().lock() {
        if text.is_empty() {
            recompute_menu_bar_source_text(&mut state);
        } else if text != state.source_text {
            state.source_text = text;
            state.scroll_offset = 0;
            state.scroll_wait_until =
                Some(Instant::now() + Duration::from_millis(SCROLL_START_DELAY_MS));
        }
    }
    refresh_menu_bar_lyric(app);
}

fn init_menu_bar_lyric_state(app: &tauri::AppHandle) {
    if let Some(db) = app.try_state::<Database>() {
        if let Some(title) = db.get_setting(MENU_BAR_LYRIC_LAST_SONG_KEY) {
            if let Ok(mut state) = menu_bar_lyric_state().lock() {
                state.persisted_song_title = normalize_menu_bar_text(&title);
                // Seed source_text immediately so the tray title is visible
                // before the renderer finishes mounting the lyric bridge.
                recompute_menu_bar_source_text(&mut state);
            }
        }
    }
}

fn install_menu_bar_lyric_listeners(app: &tauri::App) {
    {
        let handle = app.handle().clone();
        handle
            .clone()
            .listen("mac-status-bar-lyric-changed", move |event| {
                let payload = parse_event_payload(event.payload());
                let enabled = payload.as_bool().unwrap_or(false);
                if let Ok(mut state) = menu_bar_lyric_state().lock() {
                    // Force the next refresh to re-apply title even if text
                    // matches the previous frame (enable/disable toggle).
                    state.last_title.clear();
                    if !enabled {
                        state.source_text.clear();
                        state.scroll_offset = 0;
                        state.scroll_wait_until = None;
                    }
                }
                update_tray_menu(&handle);
                if enabled {
                    #[cfg(target_os = "macos")]
                    if let Some(tray) = menu_bar_tray(&handle) {
                        apply_mac_tray_monospaced_title_font(&tray);
                    }
                    refresh_menu_bar_lyric(&handle);
                }
            });
    }
    {
        let handle = app.handle().clone();
        handle.clone().listen("play-song-change", move |event| {
            apply_menu_bar_song_change(&handle, &parse_event_payload(event.payload()));
        });
    }
    {
        let handle = app.handle().clone();
        handle.clone().listen("play-lyric-change", move |event| {
            apply_menu_bar_lyric_change(&handle, &parse_event_payload(event.payload()));
        });
    }
    {
        let handle = app.handle().clone();
        handle.clone().listen("play-lyric-index", move |event| {
            apply_menu_bar_lyric_index(&handle, &parse_event_payload(event.payload()));
        });
    }
    {
        let handle = app.handle().clone();
        handle.clone().listen("play-status-change", move |event| {
            apply_menu_bar_play_status(&handle, &parse_event_payload(event.payload()));
        });
    }
    {
        let handle = app.handle().clone();
        handle.clone().listen("update-tray-lyric", move |event| {
            apply_menu_bar_direct_text(&handle, &parse_event_payload(event.payload()));
        });
    }
    {
        let handle = app.handle().clone();
        handle
            .clone()
            .listen("desktop-lyric-open-change", move |_| {
                update_tray_menu(&handle);
            });
    }
    {
        let handle = app.handle().clone();
        handle.clone().listen("toogleDesktopLyricLock", move |_| {
            update_tray_menu(&handle);
        });
    }
}

fn start_menu_bar_lyric_marquee(app: tauri::AppHandle) {
    if MENU_BAR_MARQUEE_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(SCROLL_INTERVAL_MS)).await;
            if !is_status_bar_lyric_enabled(&app) {
                continue;
            }

            let should_refresh = {
                let mut state = match menu_bar_lyric_state().lock() {
                    Ok(state) => state,
                    Err(_) => continue,
                };
                // Electron restarts marquee whenever sourceText exceeds DISPLAY_WIDTH,
                // independent of play/pause. playStatus only affects source text selection
                // (and currently matches the lyric-or-fallback path either way).
                if state.source_text.is_empty()
                    || get_menu_bar_visual_width(&state.source_text) <= DISPLAY_WIDTH
                    || !state.play_status
                    || state
                        .scroll_wait_until
                        .is_some_and(|instant| Instant::now() < instant)
                {
                    false
                } else {
                    let marquee_source = format!(
                        "{}{}",
                        state.source_text,
                        get_menu_bar_scroll_gap(&state.source_text),
                    );
                    let total_visual = get_menu_bar_visual_width(&marquee_source);
                    if total_visual == 0 {
                        false
                    } else {
                        state.scroll_offset =
                            (state.scroll_offset + SCROLL_STEP_VISUAL_UNITS) % total_visual;
                        true
                    }
                }
            };

            if should_refresh {
                refresh_menu_bar_lyric(&app);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn load_tray_icon() -> tauri::image::Image<'static> {
    let img = image::load_from_memory(include_bytes!("../icons/32x32.png"))
        .expect("Failed to decode tray icon")
        .into_rgba8();
    let (width, height) = img.dimensions();
    tauri::image::Image::new_owned(img.into_raw(), width, height)
}

/// Electron uses nativeImage.createEmpty() so the macOS status item can host
/// a title without painting a visible glyph. Tauri still needs a concrete
/// Image for NSStatusItem; a 1x1 transparent pixel matches that behavior.
#[cfg(target_os = "macos")]
fn load_empty_tray_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1)
}

#[cfg(target_os = "macos")]
fn migrate_mac_tray_preferred_position_to_guid() {
    // Older Tauri builds autosaved as Item-0. Once we pin Electron's GUID, copy
    // the dragged position across so the item does not jump on first relaunch.
    use std::process::Command;
    let domain = std::env::var("APP_IDENTIFIER").unwrap_or_else(|_| {
        // tauri dev bare binary uses process-name defaults domain; packaged uses bundle id.
        "shuxia-tauri".to_string()
    });
    let legacy_key = "NSStatusItem Preferred Position Item-0";
    let guid_key = format!("NSStatusItem Preferred Position {MAC_TRAY_GUID}");
    let read = |key: &str| -> Option<f64> {
        let out = Command::new("defaults")
            .args(["read", &domain, key])
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    };
    if read(&guid_key).is_some() {
        return;
    }
    if let Some(pos) = read(legacy_key) {
        let _ = Command::new("defaults")
            .args(["write", &domain, &guid_key, "-float", &pos.to_string()])
            .status();
        eprintln!("[mac-status-bar] migrated preferred position Item-0 -> GUID ({pos})");
    }
}

#[cfg(target_os = "macos")]
fn pin_mac_tray_autosave_name(tray: &tauri::tray::TrayIcon) {
    // Electron: `new Tray(emptyImage, MAC_TRAY_GUID)` -> NSStatusItem.setAutosaveName(guid)
    // so Cmd-drag position survives quit/relaunch. Tauri tray ids are only in-process;
    // bridge to AppKit here.
    migrate_mac_tray_preferred_position_to_guid();
    let result = tray.with_inner_tray_icon(|inner| {
        let Some(item) = inner.ns_status_item() else {
            return false;
        };
        use objc2::msg_send;
        use objc2::runtime::AnyObject;
        use objc2_foundation::NSString;
        let name = NSString::from_str(MAC_TRAY_GUID);
        item.setAutosaveName(Some(&*name));
        // Belt-and-suspenders: also set via msg_send in case the typed binding
        // no-ops under a different objc2 feature set.
        let item_ptr = (&*item) as *const _ as *mut AnyObject;
        let name_ptr = (&*name) as *const _ as *mut AnyObject;
        let _: () = unsafe { msg_send![item_ptr, setAutosaveName: name_ptr] };
        let current: *mut AnyObject = unsafe { msg_send![item_ptr, autosaveName] };
        let ok = !current.is_null();
        if ok {
            eprintln!("[mac-status-bar] pinned NSStatusItem autosaveName={MAC_TRAY_GUID}");
        } else {
            eprintln!("[mac-status-bar] failed to pin NSStatusItem autosaveName");
        }
        ok
    });
    if let Err(error) = result {
        eprintln!("[mac-status-bar] with_inner_tray_icon failed: {error}");
    }
}

#[cfg(target_os = "macos")]
fn apply_mac_tray_monospaced_title_font(tray: &tauri::tray::TrayIcon) {
    // Electron: tray.setTitle(title, { fontType: 'monospaced' }).
    // Stable advances keep the marquee from jittering as glyphs change.
    let _ = tray.with_inner_tray_icon(|inner| {
        use objc2::{msg_send, runtime::AnyObject};
        use objc2_foundation::NSString;

        let Some(item) = inner.ns_status_item() else {
            return false;
        };
        let item_ptr = (&*item) as *const _ as *mut AnyObject;
        if item_ptr.is_null() {
            return false;
        }
        unsafe {
            let button: *mut AnyObject = msg_send![item_ptr, button];
            if button.is_null() {
                return false;
            }
            let Some(ns_font) = objc2::runtime::AnyClass::get(c"NSFont") else {
                return false;
            };
            // Prefer modern monospaced digit-friendly system font; fall back to Menlo.
            let size: f64 = 13.0;
            let mut font: *mut AnyObject =
                msg_send![ns_font, monospacedSystemFontOfSize: size, weight: 0.0f64];
            if font.is_null() {
                let name = NSString::from_str("Menlo");
                font = msg_send![ns_font, fontWithName: &*name, size: size];
            }
            if font.is_null() {
                return false;
            }
            let _: () = msg_send![button, setFont: font];
            true
        }
    });
}

fn clear_mac_tray_icon_for_title_only(tray: &tauri::tray::TrayIcon) {
    // tray-icon forces a 1x1 transparent image to 18px tall, which can eat the
    // title slot on some macOS versions. Electron uses a truly empty image and
    // shows title only; drop the icon after create so the button is title-led.
    let _ = tray.set_icon(None);
}

/// Setup system tray icon with context menu (playback controls, lyric toggles, show, quit).
fn setup_tray(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    init_menu_bar_lyric_state(app.handle());

    // Keep looking up the tray as "main" for existing helpers, but on macOS also
    // register under Electron's GUID so AppKit autosave and our id stay aligned.
    #[cfg(target_os = "macos")]
    let mut builder = TrayIconBuilder::with_id(MAC_TRAY_GUID).show_menu_on_left_click(true);
    #[cfg(not(target_os = "macos"))]
    let mut builder = TrayIconBuilder::with_id("main").show_menu_on_left_click(false);

    #[cfg(target_os = "macos")]
    {
        // Empty icon + ZWSP title mirrors Electron's title-only menu-bar lyric tray.
        builder = builder
            .icon(load_empty_tray_icon())
            .icon_as_template(true)
            .title(INVISIBLE_PLACEHOLDER)
            .tooltip("");
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.tooltip("树夏Music").icon(load_tray_icon());
    }

    if is_tray_interactive(app.handle()) {
        if let Ok(menu) = build_tray_menu(app.handle()) {
            builder = builder.menu(&menu);
        }
    }

    builder
        .on_menu_event(|app, event| match event.id().as_ref() {
            "prev" => {
                emit_music_control(app, "playPrev", None);
            }
            "play_pause" => {
                emit_music_control(app, "toggle", None);
            }
            "next" => {
                emit_music_control(app, "playNext", None);
            }
            "toggle_desktop_lyric" => {
                emit_music_control(app, "toggleDesktopLyric", None);
            }
            "toggle_desktop_lyric_lock" => {
                if let Some(db) = app.try_state::<Database>() {
                    let new_val = !desktop_lyric_locked();
                    let _ = set_desktop_lyric_lock(app.clone(), db, new_val);
                    update_tray_menu(app);
                }
            }
            "toggle_main_window" | "show" => {
                let action = decide_tray_left_click_action(app);
                apply_main_window_action(app, &action);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            #[cfg(not(target_os = "macos"))]
            {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    let app = tray.app_handle();
                    let action = decide_tray_left_click_action(app);
                    apply_main_window_action(app, &action);
                }
            }
        })
        .build(app)?;

    #[cfg(target_os = "macos")]
    if let Some(tray) = menu_bar_tray(app.handle()) {
        pin_mac_tray_autosave_name(&tray);
        clear_mac_tray_icon_for_title_only(&tray);
        // Re-apply title after icon clear so AppKit recomputes button width.
        let _ = tray.set_title(Some(INVISIBLE_PLACEHOLDER));
        apply_mac_tray_monospaced_title_font(&tray);
    }

    update_tray_menu(app.handle());
    // update_tray_menu already refreshes; call again after init so a persisted
    // song title paints even when the renderer has not pushed lyrics yet.
    refresh_menu_bar_lyric(app.handle());
    start_menu_bar_lyric_marquee(app.handle().clone());

    Ok(())
}

pub(crate) fn emit_music_control(
    app: &tauri::AppHandle,
    action: &str,
    value: Option<serde_json::Value>,
) {
    // Electron tray/hotkeys send dedicated renderer channels (`playPrev` /
    // `playNext` / `toggle` / ...). Keep that shape so Provider.vue listeners
    // and globalControls stay aligned instead of collapsing everything to pause.
    match action {
        "toggleDesktopLyric" => {
            if let Some(db) = app.try_state::<Database>() {
                let next = !desktop_lyric_visible(app);
                let _ = toggle_desktop_lyric(app.clone(), db, next);
                let _ = app.emit("desktopLyricVisibility", next);
            }
            return;
        }
        "playPrev"
        | "playNext"
        | "toggle"
        | "play"
        | "pause"
        | "volumeDelta"
        | "seekDelta"
        | "setPlayMode"
        | "hotkeys:toggle-audio-output-selector" => {
            if let Some(value) = value {
                let _ = app.emit(action, value);
            } else {
                let _ = app.emit(action, ());
            }
        }
        _ => {
            let mut payload = serde_json::json!({ "action": action });
            if let Some(value) = value.clone() {
                payload["value"] = value;
            }
            let _ = app.emit("music-control", payload);
            if let Some(value) = value {
                let _ = app.emit(action, value);
            } else {
                let _ = app.emit(action, ());
            }
        }
    }
}

fn main_window_state_payload(win: &tauri::WebviewWindow) -> serde_json::Value {
    let visible = win.is_visible().unwrap_or(false);
    let minimized = win.is_minimized().unwrap_or(false);
    serde_json::json!({
        "visible": visible,
        "focused": win.is_focused().unwrap_or(false),
        "minimized": minimized,
        "hidden": !visible || minimized,
        "fullscreen": win.is_fullscreen().unwrap_or(false)
            || windowed_fs::is_windowed_fullscreen(),
    })
}

fn emit_main_window_state(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    let _ = app.emit("app-window-state-changed", main_window_state_payload(win));
}

fn request_window_lifecycle_decision(
    app: &tauri::AppHandle,
    method: &str,
    payload: serde_json::Value,
    fallback_action: &str,
) -> String {
    commands::node_sidecar::node_sidecar_request_blocking(app.clone(), method.to_string(), payload)
        .ok()
        .and_then(|value| {
            value
                .get("decision")
                .and_then(|decision| decision.get("action"))
                .and_then(|action| action.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| fallback_action.to_string())
}

fn apply_main_window_action(app: &tauri::AppHandle, action: &str) {
    if action == "exit-app" {
        app.exit(0);
        return;
    }

    let Some(win) = app.get_webview_window("main") else {
        return;
    };

    match action {
        "hide-main-window" => {
            let _ = win.hide();
        }
        "show-main-window" | "show-and-focus-main-window" => {
            let _ = win.show();
            let _ = win.set_focus();
        }
        "restore-and-focus-main-window" => {
            let _ = win.unminimize();
            let _ = win.show();
            let _ = win.set_focus();
        }
        _ => {}
    }

    update_tray_menu(app);
    emit_main_window_state(app, &win);
}

fn decide_close_action(app: &tauri::AppHandle, win: &tauri::WebviewWindow) -> String {
    let close_to_tray = win
        .try_state::<Database>()
        .and_then(|db| db.get_setting("close_to_tray"))
        .map(|v| v == "true")
        .unwrap_or(true);

    request_window_lifecycle_decision(
        app,
        "system.windowLifecycle.decideClose",
        serde_json::json!({
            "closeToTray": close_to_tray,
            "window": main_window_state_payload(win),
        }),
        if close_to_tray {
            "hide-main-window"
        } else {
            "exit-app"
        },
    )
}

fn decide_tray_left_click_action(app: &tauri::AppHandle) -> String {
    let window = app
        .get_webview_window("main")
        .map(|win| main_window_state_payload(&win))
        .unwrap_or_else(|| {
            serde_json::json!({
                "visible": false,
                "focused": false,
                "minimized": false,
                "hidden": true,
                "fullscreen": false,
            })
        });

    let fallback_action = if window
        .get("hidden")
        .and_then(|hidden| hidden.as_bool())
        .unwrap_or(true)
    {
        "show-and-focus-main-window"
    } else {
        "hide-main-window"
    };

    request_window_lifecycle_decision(
        app,
        "system.windowLifecycle.decideTrayLeftClick",
        serde_json::json!({
            "platform": std::env::consts::OS,
            "window": window,
        }),
        fallback_action,
    )
}

fn parse_deep_link_payload(payload: &str) -> Vec<String> {
    let trimmed = payload.trim();
    let parsed = serde_json::from_str::<serde_json::Value>(trimmed);
    let urls = match parsed {
        Ok(serde_json::Value::String(url)) => vec![url],
        Ok(serde_json::Value::Array(items)) => items
            .into_iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect(),
        Ok(serde_json::Value::Object(map)) => {
            if let Some(urls) = map.get("urls").and_then(|value| value.as_array()) {
                urls.iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            } else if let Some(url) = map
                .get("url")
                .or_else(|| map.get("href"))
                .and_then(|value| value.as_str())
            {
                vec![url.to_string()]
            } else {
                Vec::new()
            }
        }
        _ if trimmed.starts_with("shuxiamusic://")
            || trimmed.starts_with("cerumusic://") =>
        {
            vec![trimmed.to_string()]
        }
        _ => Vec::new(),
    };

    urls.into_iter()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .collect()
}

fn handle_deep_link_url(handle: &tauri::AppHandle, url: String) {
    eprintln!("[deep-link] 收到 URL: {}", url);

    if url.contains("/oauth/callback") {
        push_pending_oauth_callback(url.clone());
        let _ = handle.emit("logto-callback", &url);
        return;
    }
    if url.contains("/oauth/logout-callback") {
        eprintln!("[deep-link] OAuth 登出回调: {}", url);
        return;
    }
    if url.contains("/playlist/share/") {
        let id = url.rsplit('/').next().unwrap_or_default().to_string();
        if !id.is_empty() {
            push_pending_playlist_share_id(id.clone());
            let _ = handle.emit("playlist-share-open", serde_json::json!({ "id": id }));
        }
        return;
    }
    if url.contains("/share/") {
        let id = url.rsplit('/').next().unwrap_or_default().to_string();
        if !id.is_empty() {
            push_pending_share_id(id.clone());
            let _ = handle.emit("share-open", serde_json::json!({ "id": id }));
        }
        return;
    }
    if url.contains("/plugin/add/link") {
        let _ = handle.emit("plugin-add-link", &url);
        return;
    }
    if url.contains("/play/next") {
        emit_music_control(handle, "playNext", None);
        return;
    }
    if url.contains("/play/prev") {
        emit_music_control(handle, "playPrev", None);
        return;
    }
    if url.contains("/play/toggle") {
        emit_music_control(handle, "toggle", None);
        return;
    }
    if url.contains("/lt/") {
        let code = url.rsplit('/').next().unwrap_or_default().to_string();
        if !code.is_empty() {
            push_pending_lt_code(code.clone());
            let _ = handle.emit("lt-share-open", serde_json::json!({ "code": code }));
        }
        return;
    }
    if url.contains("/open-playlist") {
        let path = url
            .replacen("shuxiamusic://open-playlist/", "", 1)
            .replacen("cerumusic://open-playlist/", "", 1);
        if !path.is_empty() {
            push_pending_open_playlist_file(path.clone());
            let _ = handle.emit("open-playlist-file", &path);
        }
        return;
    }

    eprintln!("[deep-link] 未识别的 URL: {}", url);
}

/// release 包会 strip 符号，系统崩溃报告里只剩 `tao::send_event` 这种框架帧，
/// 定位不到真正的 panic 点。这里把 panic 的文件、行号和消息追加到日志里。
fn install_panic_logger() {
    std::panic::set_hook(Box::new(|info| {
        use std::io::Write;

        let location = info
            .location()
            .map(|value| value.to_string())
            .unwrap_or_else(|| "<unknown location>".to_string());
        let message = if let Some(text) = info.payload().downcast_ref::<&str>() {
            (*text).to_string()
        } else if let Some(text) = info.payload().downcast_ref::<String>() {
            text.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let line = format!(
            "[{}] {location}\n{message}\n",
            chrono::Local::now().to_rfc3339()
        );

        let _ = writeln!(std::io::stderr(), "{line}");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::env::temp_dir().join("shuxia-music-panic.log"))
        {
            let _ = file.write_all(line.as_bytes());
        }
    }));
}

/// 把设置里指向旧 bundle id (com.cerumusic.tauri) 的存储目录改写到当前 app_data_dir。
/// 更名后 `cache_dir`/`download_dir` 若仍写死旧标识，会指向已迁移目录下的死路径；
/// 这里只在"旧前缀命中"时改写并回写，不改动用户自定义的其他绝对路径。
fn remap_legacy_storage_dirs(database: &Database, app_data_dir: &std::path::Path) {
    let Some(new_base) = app_data_dir.to_str().map(|s| s.to_string()) else {
        return;
    };
    let Some(parent) = app_data_dir.parent() else {
        return;
    };
    let old_base = parent
        .join("com.cerumusic.tauri")
        .to_string_lossy()
        .to_string();
    if old_base.is_empty() || old_base == new_base {
        return;
    }
    for key in ["cache_dir", "download_dir"] {
        let Some(raw) = database.get_setting(key) else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.starts_with(&old_base) {
            let suffix = &trimmed[old_base.len()..];
            let fixed = format!("{new_base}{suffix}");
            database.set_setting(key, fixed.trim());
            eprintln!("[legacy-storage] 纠正 {key}: {trimmed} -> {fixed}");
        }
    }
}

/// 一次性把旧 bundle id (com.cerumusic.tauri) 的应用数据迁移到新目录。
/// 仅当新目录还没有数据库、而旧目录存在时执行；优先用 rename 原子移动（同卷极快），
/// 跨卷失败时退化为复制，且不覆盖新目录已有文件（保留新数据）。
fn migrate_legacy_app_data(new_dir: &std::path::Path) -> Result<(), String> {
    use std::path::Path;
    let Some(parent) = new_dir.parent() else {
        return Ok(());
    };
    let legacy = parent.join("com.cerumusic.tauri");
    if !legacy.is_dir() {
        return Ok(());
    }
    // 已迁移（新目录已存在新库或旧库）则跳过
    if new_dir.join("shuxia-music.db").exists() || new_dir.join("ceru-music.db").exists() {
        return Ok(());
    }
    std::fs::create_dir_all(new_dir).map_err(|e| e.to_string())?;

    for entry in std::fs::read_dir(&legacy).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = new_dir.join(entry.file_name());
        if to.exists() {
            continue; // 新目录已有该条目，保留新数据
        }
        if std::fs::rename(&from, &to).is_err() {
            // 跨卷等情况退化为复制
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                copy_dir_no_overwrite(&from, &to)?;
            } else if file_type.is_file() {
                std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
            }
        }
    }

    // 重命名旧数据库 ceru-music.db -> shuxia-music.db
    let old_db = new_dir.join("ceru-music.db");
    let new_db = new_dir.join("shuxia-music.db");
    if old_db.exists() && !new_db.exists() {
        let _ = std::fs::rename(&old_db, &new_db);
    }
    Ok(())
}

fn copy_dir_no_overwrite(src: &std::path::Path, dst: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            copy_dir_no_overwrite(&from, &to)?;
        } else if file_type.is_file() {
            if !to.exists() {
                std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

pub fn run() {
    install_panic_logger();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| handle_shortcut(app, shortcut, event))
                .build(),
        )
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            // 更名迁移：Ceru(com.cerumusic.tauri) -> 树夏(com.shuxiamusic.tauri)
            // bundle id 变化会让 app_data_dir 指向新目录；首次启动把旧目录数据搬过来，
            // 并把旧库 ceru-music.db 重命名为 shuxia-music.db，避免数据库/下载/歌单丢失。
            migrate_legacy_app_data(&app_data_dir)?;
            let database = Database::new(app_data_dir.clone())?;
            // 存储目录设置里若仍指向旧 bundle id (com.cerumusic.tauri) 的路径，
            // 会变成一个指向已迁移目录的死路径（下载/缓存写错地方、"打开目录"打不开）。
            // 启动时把这类设置纠正回当前 app_data_dir，避免用户看到的下载/缓存目录错位。
            remap_legacy_storage_dirs(&database, &app_data_dir);
            app.manage(database);

            if let Err(error) = commands::cover_proxy::ensure_cover_proxy(app.handle().clone()) {
                eprintln!("[cover-proxy] 启动失败: {}", error);
            }

            // ---- 注册深度链接协议（主 scheme shuxiamusic://；保留 cerumusic:// 兼容旧端过渡）----
            // 处理 OAuth 登录回调、分享、歌单分享、插件安装、播放控制、歌单文件导入、一起听邀请
            {
                let handle = app.handle().clone();
                if let Err(e) = app.deep_link().register("shuxiamusic") {
                    eprintln!("注册深度链接(shuxiamusic)失败: {}", e);
                }
                // 兼容：旧安卓/服务端可能仍发 cerumusic://，保留注册使过渡期不断开
                if let Err(e) = app.deep_link().register("cerumusic") {
                    eprintln!("注册深度链接(cerumusic 兼容)失败: {}", e);
                }
                app.listen("deep-link://new-url", move |event| {
                    let urls = parse_deep_link_payload(event.payload());
                    if urls.is_empty() {
                        return;
                    }

                    for url in urls {
                        handle_deep_link_url(&handle, url);
                    }
                });
            }

            // User hotkeys plus Electron-style hardware media keys.
            let _ = apply_global_hotkeys(app.handle());
            eprintln!("[setup] before now playing");
            init_now_playing(app.handle());
            eprintln!("[setup] after now playing");

            // 真实系统睡眠/唤醒监听：唤醒后 MPV 的 CoreAudio AO 常静默失效，
            // 向 Webview 派发 app-system-wake 让前端重建音频输出。
            // 注意与窗口可见性唤醒(ceru-wake)严格区分，窗口级唤醒不得触发 AO 重建。
            system_power::init_system_power_watcher(app.handle());

            // 默认输出设备变化监听（耳机插拔 / 蓝牙连断）：向 Webview 派发
            // app-audio-device-changed，前端据此(a)重建 MPV 音频输出，(b)抑制
            // macOS 在设备变化时替 App 发的系统媒体指令（避免"戴上耳机自动播"）。
            audio_device::init_audio_device_watcher(app.handle());

            // ---- 监听前端同步的 close_to_tray 设置，写入 DB ----
            let handle = app.handle().clone();
            handle.listen("settings:sync-close-to-tray", {
                let handle = handle.clone();
                move |event| {
                    if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload())
                    {
                        if let Some(value) = payload.get("value").and_then(|v| v.as_bool()) {
                            if let Some(db) = handle.try_state::<Database>() {
                                db.set_setting(
                                    "close_to_tray",
                                    if value { "true" } else { "false" },
                                );
                            }
                        }
                    }
                }
            });

            {
                let handle = app.handle().clone();
                app.handle().listen("app-close-request-ack", move |_| {
                    CLOSE_REQUEST_ACK.store(true, Ordering::SeqCst);
                    update_tray_menu(&handle);
                });
            }

            // ---- 关闭按钮行为：根据 close_to_tray 决定 ----
            //   true  → prevent_close() + 后端直接隐藏主窗口
            //   false → 退出应用
            // ---- 同时监听全屏切换（Resized 事件 + is_fullscreen 查询）----
            if let Some(win) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                hide_macos_window_buttons(&win);

                #[cfg(target_os = "macos")]
                cap_wkwebview_url_cache();

                let win2 = win.clone();
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        CLOSE_REQUEST_ACK.store(false, Ordering::SeqCst);
                        let _ = app_handle
                            .emit("app-close-requested", main_window_state_payload(&win2));
                        let app_for_fallback = app_handle.clone();
                        let win_for_fallback = win2.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(250)).await;
                            if CLOSE_REQUEST_ACK.load(Ordering::SeqCst) {
                                return;
                            }
                            let action = decide_close_action(&app_for_fallback, &win_for_fallback);
                            apply_main_window_action(&app_for_fallback, &action);
                        });
                    }
                    tauri::WindowEvent::Resized(_) => {
                        let is_full = win2.is_fullscreen().unwrap_or(false)
                            || windowed_fs::is_windowed_fullscreen();
                        if is_full {
                            if !LAST_FULLSCREEN.swap(true, Ordering::SeqCst) {
                                let _ = app_handle.emit("app-fullscreen-changed", true);
                            }
                        } else if LAST_FULLSCREEN.swap(false, Ordering::SeqCst) {
                            let _ = app_handle.emit("app-fullscreen-changed", false);
                        }
                        emit_main_window_state(&app_handle, &win2);
                        update_tray_menu(&app_handle);
                    }
                    tauri::WindowEvent::Focused(focused) => {
                        emit_main_window_state(&app_handle, &win2);
                        if !focused {
                            update_tray_menu(&app_handle);
                        }
                        let app_later = app_handle.clone();
                        let win_later = win2.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(80)).await;
                            emit_main_window_state(&app_later, &win_later);
                        });
                    }
                    _ => {}
                });
            }

            // ---- 系统托盘 ----
            setup_tray(app)?;
            install_menu_bar_lyric_listeners(app);

            // Restore the desktop lyric window after a restart. The renderer
            // treats the native window as the source of truth, so leaving a
            // persisted `isOpen: true` without creating the window made the
            // button state and the actual window diverge.
            if let Some(db) = app.try_state::<Database>() {
                let option = read_desktop_lyric_option(app.handle(), &db);
                if option
                    .get("isOpen")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
                {
                    let _ = toggle_desktop_lyric(app.handle().clone(), db, true);
                }
            }

            // ---- 桌面歌词窗口事件监听 ----
            // 这些事件由 DeskTopLyric.vue 通过 window.electron.ipcRenderer.send() 发出，
            // 在 Tauri bridge 中映射为 emit()，此处用全局监听处理。
            {
                let handle = app.handle().clone();
                handle.clone().listen("closeDesktopLyric", move |_| {
                    if let Some(win) = handle.get_webview_window("desktop-lyric") {
                        let _ = win.close();
                    }
                });
            }
            {
                let handle = app.handle().clone();
                handle.clone().listen("win-show", move |_| {
                    if let Some(win) = handle.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.set_focus();
                    }
                });
            }
            // Desktop lyric window controls: send-main-event → dedicated play channels.
            {
                let handle = app.handle().clone();
                handle.clone().listen("send-main-event", move |event| {
                    let payload = event.payload();
                    let action = serde_json::from_str::<String>(payload).ok().or_else(|| {
                        serde_json::from_str::<serde_json::Value>(payload)
                            .ok()
                            .and_then(|value| match value {
                                serde_json::Value::String(s) => Some(s),
                                serde_json::Value::Array(items) => items
                                    .first()
                                    .and_then(|item| item.as_str().map(|s| s.to_string())),
                                serde_json::Value::Object(map) => map
                                    .get("action")
                                    .or_else(|| map.get("name"))
                                    .and_then(|item| item.as_str().map(|s| s.to_string())),
                                _ => None,
                            })
                    });
                    if let Some(action) = action {
                        if !action.is_empty() {
                            emit_music_control(&handle, &action, None);
                        }
                    }
                });
            }
            // move-window fallback (light bridge prefers the typed command).
            // Coordinates are already top-left desktop logical pixels.
            {
                let handle = app.handle().clone();
                handle.clone().listen("move-window", move |event| {
                    if let Ok(coords) = serde_json::from_str::<Vec<f64>>(event.payload()) {
                        if coords.len() >= 4 {
                            if let Some(db) = handle.try_state::<Database>() {
                                let _ = move_desktop_lyric_window(
                                    handle.clone(),
                                    db,
                                    coords[0],
                                    coords[1],
                                    coords[2],
                                    coords[3],
                                );
                            }
                        }
                    }
                });
            }
            // update-window-height: payload is a single number
            {
                let handle = app.handle().clone();
                handle.clone().listen("update-window-height", move |event| {
                    if let Ok(height) = serde_json::from_str::<f64>(event.payload()) {
                        let mut width = None;
                        if let Some(win) = handle.get_webview_window("desktop-lyric") {
                            if let Ok(size) = win.outer_size() {
                                width = Some(size.width as f64);
                                let _ = win
                                    .set_size(tauri::PhysicalSize::new(size.width as f64, height));
                            }
                        }
                        if let Some(db) = handle.try_state::<Database>() {
                            let mut option = serde_json::json!({ "height": height });
                            if let Some(width) = width {
                                option["width"] = serde_json::json!(width);
                            }
                            let _ = save_desktop_lyric_partial(handle.clone(), db, option);
                        }
                    }
                });
            }
            {
                let handle = app.handle().clone();
                handle.clone().listen("change-desktop-lyric", move |event| {
                    if let Ok(show) = serde_json::from_str::<bool>(event.payload()) {
                        if let Some(db) = handle.try_state::<Database>() {
                            let _ = toggle_desktop_lyric(handle.clone(), db, show);
                        }
                    }
                });
            }

            // ---- Node sidecar 业务层基座 ----
            commands::node_sidecar::init(app.handle());

            // ---- 原生音频内核骨架 ----
            commands::native_audio::init(app.handle());
            commands::mpv_player::init(app.handle());

            // ---- 下载引擎 ----
            commands::download_engine::init(app.handle());

            // ---- DLNA 投屏 ----
            commands::dlna::init(app.handle());

            // ---- 跨平台兼容性事件监听 ----
            // 以下事件在 macOS 上多为无操作，但添加监听器可避免"未处理事件"警告。
            // Windows 缩略图工具栏（macOS 无对应功能）
            app.handle().listen("thumbar:set-state", |_| {});
            app.handle().listen("thumbar:set-cover", |_| {});
            // 应用进度条：播放进度更新为 Normal/Paused，-1 清理系统进度。
            let app_handle = app.handle().clone();
            app.handle().listen("app:set-progress", move |event| {
                apply_app_progress(&app_handle, &parse_event_payload(event.payload()));
            });
            // Ping 服务生命周期（前端自行处理歌曲结束检测）
            app.handle().listen("startPing", |_| {});
            app.handle().listen("stopPing", |_| {});

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Node sidecar
            node_sidecar_request,
            node_sidecar_health,
            // Download 元数据补写（Node 下载引擎落盘后，按"下载标签写入设置"写封面/歌词/基础信息）
            download_finalize_metadata,
            // Desktop lyric window
            toggle_desktop_lyric,
            get_desktop_lyric_option,
            set_desktop_lyric_option,
            set_desktop_lyric_lock,
            lyric_window_get_open_state,
            get_window_bounds,
            get_cursor_position,
            get_screen_size,
            get_all_work_area,
            get_lyric_lock_state,
            get_lyric_open_state,
            move_desktop_lyric_window,
            update_desktop_lyric_window_height,
            close_desktop_lyric_window,
            desktop_lyric_window_ready,
            show_main_window,
            // Windowed fullscreen (网易云式，盖住菜单栏/状态栏)
            windowed_fs::windowed_fullscreen_get,
            windowed_fs::windowed_fullscreen_set,
            // Song list
            songlist_get_all,
            songlist_get_by_id,
            songlist_create,
            songlist_create_with_id,
            songlist_delete,
            songlist_batch_delete,
            songlist_edit,
            songlist_update_cover,
            songlist_exists,
            songlist_get_statistics,
            songlist_get_songs,
            songlist_get_song_count,
            songlist_has_song,
            songlist_get_song,
            songlist_add_songs,
            songlist_remove_song,
            songlist_remove_songs,
            songlist_clear_songs,
            songlist_search_songs,
            songlist_reorder_songs,
            songlist_reorder_playlists,
            songlist_move_song,
            songlist_get_song_statistics,
            // URL cache
            music_url_cache_get,
            music_url_cache_save,
            music_url_cache_invalidate,
            music_url_cache_clear,
            // Settings
            get_user_config,
            settings_get_close_to_tray,
            settings_get_native_impact_settings,
            settings_set_native_impact_settings,
            // Hotkeys
            hotkeys_get,
            hotkeys_set,
            hotkeys_set_recording,
            hotkeys::hotkeys_accessibility,
            now_playing_update,
            media_diag_log,
            permissions_request_microphone,
            // Directory settings
            directory_settings_get_directories,
            directory_settings_save_directories,
            directory_settings_reset_directories,
            // Local music
            local_music_get_dirs,
            local_music_set_dirs,
            local_music_get_list,
            local_music_clear_index,
            local_music_select_dirs,
            local_music_scan,
            local_music_write_tags,
            local_music_get_url,
            local_music_get_cover,
            local_music_get_covers,
            local_music_get_tags,
            local_music_get_lyric,
            local_music_batch_match,
            // Download
            download_get_tasks,
            download_pause_task,
            download_resume_task,
            download_cancel_task,
            download_delete_task,
            download_clear_tasks,
            download_pause_all_tasks,
            download_resume_all_tasks,
            download_retry_task,
            download_set_max_concurrent,
            download_get_max_concurrent,
            download_validate_files,
            download_open_file_location,
            download_queue_status,
            download_queue_cancel,
            // Song list extras
            songlist_search,
            songlist_get_favorites_id,
            songlist_set_favorites_id,
            songlist_validate_integrity,
            songlist_repair_data,
            songlist_force_save,
            // System
            music_cache_get_info,
            music_cache_get_size,
            music_cache_get_limit,
            music_cache_set_limit,
            music_cache_clear,
            // Misc: media metadata bridge
            music_resolve_playback_url,
            music_resolve_cover,
            music_get_comments,
            music_get_lyric,
            get_cover_proxy,
            get_lyric_proxy,
            get_play_url_proxy,
            // Misc: file system
            fs_read_file,
            // Misc: clipboard
            clipboard_read_text,
            // Misc: power save
            power_save_blocker_start,
            power_save_blocker_stop,
            // Misc: directory extras
            directory_settings_select_cache_dir,
            directory_settings_select_download_dir,
            directory_settings_open_directory,
            directory_settings_get_directory_size,
            // Misc: system audio (stubs)
            system_audio_prepare_capture,
            system_audio_get_default_source_id,
            system_audio_get_all_source_ids,
            // Misc: pending share / lt codes (stubs)
            get_pending_share_ids,
            get_pending_playlist_share_ids,
            get_pending_lt_codes,
            get_pending_open_playlist_files,
            get_pending_oauth_callbacks,
            // Misc: app version
            get_app_version,
            // Misc: dialog
            dialog_open_file,
            // Misc: font list
            get_font_list,
            // Misc: plugins (stubs)
            service_plugin_initialize_system,
            service_plugin_select_and_add_plugin,
            service_plugin_download_and_add_plugin,
            service_plugin_add_plugin,
            service_plugin_get_plugin_by_id,
            service_plugin_load_all_plugins,
            service_plugin_uninstall_plugin,
            service_plugin_get_plugin_log,
            service_plugin_get_plugin_type,
            service_plugin_get_config_schema,
            service_plugin_get_config,
            service_plugin_save_config,
            service_plugin_test_connection,
            service_plugin_get_playlists,
            service_plugin_get_playlist_songs,
            service_plugin_import_to_local,
            service_plugin_get_service_lyric,
            // Plugin sandbox proxy (frontend sandbox uses these)
            plugin_http_request,
            image_url_to_data_url,
            cover_proxy_url,
            cover_proxy_base,
            cover_cache_info,
            cover_cache_clear,
            plugin_crypto_md5,
            plugin_crypto_random_bytes,
            plugin_crypto_aes_encrypt,
            plugin_crypto_base64_encode,
            plugin_crypto_base64_decode,
            plugin_scan_dir,
            plugin_read_file,
            plugin_write_file,
            plugin_get_app_data_dir,
            // Plugin persistence (DB-backed)
            plugin_save_registry,
            plugin_load_registry,
            plugin_remove_registry,
            plugin_reorder_registry,
            plugin_save_config,
            plugin_load_config,
            // Misc: app flags
            app_flag_set,
            app_flag_get,
            // Misc: AI (stubs)
            ai_ask,
            ai_ask_stream,
            ai_recommend_songs,
            // Misc: share (stubs)
            service_share_get_plugin_code_and_md5,
            // MPV sidecar audio
            mpv_init,
            mpv_load,
            mpv_play,
            mpv_pause,
            mpv_toggle,
            mpv_stop,
            mpv_seek,
            mpv_set_volume,
            mpv_set_playback_rate,
            mpv_probe,
            mpv_set_audio_filters,
            mpv_get_state,
            mpv_reload_audio_output,
            mpv_debug_hot_ping,
            mpv_shutdown,
            // Native audio
            native_audio_load,
            native_audio_play,
            native_audio_pause,
            native_audio_stop,
            native_audio_seek,
            native_audio_set_volume,
            native_audio_set_playback_rate,
            native_audio_set_equalizer,
            native_audio_get_equalizer,
            native_audio_get_state,
            native_audio_list_output_devices,
            media_stream_proxy_url,
            // DLNA
            dlna_start_search,
            dlna_stop_search,
            dlna_get_devices,
            dlna_play,
            dlna_pause,
            dlna_resume,
            dlna_stop,
            dlna_seek,
            dlna_get_position,
            dlna_get_volume,
            dlna_set_volume,
            // Mac status bar lyric
            set_mac_status_bar_lyric,
            get_mac_status_bar_lyric,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                commands::node_sidecar::shutdown();
                let _ = commands::misc::power_save_blocker_stop();
                let _ = commands::mpv_player::mpv_shutdown(app_handle.clone());
            }
            _ => {}
        });
}
