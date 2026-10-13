//! macOS 系统睡眠/唤醒监听。
//!
//! 背景：真实系统睡眠/唤醒（合盖、休眠唤醒）之后，MPV 的 CoreAudio AO 常静默失效——
//! 解码与播放时钟继续走但没声音，且这种"设备没变"的失效不会发出 devicechange 事件。
//! 前端 `nativePlayback.ts` 需要在唤醒后主动重建一次音频输出。
//!
//! 与前端 `ceru-wake` 的区别（重要）：`ceru-wake` 由窗口可见性变化（最小化/恢复、
//! 隐藏/显示主窗口）和 15 秒闲置唤醒触发，窗口级唤醒与 CoreAudio 存活状态无关。
//! 若窗口级唤醒也去重建 MPV 音频链，每次恢复窗口都会拆装 AO，造成可听见的停顿。
//! 本模块只在真实系统唤醒时向 Webview 派发 `app-system-wake`。

use tauri::AppHandle;

pub fn init_system_power_watcher(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    impl_macos::init(app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
mod impl_macos {
    use std::ffi::CString;
    use std::sync::OnceLock;

    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};
    use tauri::{AppHandle, Emitter};

    #[allow(dead_code)]
    struct TargetHolder(*mut AnyObject);
    unsafe impl Send for TargetHolder {}
    unsafe impl Sync for TargetHolder {}

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
    static TARGET: OnceLock<TargetHolder> = OnceLock::new();

    extern "C" fn handle_system_wake(_this: &AnyObject, _cmd: Sel, _note: *mut AnyObject) {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("app-system-wake", ());
        }
    }

    fn register_target_class() -> Option<&'static AnyClass> {
        if let Some(existing) = AnyClass::get(c"CeruSystemPowerTarget") {
            return Some(existing);
        }
        let superclass = AnyClass::get(c"NSObject")?;
        let mut builder = ClassBuilder::new(c"CeruSystemPowerTarget", superclass)?;
        unsafe {
            builder.add_method(
                sel!(handleSystemWake:),
                handle_system_wake as extern "C" fn(_, _, _) -> _,
            );
        }
        Some(builder.register())
    }

    fn ns_string(value: &str) -> *mut AnyObject {
        let Ok(c_value) = CString::new(value) else {
            return std::ptr::null_mut();
        };
        let Some(ns_string) = AnyClass::get(c"NSString") else {
            return std::ptr::null_mut();
        };
        unsafe { msg_send![ns_string, stringWithUTF8String: c_value.as_ptr()] }
    }

    pub fn init(app: &AppHandle) {
        if APP_HANDLE.set(app.clone()).is_err() {
            return;
        }
        let Some(class) = register_target_class() else {
            return;
        };
        let Some(workspace_class) = AnyClass::get(c"NSWorkspace") else {
            return;
        };
        unsafe {
            let workspace: *mut AnyObject = msg_send![workspace_class, sharedWorkspace];
            if workspace.is_null() {
                return;
            }
            let center: *mut AnyObject = msg_send![workspace, notificationCenter];
            if center.is_null() {
                return;
            }
            let uninit: *mut AnyObject = msg_send![class, alloc];
            let target: *mut AnyObject = msg_send![uninit, init];
            if target.is_null() {
                return;
            }
            // 自己持有强引用，确保观察者对象在整个应用生命周期内存活，
            // 唤醒事件不会因对象提前释放而丢失。
            if TARGET.set(TargetHolder(target)).is_err() {
                return;
            }
            let wake_name = ns_string("NSWorkspaceDidWakeNotification");
            if wake_name.is_null() {
                return;
            }
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: *mut AnyObject = msg_send![center, addObserver: target, selector: sel!(handleSystemWake:), name: wake_name, object: nil];
        }
    }
}
