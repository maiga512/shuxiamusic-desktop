use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::db::Database;
use crate::emit_music_control;
use crate::models::HotkeyEntry;
use crate::now_playing;

/// Electron always registers these, independent of the user hotkey table.
/// Tauri must do the same: hardware prev/next never live in `hotkeys`.
const MEDIA_KEY_BINDINGS: &[(&str, &str)] = &[
    ("toggle", "MediaPlayPause"),
    ("playNext", "MediaTrackNext"),
    ("playPrev", "MediaTrackPrevious"),
    ("pause", "MediaStop"),
];

const HARDWARE_FKEY_BINDINGS: &[(&str, &str)] =
    &[("playPrev", "F7"), ("toggle", "F8"), ("playNext", "F9")];

pub fn normalize_accelerator(raw: &str) -> String {
    let trimmed = raw.trim().replace(' ', "");
    match trimmed.to_ascii_uppercase().as_str() {
        "MEDIANEXTTRACK" => "MediaTrackNext".into(),
        "MEDIAPREVIOUSTRACK" => "MediaTrackPrevious".into(),
        "MEDIATRACKPREV" => "MediaTrackPrevious".into(),
        "MEDIAPLAYPAUSE" => "MediaPlayPause".into(),
        "MEDIASTOP" => "MediaStop".into(),
        "F7" => "F7".into(),
        "F8" => "F8".into(),
        "F9" => "F9".into(),
        _ => trimmed,
    }
}

pub fn parse_accelerator(raw: &str) -> Option<Shortcut> {
    let normalized = normalize_accelerator(raw);
    if normalized.is_empty() {
        return None;
    }
    Shortcut::try_from(normalized.as_str()).ok()
}

fn dispatch_hotkey_action(app: &tauri::AppHandle, action: &str) {
    match action {
        "seekForward" => emit_music_control(app, "seekDelta", Some(json!(5))),
        "seekBackward" => emit_music_control(app, "seekDelta", Some(json!(-5))),
        "volumeUp" => emit_music_control(app, "volumeDelta", Some(json!(5))),
        "volumeDown" => emit_music_control(app, "volumeDelta", Some(json!(-5))),
        "setPlayModeSequence" => emit_music_control(app, "setPlayMode", Some(json!("sequence"))),
        "setPlayModeRandom" => emit_music_control(app, "setPlayMode", Some(json!("random"))),
        "togglePlayModeSingle" => {
            emit_music_control(app, "setPlayMode", Some(json!("toggleSingle")))
        }
        "toggleAudioOutputSelector" => {
            emit_music_control(app, "hotkeys:toggle-audio-output-selector", None)
        }
        other => emit_music_control(app, other, None),
    }
}

fn match_user_hotkey(app: &tauri::AppHandle, shortcut: &Shortcut) -> Option<String> {
    let db = app.try_state::<Database>()?;
    if !db.hotkeys_enabled() {
        return None;
    }
    for hk in db.get_hotkeys() {
        if hk.shortcut.is_empty() {
            continue;
        }
        if let Some(expected) = parse_accelerator(&hk.shortcut) {
            if &expected == shortcut {
                return Some(hk.action);
            }
        }
    }
    None
}

fn match_media_hotkey(shortcut: &Shortcut) -> Option<&'static str> {
    for (action, accelerator) in MEDIA_KEY_BINDINGS
        .iter()
        .chain(HARDWARE_FKEY_BINDINGS.iter())
    {
        if let Some(expected) = parse_accelerator(accelerator) {
            if &expected == shortcut {
                return Some(*action);
            }
        }
    }
    None
}

fn capture_accelerator_for_action(action: &str) -> &'static str {
    match action {
        "playNext" => "MediaTrackNext",
        "playPrev" => "MediaTrackPrevious",
        "pause" => "MediaStop",
        _ => "MediaPlayPause",
    }
}

pub fn handle_shortcut(app: &tauri::AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state != ShortcutState::Pressed {
        return;
    }
    if now_playing::is_recording_media_key() {
        if let Some(action) = match_media_hotkey(shortcut) {
            if now_playing::claim_media_event() {
                let _ = app.emit(
                    "hotkeys:media-capture",
                    capture_accelerator_for_action(action),
                );
            }
        }
        return;
    }
    if let Some(action) = match_user_hotkey(app, shortcut) {
        dispatch_hotkey_action(app, &action);
        return;
    }
    if let Some(action) = match_media_hotkey(shortcut) {
        if now_playing::claim_media_event() {
            dispatch_hotkey_action(app, action);
        }
    }
}

fn register_shortcut(
    app: &tauri::AppHandle,
    action: &str,
    accelerator: &str,
    failed_actions: &mut Vec<String>,
    action_errors: &mut Map<String, Value>,
) {
    let Some(shortcut) = parse_accelerator(accelerator) else {
        failed_actions.push(action.to_string());
        action_errors.insert(
            action.to_string(),
            json!([format!("快捷键格式无效 [{}]", accelerator)]),
        );
        return;
    };
    if app.global_shortcut().is_registered(shortcut) {
        return;
    }
    if let Err(error) = app.global_shortcut().register(shortcut) {
        failed_actions.push(action.to_string());
        action_errors.insert(
            action.to_string(),
            json!([format!("注册全局快捷键失败 [{}]: {}", accelerator, error)]),
        );
    }
}

fn register_media_keys(
    app: &tauri::AppHandle,
    failed_actions: &mut Vec<String>,
    action_errors: &mut Map<String, Value>,
) {
    for (action, accelerator) in MEDIA_KEY_BINDINGS
        .iter()
        .chain(HARDWARE_FKEY_BINDINGS.iter())
    {
        // Media-key CGEventTap can fail without Accessibility; never block
        // user hotkeys or treat this as a settings-row failure.
        let Some(shortcut) = parse_accelerator(accelerator) else {
            continue;
        };
        if app.global_shortcut().is_registered(shortcut) {
            continue;
        }
        if let Err(error) = app.global_shortcut().register(shortcut) {
            eprintln!(
                "[hotkeys] 注册系统媒体键失败 [{} / {}]: {}",
                action, accelerator, error
            );
            failed_actions.push(format!("media:{action}"));
            action_errors.insert(
                format!("media:{action}"),
                json!([format!("注册系统媒体键失败 [{}]: {}", accelerator, error)]),
            );
        }
    }
}

pub fn apply_global_hotkeys(app: &tauri::AppHandle) -> Value {
    let mut failed_actions: Vec<String> = Vec::new();
    let mut action_errors = Map::new();

    if let Err(error) = app.global_shortcut().unregister_all() {
        let message = format!("注销旧快捷键失败: {}", error);
        eprintln!("[hotkeys] {}", message);
        failed_actions.push("unregister_all".into());
        action_errors.insert("unregister_all".into(), json!([message]));
    }

    let user_keys = app
        .try_state::<Database>()
        .map(|db| {
            if db.hotkeys_enabled() {
                db.get_hotkeys()
            } else {
                Vec::new()
            }
        })
        .unwrap_or_default();

    for hk in &user_keys {
        if hk.shortcut.is_empty() {
            continue;
        }
        register_shortcut(
            app,
            &hk.action,
            &hk.shortcut,
            &mut failed_actions,
            &mut action_errors,
        );
    }

    register_media_keys(app, &mut failed_actions, &mut action_errors);

    failed_actions.sort();
    failed_actions.dedup();
    let user_failed: Vec<String> = failed_actions
        .iter()
        .filter(|item| !item.starts_with("media:") && item.as_str() != "unregister_all")
        .cloned()
        .collect();
    let mut user_errors = Map::new();
    for action in &user_failed {
        if let Some(value) = action_errors.get(action) {
            user_errors.insert(action.clone(), value.clone());
        }
    }

    json!({
        "success": user_failed.is_empty(),
        "data": user_keys,
        "status": {
            "failedActions": user_failed,
            "actionErrors": user_errors,
        }
    })
}

pub fn save_and_apply(app: &tauri::AppHandle, db: &Database, payload: Vec<HotkeyEntry>) -> Value {
    if payload.is_empty() {
        db.set_hotkeys_enabled(false);
    } else {
        db.set_hotkeys_enabled(true);
        db.set_hotkeys(&payload);
    }
    apply_global_hotkeys(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_electron_media_key_names() {
        assert_eq!(normalize_accelerator("MediaNextTrack"), "MediaTrackNext");
        assert_eq!(
            normalize_accelerator("MediaPreviousTrack"),
            "MediaTrackPrevious"
        );
        assert_eq!(normalize_accelerator("MediaPlayPause"), "MediaPlayPause");
    }
}
