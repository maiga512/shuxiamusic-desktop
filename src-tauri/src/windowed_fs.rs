use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// 网易云式窗口化全屏（borderless windowed fullscreen），对齐 Electron 参考实现
/// （CeruMusic src/main/index.ts enterWindowedFullScreen/exitWindowedFullScreen）：
/// 不走 OS 原生 setFullScreen（macOS 原生全屏会进独立 Space，退出/置顶行为与 Electron 版不一致），
/// 改为：窗口拉到显示器完整物理尺寸（含菜单栏区域）+ 提高窗口层级盖住顶部状态栏。
/// 进入前快照窗口状态，退出后完整还原。
static FS_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn is_windowed_fullscreen() -> bool {
    FS_ACTIVE.load(Ordering::SeqCst)
}

// ===========================================================================
// macOS：全部在 AppKit 层、单个主队列任务里完成。
//
// 为什么不复用 Tauri 的 set_decorations / set_always_on_top / set_position /
// set_size（tao 0.37.1 实测）：
//   * `set_decorations(true)` 把 styleMask 设成
//     `Closable|Miniaturizable|Resizable|Titled` —— **不含 FullSizeContentView**。
//     于是内容视图不再延伸到标题栏下方，整个页面被下推一个标题栏高度，顶部露出
//     窗口底色（黑条）。这就是"退出全屏后顶部一条黑条、切到歌单页黑条还在"。
//   * `set_always_on_top(true)` 走 `set_level_async(NSFloatingWindowLevel = 3)`，
//     低于主菜单/状态栏层（NSMainMenuWindowLevel = 24），盖不住菜单栏；而且它是
//     **异步派发到主队列**的，会覆盖同函数里同步设的 `setLevel:1000`。
//   * `set_position`/`set_size` 走事件循环消息，`set_decorations` 走 GCD 主队列，
//     两条队列之间的先后不可控；而加/减 `FullSizeContentView` 本身会改变窗口 frame
//     （实测高度差 = 标题栏高度），所以顺序错了 frame 就会偏。
// 结论：把「改 styleMask / 设 frame / 设 level / 标题栏透明 / 隐藏红绿灯」放进
// 同一个主队列任务里按固定顺序执行，彻底消除竞态。
// ===========================================================================
#[cfg(target_os = "macos")]
mod macos_fs {
    use std::ffi::c_void;
    use std::sync::Mutex;

    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_core_foundation::CGRect;
    use tauri::WebviewWindow;

    extern "C" {
        static _dispatch_main_q: u8;
        fn dispatch_async_f(
            queue: *mut c_void,
            context: *mut c_void,
            work: extern "C" fn(*mut c_void),
        );
    }

    // NSWindowStyleMask
    const NS_WINDOW_STYLE_MASK_TITLED: u64 = 1 << 0;
    const NS_WINDOW_STYLE_MASK_CLOSABLE: u64 = 1 << 1;
    const NS_WINDOW_STYLE_MASK_MINIATURIZABLE: u64 = 1 << 2;
    const NS_WINDOW_STYLE_MASK_RESIZABLE: u64 = 1 << 3;
    const NS_WINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW: u64 = 1 << 15;
    // NSWindowTitleVisibility
    const NS_WINDOW_TITLE_HIDDEN: isize = 1;
    // NSScreenSaverWindowLevel：高于主菜单/状态栏（NSMainMenuWindowLevel = 24），
    // 等价 Electron alwaysOnTop screen-saver 档，保证窗口盖住 macOS 顶部状态栏。
    const NS_SCREEN_SAVER_WINDOW_LEVEL: isize = 1000;

    /// 进入全屏前的窗口状态快照（AppKit 坐标系，避免物理/逻辑像素换算）。
    struct SavedWindow {
        frame: CGRect,
        level: isize,
        zoomed: bool,
    }

    static SAVED: Mutex<Option<SavedWindow>> = Mutex::new(None);

    enum Action {
        Enter,
        Exit,
    }

    struct Task {
        ns_window: *mut AnyObject,
        action: Action,
    }

    extern "C" fn run(context: *mut c_void) {
        let task = unsafe { Box::from_raw(context as *mut Task) };
        unsafe {
            let ns_window = task.ns_window;
            if !ns_window.is_null() {
                match task.action {
                    Action::Enter => run_enter(ns_window),
                    Action::Exit => run_exit(ns_window),
                }
                let _: () = msg_send![ns_window, release];
            }
        }
    }

    unsafe fn run_enter(ns_window: *mut AnyObject) {
        // 快照必须在改动之前读：frame 用 AppKit 坐标，level 用当前值（可能是用户
        // 自己开的置顶 NSFloatingWindowLevel）。
        let frame: CGRect = msg_send![ns_window, frame];
        let level: isize = msg_send![ns_window, level];
        let zoomed: bool = msg_send![ns_window, isZoomed];
        if let Ok(mut guard) = SAVED.lock() {
            *guard = Some(SavedWindow {
                frame,
                level,
                zoomed,
            });
        }

        // 先取消最大化（zoom），否则后面 setFrame 会被 zoom 状态覆盖。
        if zoomed {
            let _: () = msg_send![ns_window, zoom: std::ptr::null_mut::<AnyObject>()];
        }

        // 去掉标题栏（borderless）。实测这一步不改变窗口 frame。
        let mask: u64 = msg_send![ns_window, styleMask];
        let _: () = msg_send![ns_window, setStyleMask: mask & !NS_WINDOW_STYLE_MASK_TITLED];

        // 目标 = 当前所在屏幕的完整 frame（含菜单栏区域），不是 visibleFrame。
        let screen: *mut AnyObject = msg_send![ns_window, screen];
        let target: CGRect = if screen.is_null() {
            frame
        } else {
            msg_send![screen, frame]
        };
        let _: () = msg_send![ns_window, setFrame: target, display: true];

        // 抬到状态栏之上，真正盖住 macOS 顶部菜单栏。
        let _: () = msg_send![ns_window, setLevel: NS_SCREEN_SAVER_WINDOW_LEVEL];
    }

    unsafe fn run_exit(ns_window: *mut AnyObject) {
        let saved = SAVED.lock().ok().and_then(|mut guard| guard.take());

        // 恢复 Overlay 标题栏样式。必须显式带上 FullSizeContentView，否则内容被
        // 标题栏下推、顶部留黑条（tao 的 set_decorations(true) 就是漏了这一位）。
        let mask: u64 = msg_send![ns_window, styleMask];
        let restored = mask
            | NS_WINDOW_STYLE_MASK_TITLED
            | NS_WINDOW_STYLE_MASK_CLOSABLE
            | NS_WINDOW_STYLE_MASK_MINIATURIZABLE
            | NS_WINDOW_STYLE_MASK_RESIZABLE
            | NS_WINDOW_STYLE_MASK_FULL_SIZE_CONTENT_VIEW;
        let _: () = msg_send![ns_window, setStyleMask: restored];
        let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: true];
        let _: () = msg_send![ns_window, setTitleVisibility: NS_WINDOW_TITLE_HIDDEN];
        // 本 App 用自绘标题栏控件，原生红绿灯必须一直隐藏（改 styleMask 后可能复现）。
        for kind in [0usize, 1usize, 2usize] {
            let button: *mut AnyObject = msg_send![ns_window, standardWindowButton: kind];
            if !button.is_null() {
                let _: () = msg_send![button, setHidden: true];
            }
        }

        if let Some(saved) = saved {
            // 顺序关键：先改完 styleMask（会改变 frame 高度）再把 frame 写回，
            // 否则会被 FullSizeContentView 的高度差顶偏。
            let _: () = msg_send![ns_window, setFrame: saved.frame, display: true];
            let _: () = msg_send![ns_window, setLevel: saved.level];
            if saved.zoomed {
                let _: () = msg_send![ns_window, zoom: std::ptr::null_mut::<AnyObject>()];
            }
        }
    }

    pub fn dispatch(window: &WebviewWindow, enter: bool) {
        let Ok(ns_window) = window.ns_window() else {
            return;
        };
        let ns_window = ns_window.cast::<AnyObject>();
        if ns_window.is_null() {
            return;
        }
        // 窗口活到进程结束，但仍按引用计数持有，避免任务执行前被释放。
        unsafe {
            let _: *mut AnyObject = msg_send![ns_window, retain];
        }
        let task = Box::into_raw(Box::new(Task {
            ns_window,
            action: if enter { Action::Enter } else { Action::Exit },
        }));
        unsafe {
            dispatch_async_f(
                &_dispatch_main_q as *const u8 as *mut c_void,
                task as *mut c_void,
                run,
            );
        }
    }
}

// ===========================================================================
// 非 macOS：保留原 Tauri API 实现（Windows/Linux）。
// ===========================================================================
#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
static FS_SNAPSHOT: std::sync::Mutex<Option<WindowedFsSnapshot>> = std::sync::Mutex::new(None);

#[cfg(not(target_os = "macos"))]
fn err<E: std::fmt::Debug>(value: E) -> String {
    format!("{value:?}")
}

#[cfg(not(target_os = "macos"))]
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

    // 用显示器完整尺寸（含任务栏区域），不能用 work_area。
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

#[cfg(not(target_os = "macos"))]
fn exit_windowed_fullscreen(window: &WebviewWindow) -> Result<(), String> {
    if !is_windowed_fullscreen() {
        return Ok(());
    }
    let snapshot = FS_SNAPSHOT.lock().map_err(err)?.take();

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

fn enter(window: &WebviewWindow) -> Result<(), String> {
    if is_windowed_fullscreen() {
        return Ok(());
    }
    FS_ACTIVE.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        macos_fs::dispatch(window, true);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        enter_windowed_fullscreen(window)
    }
}

fn exit(window: &WebviewWindow) -> Result<(), String> {
    if !is_windowed_fullscreen() {
        return Ok(());
    }
    FS_ACTIVE.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        macos_fs::dispatch(window, false);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        exit_windowed_fullscreen(window)
    }
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
        self::enter(&window)?;
    } else {
        self::exit(&window)?;
    }
    let active = is_windowed_fullscreen();
    let _ = app.emit("app-fullscreen-changed", active);
    Ok(active)
}
