use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 网易云式窗口化全屏（borderless windowed fullscreen），对齐 Electron 参考实现
/// （CeruMusic src/main/index.ts enterWindowedFullScreen/exitWindowedFullScreen）：
/// 不走 OS 原生 setFullScreen（macOS 原生全屏会进独立 Space，退出/置顶行为与 Electron 版不一致），
/// 改为：窗口拉到显示器完整物理尺寸（含菜单栏区域）+ 提高窗口层级盖住顶部状态栏。
/// 进入前快照窗口状态，退出后完整还原。
#[derive(Clone, Copy)]
struct WindowedFsSnapshot {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    always_on_top: bool,
    decorated: bool,
}

static FS_ACTIVE: AtomicBool = AtomicBool::new(false);
static FS_SNAPSHOT: Mutex<Option<WindowedFsSnapshot>> = Mutex::new(None);

pub fn is_windowed_fullscreen() -> bool {
    FS_ACTIVE.load(Ordering::SeqCst)
}

fn err<E: std::fmt::Debug>(value: E) -> String {
    format!("{value:?}")
}

// NSScreenSaverWindowLevel：高于主菜单/状态栏（NSMainMenuWindowLevel=24），
// 等价 Electron alwaysOnTop screen-saver 档，保证窗口盖住 macOS 顶部状态栏。
#[cfg(target_os = "macos")]
const MACOS_COVER_MENU_WINDOW_LEVEL: i64 = 1000;
#[cfg(target_os = "macos")]
const MACOS_NORMAL_WINDOW_LEVEL: i64 = 0;

#[cfg(target_os = "macos")]
fn set_native_window_level(window: &WebviewWindow, level: i64) {
    use objc2::{msg_send, runtime::AnyObject};

    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window.cast::<AnyObject>();
    if ns_window.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![ns_window, setLevel: level];
    }
}

fn enter_windowed_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    if is_windowed_fullscreen() {
        return Ok(());
    }

    let position = window.outer_position().map_err(err)?;
    let size = window.outer_size().map_err(err)?;
    let maximized = window.is_maximized().unwrap_or(false);
    if maximized {
        let _ = window.unmaximize();
    }
    let snapshot = WindowedFsSnapshot {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized,
        always_on_top: window.is_always_on_top().unwrap_or(false),
        decorated: window.is_decorated().unwrap_or(true),
    };

    // 先置 active 再改尺寸：Resized 驱动的状态上报/前端 guard 才不会把中间态当成普通缩放。
    *FS_SNAPSHOT.lock().map_err(err)? = Some(snapshot);
    FS_ACTIVE.store(true, Ordering::SeqCst);

    // 用显示器完整尺寸（含菜单栏），不能用 work_area —— 需求就是填充顶部状态栏。
    let monitor = window
        .current_monitor()
        .map_err(err)?
        .or(window.primary_monitor().map_err(err)?)
        .ok_or_else(|| "无法获取显示器信息".to_string())?;
    let monitor_position = *monitor.position();
    let monitor_size = *monitor.size();

    window.set_decorations(false).map_err(err)?;
    window.set_resizable(false).map_err(err)?;
    window.set_always_on_top(true).map_err(err)?;
    #[cfg(target_os = "macos")]
    set_native_window_level(window, MACOS_COVER_MENU_WINDOW_LEVEL);
    // 先定位再定尺寸，保证窗口左上角落在显示器原点而不是被 minSize 挤偏。
    window
        .set_position(tauri::PhysicalPosition::new(
            monitor_position.x,
            monitor_position.y,
        ))
        .map_err(err)?;
    window
        .set_size(tauri::PhysicalSize::new(monitor_size.width, monitor_size.height))
        .map_err(err)?;
    let _ = window.set_focus();
    Ok(())
}

fn exit_windowed_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    if !is_windowed_fullscreen() {
        return Ok(());
    }
    let snapshot = FS_SNAPSHOT.lock().map_err(err)?.take();

    #[cfg(target_os = "macos")]
    set_native_window_level(window, MACOS_NORMAL_WINDOW_LEVEL);
    if let Some(snapshot) = snapshot {
        let _ = window.set_always_on_top(snapshot.always_on_top);
        let _ = window.set_decorations(snapshot.decorated);
        let _ = window.set_resizable(true);
        let _ = window.set_position(tauri::PhysicalPosition::new(snapshot.x, snapshot.y));
        let _ = window.set_size(tauri::PhysicalSize::new(snapshot.width, snapshot.height));
        if snapshot.maximized {
            let _ = window.maximize();
        }
    }
    FS_ACTIVE.store(false, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn windowed_fullscreen_get() -> bool {
    is_windowed_fullscreen()
}

#[tauri::command]
pub fn windowed_fullscreen_set(app: AppHandle, enter: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main 窗口不存在".to_string())?;
    if enter {
        enter_windowed_fullscreen(&window)?;
    } else {
        exit_windowed_fullscreen(&window)?;
    }
    let active = is_windowed_fullscreen();
    let _ = app.emit("app-fullscreen-changed", active);
    Ok(active)
}
