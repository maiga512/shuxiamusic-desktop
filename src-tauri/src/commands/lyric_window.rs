use crate::db::Database;
use tauri::window::Color;
use tauri::Manager;
use tauri::{Emitter, LogicalPosition, LogicalSize};

const DESKTOP_LYRIC_DEFAULT_WIDTH: f64 = 800.0;
const DESKTOP_LYRIC_DEFAULT_HEIGHT: f64 = 180.0;
const DESKTOP_LYRIC_MIN_WIDTH: f64 = 440.0;
const DESKTOP_LYRIC_MIN_HEIGHT: f64 = 140.0;
const DESKTOP_LYRIC_MAX_WIDTH: f64 = 1600.0;
const DESKTOP_LYRIC_MAX_HEIGHT: f64 = 300.0;

fn clamp_window_number(value: Option<f64>, fallback: f64, min: f64, max: f64) -> f64 {
    value
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn get_option_number(option: &serde_json::Value, key: &str) -> Option<f64> {
    option.get(key).and_then(|value| value.as_f64())
}

fn default_desktop_lyric_option(app: &tauri::AppHandle) -> serde_json::Value {
    let (x, y) = app
        .get_webview_window("main")
        .and_then(|win| win.current_monitor().ok().flatten())
        .map(|monitor| {
            let pos = monitor.position();
            let size = monitor.size();
            let scale = monitor.scale_factor().max(0.001);
            (
                pos.x as f64 / scale + size.width as f64 / scale / 2.0
                    - DESKTOP_LYRIC_DEFAULT_WIDTH / 2.0,
                pos.y as f64 / scale + size.height as f64 / scale - DESKTOP_LYRIC_DEFAULT_HEIGHT,
            )
        })
        .unwrap_or((100.0, 100.0));

    serde_json::json!({
        "fontSize": 30,
        "mainColor": "#73BCFC",
        "shadowColor": "rgba(255, 255, 255, 0.5)",
        "x": x,
        "y": y,
        "width": DESKTOP_LYRIC_DEFAULT_WIDTH,
        "height": DESKTOP_LYRIC_DEFAULT_HEIGHT,
        "fontFamily": "PingFangSC-Semibold",
        "fontWeight": 600,
        "position": "center",
        "alwaysShowPlayInfo": false,
        "isLock": false,
        "isOpen": false,
        "animation": true,
        "showYrc": true,
        "showTran": false,
        "isDoubleLine": true,
        "textBackgroundMask": false,
        "backgroundMaskColor": "rgba(0,0,0,0.2)",
        "unplayedColor": "rgba(255,255,255,0.5)",
        "limitBounds": true
    })
}

pub(crate) fn read_desktop_lyric_option(
    app: &tauri::AppHandle,
    db: &Database,
) -> serde_json::Value {
    let mut option = default_desktop_lyric_option(app);
    if let Some(saved) = db.get_setting("desktop_lyric_option") {
        if let Ok(saved_value) = serde_json::from_str::<serde_json::Value>(&saved) {
            if let (Some(base), Some(saved_object)) =
                (option.as_object_mut(), saved_value.as_object())
            {
                for (key, value) in saved_object {
                    base.insert(key.clone(), value.clone());
                }
            }
        }
    }
    option
}

fn save_desktop_lyric_option(db: &Database, option: &serde_json::Value) -> Result<(), String> {
    let json_str = serde_json::to_string(option).map_err(|e| format!("序列化配置失败: {}", e))?;
    db.set_setting("desktop_lyric_option", &json_str);
    Ok(())
}

fn normalized_window_size(width: f64, height: f64) -> (f64, f64) {
    (
        width.clamp(DESKTOP_LYRIC_MIN_WIDTH, DESKTOP_LYRIC_MAX_WIDTH),
        height.clamp(DESKTOP_LYRIC_MIN_HEIGHT, DESKTOP_LYRIC_MAX_HEIGHT),
    )
}

// Tauri/tao already expose desktop coordinates with a top-left origin
// (and convert to AppKit bottom-left internally). An extra flip here made
// desktop lyric drag move opposite to the mouse on macOS.
fn tauri_y_to_top_left(_app: &tauri::AppHandle, tauri_y: f64, _window_height: f64) -> f64 {
    tauri_y
}

fn top_left_y_to_tauri(_app: &tauri::AppHandle, top_left_y: f64, _window_height: f64) -> f64 {
    top_left_y
}

fn normalize_desktop_lyric_position(
    app: &tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    let monitor = monitors
        .iter()
        .find(|monitor| {
            let area = monitor.work_area();
            let scale = monitor.scale_factor().max(0.001);
            let left = area.position.x as f64 / scale;
            let top = area.position.y as f64 / scale;
            x >= left
                && x < left + area.size.width as f64 / scale
                && y >= top
                && y < top + area.size.height as f64 / scale
        })
        .or_else(|| monitors.first());

    let Some(monitor) = monitor else {
        return (x, y);
    };

    let area = monitor.work_area();
    let scale = monitor.scale_factor().max(0.001);
    let min_x = area.position.x as f64 / scale;
    let min_y = area.position.y as f64 / scale;
    let max_x = min_x + area.size.width as f64 / scale - width;
    let max_y = min_y + area.size.height as f64 / scale - height;
    (
        x.clamp(min_x, max_x.max(min_x)),
        y.clamp(min_y, max_y.max(min_y)),
    )
}

fn apply_desktop_lyric_lock(app: &tauri::AppHandle, is_lock: bool) -> Result<(), String> {
    if let Ok(mut state) = crate::LYRIC_LOCK_STATE.lock() {
        *state = is_lock;
    }
    if let Some(win) = app.get_webview_window("desktop-lyric") {
        win.set_ignore_cursor_events(is_lock)
            .map_err(|e| format!("设置桌面歌词点击穿透失败: {}", e))?;
    }
    let _ = app.emit("toogleDesktopLyricLock", is_lock);
    Ok(())
}

fn emit_desktop_lyric_closed(app: &tauri::AppHandle, db: &Database) {
    let mut option = read_desktop_lyric_option(app, db);
    option["isOpen"] = serde_json::json!(false);
    let _ = save_desktop_lyric_option(db, &option);
    let _ = app.emit("desktop-lyric-open-change", false);
    let _ = app.emit("closeDesktopLyric", ());
}

fn desktop_lyric_webview_url(app: &tauri::AppHandle) -> tauri::WebviewUrl {
    // Use a dedicated lightweight entry. Loading the full Vue app a second time
    // for lyrics alone costs tens to hundreds of MB; the light page keeps the
    // same DeskTopLyric UI with a much smaller runtime.
    #[cfg(debug_assertions)]
    {
        if let Some(mut url) = app.config().build.dev_url.clone() {
            url.set_path("/desktop-lyric.html");
            url.set_fragment(None);
            url.set_query(None);
            return tauri::WebviewUrl::External(url);
        }
    }
    let _ = app;
    tauri::WebviewUrl::App("desktop-lyric.html".into())
}

const DESKTOP_LYRIC_INIT_SCRIPT: &str = r#"(function () {
  try {
    document.documentElement.classList.add('desktop-lyric-window');
    document.documentElement.style.background = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
    var style = document.createElement('style');
    style.textContent = 'html,body,#app{background:transparent!important;background-color:transparent!important;}';
    document.documentElement.appendChild(style);
    if (document.body) {
      document.body.style.background = 'transparent';
      document.body.style.backgroundColor = 'transparent';
    }
  } catch (e) {}
})();"#;

#[cfg(target_os = "macos")]
fn apply_macos_screen_saver_level(win: &tauri::WebviewWindow) {
    use objc2::{msg_send, runtime::AnyObject};

    let Ok(ns_window) = win.ns_window() else {
        return;
    };
    let ns_window = ns_window.cast::<AnyObject>();
    if ns_window.is_null() {
        return;
    }
    // Electron `setAlwaysOnTop(true, 'screen-saver')` uses NSScreenSaverWindowLevel = 1000.
    let _: () = unsafe { msg_send![ns_window, setLevel: 1000isize] };
    // WKWebView otherwise paints an opaque white layer before Vue finishes.
    let _: () = unsafe { msg_send![ns_window, setOpaque: false] };
    let _: () = unsafe { msg_send![ns_window, setHasShadow: false] };
    if let Some(ns_color) = objc2::runtime::AnyClass::get(c"NSColor") {
        let clear: *mut AnyObject = unsafe { msg_send![ns_color, clearColor] };
        if !clear.is_null() {
            let _: () = unsafe { msg_send![ns_window, setBackgroundColor: clear] };
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_screen_saver_level(_win: &tauri::WebviewWindow) {}

#[cfg(target_os = "macos")]
fn set_desktop_lyric_alpha(win: &tauri::WebviewWindow, alpha: f64) {
    use objc2::{msg_send, runtime::AnyObject};

    let Ok(ns_window) = win.ns_window() else {
        return;
    };
    let ns_window = ns_window.cast::<AnyObject>();
    if ns_window.is_null() {
        return;
    }
    let _: () = unsafe { msg_send![ns_window, setAlphaValue: alpha] };
}

#[cfg(not(target_os = "macos"))]
fn set_desktop_lyric_alpha(_win: &tauri::WebviewWindow, _alpha: f64) {}

#[cfg(target_os = "macos")]
fn apply_wkwebview_transparent(win: &tauri::WebviewWindow) {
    let _ = win.with_webview(|platform| {
        use objc2::{msg_send, runtime::AnyObject};
        use std::ffi::CString;

        let wk = platform.inner() as *mut AnyObject;
        if wk.is_null() {
            return;
        }
        unsafe {
            let Some(ns_number) = objc2::runtime::AnyClass::get(c"NSNumber") else {
                return;
            };
            let Some(ns_string) = objc2::runtime::AnyClass::get(c"NSString") else {
                return;
            };
            let no: *mut AnyObject = msg_send![ns_number, numberWithBool: false];
            let key_c = CString::new("drawsBackground").expect("drawsBackground");
            let key: *mut AnyObject = msg_send![ns_string, stringWithUTF8String: key_c.as_ptr()];
            if !no.is_null() && !key.is_null() {
                let _: () = msg_send![wk, setValue: no, forKey: key];
                let config: *mut AnyObject = msg_send![wk, configuration];
                if !config.is_null() {
                    let _: () = msg_send![config, setValue: no, forKey: key];
                }
            }
            if let Some(ns_color) = objc2::runtime::AnyClass::get(c"NSColor") {
                let clear: *mut AnyObject = msg_send![ns_color, clearColor];
                if !clear.is_null() {
                    let _: () = msg_send![wk, setUnderPageBackgroundColor: clear];
                    let _: () = msg_send![wk, setWantsLayer: true];
                    let layer: *mut AnyObject = msg_send![wk, layer];
                    if !layer.is_null() {
                        let cg: *mut AnyObject = msg_send![clear, CGColor];
                        if !cg.is_null() {
                            let _: () = msg_send![layer, setBackgroundColor: cg];
                            let _: () = msg_send![layer, setOpaque: false];
                        }
                    }
                }
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn apply_wkwebview_transparent(_win: &tauri::WebviewWindow) {}

fn prepare_desktop_lyric_native_surface(win: &tauri::WebviewWindow) {
    apply_macos_screen_saver_level(win);
    apply_wkwebview_transparent(win);
}

fn reveal_desktop_lyric_window(
    app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
) -> Result<(), String> {
    let handle = app.clone();
    let win = win.clone();
    let handle_for_main = handle.clone();
    handle
        .run_on_main_thread(move || {
            prepare_desktop_lyric_native_surface(&win);
            let already_visible = win.is_visible().unwrap_or(false);
            if !already_visible {
                set_desktop_lyric_alpha(&win, 0.0);
            }
            let _ = win.show();
            let _ = win.set_always_on_top(true);
            prepare_desktop_lyric_native_surface(&win);
            if already_visible {
                set_desktop_lyric_alpha(&win, 1.0);
                return;
            }
            let handle_for_fade = handle_for_main.clone();
            // Keep the native window visible immediately (Electron parity), but
            // fade alpha a bit later so WKWebView's first white paint stays hidden.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(350));
                let handle_for_show = handle_for_fade.clone();
                let _ = handle_for_fade.run_on_main_thread(move || {
                    if let Some(win) = handle_for_show.get_webview_window("desktop-lyric") {
                        prepare_desktop_lyric_native_surface(&win);
                        set_desktop_lyric_alpha(&win, 1.0);
                        let _ = win.show();
                        let _ = win.set_always_on_top(true);
                    }
                });
            });
        })
        .map_err(|e| format!("显示桌面歌词窗口失败: {}", e))?;
    Ok(())
}

/// Toggle desktop lyric window open/closed.
/// Creates a transparent, always-on-top, frameless webview window
/// loading the `/#/desktop-lyric` route.
#[tauri::command]
pub fn toggle_desktop_lyric(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    show: bool,
) -> Result<bool, String> {
    let label = "desktop-lyric";
    let mut option = read_desktop_lyric_option(&app, &db);

    if show {
        option["isOpen"] = serde_json::json!(true);
        let width = clamp_window_number(
            get_option_number(&option, "width"),
            DESKTOP_LYRIC_DEFAULT_WIDTH,
            DESKTOP_LYRIC_MIN_WIDTH,
            DESKTOP_LYRIC_MAX_WIDTH,
        );
        let height = clamp_window_number(
            get_option_number(&option, "height"),
            DESKTOP_LYRIC_DEFAULT_HEIGHT,
            DESKTOP_LYRIC_MIN_HEIGHT,
            DESKTOP_LYRIC_MAX_HEIGHT,
        );
        let x = get_option_number(&option, "x").unwrap_or(100.0);
        let y = get_option_number(&option, "y").unwrap_or(100.0);
        let (x, y) = normalize_desktop_lyric_position(&app, x, y, width, height);
        option["x"] = serde_json::json!(x);
        option["y"] = serde_json::json!(y);
        let is_lock = option
            .get("isLock")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        save_desktop_lyric_option(&db, &option)?;

        if let Some(win) = app.get_webview_window(label) {
            let (width, height) = normalized_window_size(width, height);
            let native_y = top_left_y_to_tauri(&app, y, height);
            let _ = win.set_position(LogicalPosition::new(x, native_y));
            let _ = win.set_size(LogicalSize::new(width, height));
            let _ = apply_desktop_lyric_lock(&app, is_lock);
            reveal_desktop_lyric_window(&app, &win)?;
            let _ = app.emit("desktop-lyric-open-change", true);
            let _ = app.emit("desktop-lyric-option-change", option);
            return Ok(true);
        }

        let win = tauri::WebviewWindowBuilder::new(&app, label, desktop_lyric_webview_url(&app))
            .title("桌面歌词")
            .initialization_script(DESKTOP_LYRIC_INIT_SCRIPT)
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .resizable(true)
            .minimizable(false)
            .maximizable(false)
            .skip_taskbar(true)
            .shadow(false)
            .visible(false)
            .focused(false)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Throttle)
            .inner_size(width, height)
            .min_inner_size(DESKTOP_LYRIC_MIN_WIDTH, DESKTOP_LYRIC_MIN_HEIGHT)
            .position(x, top_left_y_to_tauri(&app, y, height))
            .build()
            .map_err(|e| format!("创建桌面歌词窗口失败: {}", e))?;

        prepare_desktop_lyric_native_surface(&win);
        set_desktop_lyric_alpha(&win, 0.0);

        {
            let app_handle = app.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Some(db) = app_handle.try_state::<Database>() {
                        emit_desktop_lyric_closed(&app_handle, &db);
                    } else {
                        let _ = app_handle.emit("desktop-lyric-open-change", false);
                    }
                }
            });
        }

        // Electron shows immediately on change-desktop-lyric. Keep alpha at 0
        // until the first paint/ready path fades it in, so we avoid a white flash
        // without leaving the window forever invisible if ready never arrives.
        let _ = apply_desktop_lyric_lock(&app, is_lock);
        reveal_desktop_lyric_window(&app, &win)?;
        let _ = app.emit("desktop-lyric-option-change", option);
        let _ = app.emit("desktop-lyric-open-change", true);

        // Safety net: if the lyric page never signals ready, still fade in.
        {
            let app_for_fallback = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                if let Some(win) = app_for_fallback.get_webview_window("desktop-lyric") {
                    let _ = reveal_desktop_lyric_window(&app_for_fallback, &win);
                }
            });
        }
        Ok(true)
    } else {
        option["isOpen"] = serde_json::json!(false);
        save_desktop_lyric_option(&db, &option)?;
        if let Some(win) = app.get_webview_window(label) {
            win.close()
                .map_err(|e| format!("关闭桌面歌词窗口失败: {}", e))?;
        }
        let _ = apply_desktop_lyric_lock(&app, false);
        let _ = app.emit("desktop-lyric-open-change", false);
        Ok(false)
    }
}

/// Get saved desktop lyric option from DB.
#[tauri::command]
pub fn get_desktop_lyric_option(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
) -> Result<serde_json::Value, String> {
    Ok(read_desktop_lyric_option(&app, &db))
}

/// Save desktop lyric option to DB and emit `desktop-lyric-option-change` event
/// to the lyric window (global event, all windows receive it).
pub fn save_desktop_lyric_partial(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    option: serde_json::Value,
) -> Result<(), String> {
    let mut merged = read_desktop_lyric_option(&app, &db);
    if let (Some(base), Some(update)) = (merged.as_object_mut(), option.as_object()) {
        for (key, value) in update {
            base.insert(key.clone(), value.clone());
        }
    }
    save_desktop_lyric_option(&db, &merged)
}

#[tauri::command]
pub fn set_desktop_lyric_option(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    option: serde_json::Value,
) -> Result<(), String> {
    let mut merged = read_desktop_lyric_option(&app, &db);
    if let (Some(base), Some(update)) = (merged.as_object_mut(), option.as_object()) {
        for (key, value) in update {
            base.insert(key.clone(), value.clone());
        }
    }

    let mut actual_size: Option<(f64, f64)> = None;
    if let Some(win) = app.get_webview_window("desktop-lyric") {
        if let Ok(size) = win.outer_size() {
            let scale = win.scale_factor().unwrap_or(1.0).max(0.001);
            actual_size = Some((size.width as f64 / scale, size.height as f64 / scale));
        }
    }

    // Manual resize is authoritative. Font-size-only updates must not derive a
    // new height and pull the lyric window back to a previous calculated size.
    if option.get("height").is_none() {
        if let Some((_, height)) = actual_size {
            merged["height"] = serde_json::json!(height);
        }
    }
    save_desktop_lyric_option(&db, &merged)?;

    if let Some(win) = app.get_webview_window("desktop-lyric") {
        let width_requested = option.get("width").is_some();
        let height_requested = option.get("height").is_some();
        if !width_requested && !height_requested {
            if let Some(is_lock) = merged.get("isLock").and_then(|value| value.as_bool()) {
                let _ = apply_desktop_lyric_lock(&app, is_lock);
            }
            let _ = app.emit("desktop-lyric-option-change", merged);
            return Ok(());
        }
        let width = clamp_window_number(
            get_option_number(&merged, "width"),
            DESKTOP_LYRIC_DEFAULT_WIDTH,
            DESKTOP_LYRIC_MIN_WIDTH,
            DESKTOP_LYRIC_MAX_WIDTH,
        );
        let height = clamp_window_number(
            get_option_number(&merged, "height"),
            DESKTOP_LYRIC_DEFAULT_HEIGHT,
            DESKTOP_LYRIC_MIN_HEIGHT,
            DESKTOP_LYRIC_MAX_HEIGHT,
        );
        let scale = win.scale_factor().unwrap_or(1.0).max(0.001);
        let size = actual_size
            .map(|(width, height)| {
                tauri::PhysicalSize::new(
                    (width * scale).round() as u32,
                    (height * scale).round() as u32,
                )
            })
            .unwrap_or(tauri::PhysicalSize::new(width as u32, height as u32));
        let next_width = if width_requested {
            width
        } else {
            size.width as f64 / scale
        };
        let next_height = if height_requested {
            height
        } else {
            size.height as f64 / scale
        };
        let _ = win.set_size(LogicalSize::new(next_width, next_height));
    }

    if let Some(is_lock) = merged.get("isLock").and_then(|value| value.as_bool()) {
        let _ = apply_desktop_lyric_lock(&app, is_lock);
    }
    let _ = app.emit("desktop-lyric-option-change", merged);

    Ok(())
}

#[tauri::command]
pub fn set_desktop_lyric_lock(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    is_lock: bool,
) -> Result<bool, String> {
    let mut option = read_desktop_lyric_option(&app, &db);
    option["isLock"] = serde_json::json!(is_lock);
    save_desktop_lyric_option(&db, &option)?;
    apply_desktop_lyric_lock(&app, is_lock)?;
    crate::update_tray_menu(&app);
    Ok(is_lock)
}

/// Return whether the desktop lyric window is currently open.
#[tauri::command]
pub fn lyric_window_get_open_state(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(app.get_webview_window("desktop-lyric").is_some())
}

/// Alias matching the Electron IPC name `get-lyric-open-state`.
#[tauri::command]
pub fn get_lyric_open_state(app: tauri::AppHandle) -> Result<bool, String> {
    lyric_window_get_open_state(app)
}

/// Get the position (x, y) and size (width, height) of the desktop lyric window.
/// Mirrors Electron `get-window-bounds`, which is consumed by the lyric window itself
/// before drag/resize operations.
#[tauri::command]
pub fn get_window_bounds(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let win = app
        .get_webview_window("desktop-lyric")
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| "窗口未找到".to_string())?;
    let pos = win
        .outer_position()
        .map_err(|e| format!("获取窗口位置失败: {}", e))?;
    let size = win
        .outer_size()
        .map_err(|e| format!("获取窗口大小失败: {}", e))?;
    let scale = win
        .scale_factor()
        .map_err(|e| format!("获取窗口缩放比例失败: {}", e))?
        .max(0.001);
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    let top_left_y = tauri_y_to_top_left(&app, pos.y as f64 / scale, height);
    Ok(serde_json::json!({
        "x": pos.x as f64 / scale,
        "y": top_left_y,
        "width": width,
        "height": height,
    }))
}

/// Get all monitors' positions and sizes.
/// Used by the desktop lyric window for multi-monitor positioning.

#[tauri::command]
pub fn get_cursor_position(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    // Desktop coordinates with top-left origin. Prefer this over webview
    // MouseEvent.screenX/Y while dragging a moving transparent window.
    let pos = app
        .cursor_position()
        .map_err(|e| format!("获取光标位置失败: {}", e))?;
    let scale = app
        .get_webview_window("desktop-lyric")
        .or_else(|| app.get_webview_window("main"))
        .and_then(|win| win.scale_factor().ok())
        .unwrap_or(1.0)
        .max(0.001);
    Ok(serde_json::json!({
        "x": pos.x as f64 / scale,
        "y": pos.y as f64 / scale,
    }))
}

#[tauri::command]
pub fn get_all_work_area(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let monitors = app
        .available_monitors()
        .map_err(|e| format!("获取显示器信息失败: {}", e))?;
    let areas: Vec<serde_json::Value> = monitors
        .into_iter()
        .map(|m| {
            let pos = m.position();
            let size = m.size();
            let scale = m.scale_factor().max(0.001);
            serde_json::json!({
                "x": pos.x as f64 / scale,
                "y": pos.y as f64 / scale,
                "width": size.width as f64 / scale,
                "height": size.height as f64 / scale,
            })
        })
        .collect();
    Ok(areas)
}

/// Get the current desktop lyric lock state.
#[tauri::command]
pub fn get_lyric_lock_state() -> Result<bool, String> {
    match crate::LYRIC_LOCK_STATE.lock() {
        Ok(state) => Ok(*state),
        Err(_) => Ok(false),
    }
}

/// Get the primary monitor's screen size.
/// Used by the desktop lyric window for bounds calculations.
#[tauri::command]
pub fn get_screen_size(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口未找到".to_string())?;
    let monitor = win
        .current_monitor()
        .map_err(|e| format!("获取显示器信息失败: {}", e))?
        .ok_or_else(|| "未找到显示器".to_string())?;
    let size = monitor.size();
    let scale = monitor.scale_factor().max(0.001);
    Ok(serde_json::json!({
        "width": size.width as f64 / scale,
        "height": size.height as f64 / scale,
    }))
}

#[tauri::command]
pub fn move_desktop_lyric_window(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let (width, height) = normalized_window_size(width, height);
    let win = app
        .get_webview_window("desktop-lyric")
        .ok_or_else(|| "桌面歌词窗口未找到".to_string())?;
    let native_y = top_left_y_to_tauri(&app, y, height);
    win.set_position(LogicalPosition::new(x, native_y))
        .map_err(|e| format!("移动桌面歌词窗口失败: {}", e))?;
    win.set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("调整桌面歌词窗口大小失败: {}", e))?;
    win.set_always_on_top(true)
        .map_err(|e| format!("设置桌面歌词置顶失败: {}", e))?;
    apply_macos_screen_saver_level(&win);

    let mut option = read_desktop_lyric_option(&app, &db);
    option["x"] = serde_json::json!(x);
    option["y"] = serde_json::json!(y);
    option["width"] = serde_json::json!(width);
    option["height"] = serde_json::json!(height);
    save_desktop_lyric_option(&db, &option)?;
    let _ = app.emit("desktop-lyric-option-change", option);
    Ok(())
}

#[tauri::command]
pub fn update_desktop_lyric_window_height(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    height: f64,
) -> Result<(), String> {
    let win = app
        .get_webview_window("desktop-lyric")
        .ok_or_else(|| "桌面歌词窗口未找到".to_string())?;
    let size = win
        .outer_size()
        .map_err(|e| format!("获取桌面歌词窗口大小失败: {}", e))?;
    let scale = win.scale_factor().unwrap_or(1.0).max(0.001);
    let current_height = size.height as f64 / scale;
    let (width, height) = normalized_window_size(size.width as f64 / scale, height);
    if current_height - height <= 1.0 && height - current_height <= 1.0 {
        return Ok(());
    }
    win.set_size(LogicalSize::new(width, height))
        .map_err(|e| format!("更新桌面歌词窗口高度失败: {}", e))?;

    let mut option = read_desktop_lyric_option(&app, &db);
    option["width"] = serde_json::json!(width);
    option["height"] = serde_json::json!(height);
    save_desktop_lyric_option(&db, &option)?;
    let _ = app.emit("desktop-lyric-option-change", option);
    Ok(())
}

#[tauri::command]
pub fn close_desktop_lyric_window(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
) -> Result<(), String> {
    let mut option = read_desktop_lyric_option(&app, &db);
    option["isOpen"] = serde_json::json!(false);
    save_desktop_lyric_option(&db, &option)?;
    if let Some(win) = app.get_webview_window("desktop-lyric") {
        win.close()
            .map_err(|e| format!("关闭桌面歌词窗口失败: {}", e))?;
    }
    let _ = apply_desktop_lyric_lock(&app, false);
    let _ = app.emit("desktop-lyric-open-change", false);
    let _ = app.emit("closeDesktopLyric", ());
    Ok(())
}

#[tauri::command]
pub fn desktop_lyric_window_ready(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
) -> Result<(), String> {
    let option = read_desktop_lyric_option(&app, &db);
    let is_open = option
        .get("isOpen")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let is_lock = option
        .get("isLock")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if let Some(win) = app.get_webview_window("desktop-lyric") {
        let _ = app.emit("desktop-lyric-option-change", option);
        // Ready means the light lyric page painted. Prefer an immediate fade-in
        // instead of another fixed 1000ms wait that made the window feel broken.
        if is_open {
            let _ = reveal_desktop_lyric_window(&app, &win);
        }
        if is_lock {
            let _ = apply_desktop_lyric_lock(&app, true);
        }
    }
    let _ = app.emit("lyric-window-ready", ());
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "主窗口未找到".to_string())?;
    win.show().map_err(|e| format!("显示主窗口失败: {}", e))?;
    win.set_focus()
        .map_err(|e| format!("聚焦主窗口失败: {}", e))?;
    Ok(())
}
