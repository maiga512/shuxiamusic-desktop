use serde_json::{json, Map, Value};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

use crate::db::Database;
use crate::emit_music_control;
use crate::models::HotkeyEntry;
use crate::now_playing;

/// 标准多媒体键，独立于用户快捷键表注册。
/// 这些是操作系统原生的播放控制键（播放/暂停、上一首、下一首、停止）：
/// - 全平台：由全局快捷键捕获。macOS 上 global-hotkey 会用 SystemDefined
///   CGEventTap 直接截获键盘媒体键 / 有线耳机 / AirPods / 蓝牙的
///   NX_KEYTYPE 事件并消费，应用在前台或后台都能收到，不依赖
///   "Now Playing" 路由（那是耳机控制曾经完全失效的根因）。
/// - macOS 上 `now_playing` 的 MPRemoteCommandCenter 同时保留兜底：
///   tap 命中即消费事件，MPRemoteCommandCenter 不会重复收到；
///   当 tap 不可用（未授权辅助功能）时它负责接管，并展示 Now Playing。
/// 不再硬编码 F7/F8/F9，默认交给系统原生适配；F7/F8/F9 仍可被用户录为自定义键。
const MEDIA_KEY_BINDINGS: &[(&str, &str)] = &[
    ("toggle", "MediaPlayPause"),
    ("playNext", "MediaTrackNext"),
    ("playPrev", "MediaTrackPrevious"),
    // 不再注册 MediaStop：Apple 键盘和绝大多数耳机根本没有"停止"键，
    // global-hotkey 会直接报 Unknown scancode，白刷一条注册失败日志。
    // 停止指令由 MPRemoteCommandCenter 的 stopCommand 负责（见 now_playing）。
];

pub fn normalize_accelerator(raw: &str) -> String {
    let trimmed = raw.trim().replace(' ', "");
    match trimmed.to_ascii_uppercase().as_str() {
        "MEDIANEXTTRACK" => "MediaTrackNext".into(),
        "MEDIAPREVIOUSTRACK" => "MediaTrackPrevious".into(),
        "MEDIATRACKPREV" => "MediaTrackPrevious".into(),
        "MEDIAPLAYPAUSE" => "MediaPlayPause".into(),
        "MEDIASTOP" => "MediaStop".into(),
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
    for (action, accelerator) in MEDIA_KEY_BINDINGS.iter() {
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
            now_playing::log_media_event("global-shortcut", action);
            dispatch_hotkey_action(app, action);
        } else {
            now_playing::log_media_event("global-shortcut", &format!("{action} debounced"));
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
) -> bool {
    // 全平台注册消费式媒体键捕获。macOS 的 CGEventTap 命中即消费事件，
    // MPRemoteCommandCenter 不会重复收到；tap 创建失败（未授权辅助功能）
    // 时只记录日志，绝不阻塞用户快捷键或把设置页判为失败。
    if std::env::var("CERU_DISABLE_MEDIA_TAP").is_ok() {
        // 排障开关：只保留 MPRemoteCommandCenter 一条通道，用来区分
        // "CGEventTap 抢走了媒体键"和"系统根本没把指令投给我们"。
        eprintln!("[hotkeys] CERU_DISABLE_MEDIA_TAP=1，跳过媒体键 CGEventTap");
        return true;
    }
    let mut all_ok = true;
    for (action, accelerator) in MEDIA_KEY_BINDINGS.iter() {
        // Media-key CGEventTap can fail without Accessibility; never block
        // user hotkeys or treat this as a settings-row failure.
        let Some(shortcut) = parse_accelerator(accelerator) else {
            continue;
        };
        if app.global_shortcut().is_registered(shortcut) {
            continue;
        }
        if let Err(error) = app.global_shortcut().register(shortcut) {
            all_ok = false;
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
    all_ok
}

/// macOS：查询进程是否有辅助功能权限（CGEventTap 截获媒体键的前提）。
/// prompt=true 时弹系统授权对话框（未授权时才会出现，系统自动去重不骚扰）。
#[cfg(target_os = "macos")]
fn ax_is_trusted(prompt: bool) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        // options 是 CFDictionaryRef；NSDictionary 与其 toll-free bridged，指针直传即可。
        fn AXIsProcessTrustedWithOptions(options: *mut AnyObject) -> bool;
    }

    if !prompt {
        return unsafe { AXIsProcessTrusted() };
    }
    unsafe {
        let Some(ns_string_cls) = AnyClass::get(c"NSString") else {
            return AXIsProcessTrusted();
        };
        let key: *mut AnyObject = msg_send![ns_string_cls, stringWithUTF8String: c"AXTrustedCheckOptionPrompt".as_ptr()];
        let Some(ns_number_cls) = AnyClass::get(c"NSNumber") else {
            return AXIsProcessTrusted();
        };
        let true_val: *mut AnyObject = msg_send![ns_number_cls, numberWithBool: true];
        let Some(ns_dict_cls) = AnyClass::get(c"NSDictionary") else {
            return AXIsProcessTrusted();
        };
        let dict: *mut AnyObject = msg_send![ns_dict_cls, dictionaryWithObject: true_val, forKey: key];
        if dict.is_null() {
            return AXIsProcessTrusted();
        }
        AXIsProcessTrustedWithOptions(dict)
    }
}

/**
 * 系统授权提示「每个 App 版本最多弹一次」。
 *
 * 每次重新打包签名都会变化，macOS TCC 会把新签名当成「新 App」，之前的辅助功能
 * 授权失效、系统提示必然重弹——这是系统行为，代码无法绕过。为避免同一版本
 * 每次启动都弹（用户点过拒绝/忽略后尤其骚扰），把「本版本已弹过」记到
 * app_data_dir；后续启动只静默后台重试，用户可在快捷键设置里手动重新请求。
 */
#[cfg(target_os = "macos")]
fn ax_prompt_state_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("ax_prompt_state.json"))
}

#[cfg(target_os = "macos")]
fn ax_prompted_for_version(app: &tauri::AppHandle) -> bool {
    let Some(path) = ax_prompt_state_path(app) else {
        return false
    };
    std::fs::read_to_string(path)
        .map(|s| s.trim() == app.package_info().version.to_string())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn mark_ax_prompted(app: &tauri::AppHandle) {
    let Some(path) = ax_prompt_state_path(app) else {
        return
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, app.package_info().version.to_string());
}

static AX_RETRY_STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 媒体键 tap 注册失败（几乎都是缺辅助功能权限）时的恢复流程：
/// 弹一次系统授权对话框，再后台每 2 秒复查、最多 15 分钟，
/// 用户一授权就自动补注册媒体键，不用重启 App。
/// 重新打包后签名变化、权限失效时，下次启动会再次走这个流程。
#[cfg(target_os = "macos")]
fn spawn_ax_retry(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    if AX_RETRY_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("ceru-media-key-ax-retry".into())
        .spawn(move || {
            for attempt in 0..450 {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if !ax_is_trusted(false) {
                    continue;
                }
                let mut failed = Vec::new();
                let mut errors = Map::new();
                let ok = register_media_keys(&app, &mut failed, &mut errors);
                now_playing::log_media_event(
                    "hotkeys",
                    &format!(
                        "media keys re-register after accessibility grant: {} (attempt {})",
                        if ok { "ok" } else { "still failing" },
                        attempt + 1
                    ),
                );
                if ok {
                    break;
                }
            }
        });
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


    #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
    let media_keys_ok = register_media_keys(app, &mut failed_actions, &mut action_errors);

    // macOS：媒体键 tap 注册失败几乎都是缺辅助功能权限。弹一次系统授权对话框，
    // 并后台自动重试，用户授权后立即补注册（重打包换签名后权限会失效，靠这个自愈）。
    #[cfg(target_os = "macos")]
    {
        let trusted = ax_is_trusted(false);
        now_playing::log_media_event(
            "hotkeys",
            &format!("accessibility_trusted={trusted} media_keys_registered={media_keys_ok}"),
        );
        if !media_keys_ok {
            if ax_prompted_for_version(app) {
                // 本版本已经弹过一次：不再骚扰，静默后台等用户去系统设置授权。
                now_playing::log_media_event(
                    "hotkeys",
                    "媒体键注册失败（疑似缺辅助功能权限），本版本已弹过授权提示，静默等待授权（设置页可重新请求）",
                );
            } else {
                let _ = ax_is_trusted(true);
                mark_ax_prompted(app);
                now_playing::log_media_event(
                    "hotkeys",
                    "媒体键注册失败（疑似缺辅助功能权限），已弹系统授权提示（每版本一次），授权后自动重试",
                );
            }
            spawn_ax_retry(app);
        }
    }
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

/**
 * 快捷键设置页：查询辅助功能权限状态；request=true 时重新弹系统授权对话框，
 * 并在未授权时启动后台自动重试（用户授权后立即补注册媒体键，不用重启 App）。
 * 非 macOS 平台恒为 true（媒体键由系统原生处理，无权限概念）。
 */
#[tauri::command]
pub fn hotkeys_accessibility(app: tauri::AppHandle, request: bool) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let trusted = ax_is_trusted(request);
        if request {
            mark_ax_prompted(&app);
        }
        if !trusted {
            spawn_ax_retry(&app);
        }
        Ok(trusted)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, request);
        Ok(true)
    }
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
