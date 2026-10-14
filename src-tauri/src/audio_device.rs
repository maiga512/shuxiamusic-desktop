//! macOS 默认输出设备变化监听（耳机插拔、蓝牙连断、手动切换输出设备）。
//!
//! 背景：macOS 会在输出设备拓扑变化前后替"正在播放"的 App 发一条系统媒体指令
//! （拔耳机发 pause、插回发 play/pause）。前端若照单全收，就会出现"摘下耳机暂停、
//! 戴上又自动播"。前端需要知道"刚发生过一次输出设备变化"，才能把这类系统指令
//! 与用户主动按键区分开（见 `globaPlayList.ts` 的 onGlobalCtrl）。
//!
//! 为什么不用 WebView 的 `navigator.mediaDevices` 'devicechange'：macOS 上 WebKit
//! 不暴露 audiooutput 设备（Safari 至今没有可用的输出设备 id），纯输出设备变化
//! 不一定触发该事件。这里直接从 CoreAudio 监听
//! `kAudioHardwarePropertyDefaultOutputDevice`，向 Webview 派发
//! `app-audio-device-changed`。
//!
//! 同一事件也用于让前端重建 MPV 的音频输出（AO 静默死亡的恢复手段）。

use tauri::AppHandle;

pub fn init_audio_device_watcher(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    impl_macos::init(app);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

#[cfg(target_os = "macos")]
mod impl_macos {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};

    type AudioObjectId = u32;
    type OsStatus = i32;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    // CoreAudio 常量（与 <CoreAudio/AudioHardware.h> 一致，已用 C 程序实测核对）。
    const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectId = 1;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_OUTPUT_DEVICE: u32 = 0x644F_7574; // 'dOut'
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = 0x676C_6F62; // 'glob'
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

    type ListenerProc = extern "C" fn(
        AudioObjectId,
        u32,
        *const AudioObjectPropertyAddress,
        *mut c_void,
    ) -> OsStatus;

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectAddPropertyListener(
            in_object: AudioObjectId,
            in_address: *const AudioObjectPropertyAddress,
            in_listener: ListenerProc,
            in_client_data: *mut c_void,
        ) -> OsStatus;
    }

    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    extern "C" fn on_default_output_device_changed(
        _object: AudioObjectId,
        _count: u32,
        _addresses: *const AudioObjectPropertyAddress,
        _data: *mut c_void,
    ) -> OsStatus {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("app-audio-device-changed", ());
        }
        0
    }

    pub fn init(app: &AppHandle) {
        if APP_HANDLE.set(app.clone()).is_err() {
            return;
        }
        let address = AudioObjectPropertyAddress {
            selector: K_AUDIO_HARDWARE_PROPERTY_DEFAULT_OUTPUT_DEVICE,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        // 注册失败只代表拿不到设备变化通知（前端会退回 WebView 的 devicechange），
        // 与播放无关，绝不 panic。
        unsafe {
            let _ = AudioObjectAddPropertyListener(
                K_AUDIO_OBJECT_SYSTEM_OBJECT,
                &address,
                on_default_output_device_changed,
                std::ptr::null_mut(),
            );
        }
    }
}
