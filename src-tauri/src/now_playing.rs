use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::emit_music_control;

static RECORDING_MEDIA_KEY: AtomicBool = AtomicBool::new(false);
static LAST_MEDIA_EVENT_MS: AtomicU64 = AtomicU64::new(0);
static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

const MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS: isize = 0;
// 双通道防重：一次物理按键可能同时触发 MPRemoteCommandCenter 的
// togglePlayPauseCommand 与 play/pauseCommand，取 100ms 去抖合并为一次。
const MEDIA_EVENT_DEBOUNCE_MS: u64 = 100;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingPayload {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub duration: Option<f64>,
    pub elapsed: Option<f64>,
    pub playing: Option<bool>,
    pub rate: Option<f64>,
}

pub fn set_recording_media_key(recording: bool) {
    RECORDING_MEDIA_KEY.store(recording, Ordering::SeqCst);
}

pub fn is_recording_media_key() -> bool {
    RECORDING_MEDIA_KEY.load(Ordering::SeqCst)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/// 耳机/键盘媒体键链路诊断日志：写固定文件方便 tail 确认事件是否真的到达进程
/// （打包后的 .app 看不到 stdout，只能靠这份文件区分“事件没送到”和“送到了但没派发”）。
pub fn log_media_event(source: &str, detail: &str) {
    use std::io::Write;

    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/ceru-media-keys.log")
    {
        let _ = writeln!(file, "[{}] {source}: {detail}", now_ms());
    }
}

pub fn claim_media_event() -> bool {
    let now = now_ms();
    let last = LAST_MEDIA_EVENT_MS.load(Ordering::SeqCst);
    if now.saturating_sub(last) < MEDIA_EVENT_DEBOUNCE_MS {
        return false;
    }
    LAST_MEDIA_EVENT_MS.store(now, Ordering::SeqCst);
    true
}

fn capture_accelerator(action: &str) -> &'static str {
    match action {
        "playNext" => "MediaTrackNext",
        "playPrev" => "MediaTrackPrevious",
        "pause" => "MediaStop",
        _ => "MediaPlayPause",
    }
}

pub fn dispatch_media_action(action: &'static str) {
    if !claim_media_event() {
        log_media_event("mp-remote", &format!("{action} debounced"));
        return;
    }
    log_media_event("mp-remote", action);
    if RECORDING_MEDIA_KEY.load(Ordering::SeqCst) {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit("hotkeys:media-capture", capture_accelerator(action));
        }
        return;
    }
    if let Some(app) = APP_HANDLE.get() {
        emit_music_control(app, action, None);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::ffi::CString;

    /// Download image data from a URL and create an MPMediaItemArtwork for Now Playing.
    /// Returns the artwork object (retained) or nil on failure.
    fn create_mpmedia_artwork(url_str: &str) -> Option<*mut AnyObject> {
        unsafe {
            let url_class = AnyClass::get(c"NSURL")?;
            let ns_string_class = AnyClass::get(c"NSString")?;
            let Ok(c_url) = CString::new(url_str) else {
                return None;
            };
            let url_ns: *mut AnyObject =
                msg_send![ns_string_class, stringWithUTF8String: c_url.as_ptr()];
            let url: *mut AnyObject = msg_send![url_class, URLWithString: url_ns];
            if url.is_null() {
                return None;
            }

            let data_class = AnyClass::get(c"NSData")?;
            // dataWithContentsOfURL: is synchronous — fine for cached/local proxy URLs.
            let data: *mut AnyObject = msg_send![data_class, dataWithContentsOfURL: url];
            if data.is_null() {
                return None;
            }

            let image_class = AnyClass::get(c"NSImage")?;
            // macOS 27 移除了类方法 +[NSImage imageWithData:]（运行时抛
            // unrecognized selector 未捕获异常直接 abort 进程，2026-10-09
            // 启动数秒即崩的元凶）。改用仍可用的实例方法 initWithData:，
            // 并保留响应性检查兜底未来系统再删 API：不响应就跳过封面，
            // Now Playing 照常工作，下一次 set_info 心跳自然重试。
            let image: *mut AnyObject = msg_send![image_class, alloc];
            if image.is_null() {
                return None;
            }
            let responds: bool = msg_send![image, respondsToSelector: sel!(initWithData:)];
            if !responds {
                log_media_event("now-playing", "artwork skip: NSImage initWithData: not available");
                return None;
            }
            let image: *mut AnyObject = msg_send![image, initWithData: data];
            if image.is_null() {
                return None;
            }

            let artwork_class = AnyClass::get(c"MPMediaItemArtwork")?;
            // alloc + initWithImage: returns a retained object.
            let artwork: *mut AnyObject = msg_send![artwork_class, alloc];
            let artwork: *mut AnyObject = msg_send![artwork, initWithImage: image];
            if artwork.is_null() {
                return None;
            }

            Some(artwork)
        }
    }

    use objc2::runtime::{AnyClass, AnyObject, ClassBuilder, Sel};
    use objc2::{msg_send, sel};

    use std::sync::Mutex;

    struct TargetHolder(*mut AnyObject);
    unsafe impl Send for TargetHolder {}
    unsafe impl Sync for TargetHolder {}

    static TARGET: OnceLock<TargetHolder> = OnceLock::new();

    /// Now Playing 封面。set_info 每次都会重建 info 字典，心跳每 10 秒就会
    /// 再走一遍，如果每次都 dataWithContentsOfURL 同步下载一张 512 的图，
    /// 等于给自己加了个每 10 秒一次的网络请求。这里按 URL 缓存住已解码的对象。
    struct ArtworkCacheEntry(String, *mut AnyObject);
    unsafe impl Send for ArtworkCacheEntry {}
    static ARTWORK_CACHE: OnceLock<Mutex<Option<ArtworkCacheEntry>>> = OnceLock::new();

    fn artwork_for(url: &str) -> Option<*mut AnyObject> {
        let cache = ARTWORK_CACHE.get_or_init(|| Mutex::new(None));
        let mut guard = cache.lock().ok()?;
        if let Some(ArtworkCacheEntry(cached_url, object)) = guard.as_ref() {
            if cached_url == url {
                return Some(*object);
            }
        }
        let object = create_mpmedia_artwork(url)?;
        if let Some(ArtworkCacheEntry(_, old)) =
            guard.replace(ArtworkCacheEntry(url.to_string(), object))
        {
            unsafe {
                let _: () = msg_send![old, release];
            }
        }
        Some(object)
    }

    #[link(name = "MediaPlayer", kind = "framework")]
    extern "C" {}

    extern "C" fn handle_toggle(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> isize {
        dispatch_media_action("toggle");
        MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
    }

    extern "C" fn handle_play(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> isize {
        dispatch_media_action("play");
        MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
    }

    extern "C" fn handle_pause(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> isize {
        dispatch_media_action("pause");
        MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
    }

    extern "C" fn handle_next(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> isize {
        dispatch_media_action("playNext");
        MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
    }

    extern "C" fn handle_prev(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> isize {
        dispatch_media_action("playPrev");
        MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
    }

    extern "C" fn handle_stop(_this: &AnyObject, _cmd: Sel, _event: *mut AnyObject) -> isize {
        dispatch_media_action("pause");
        MP_REMOTE_COMMAND_HANDLER_STATUS_SUCCESS
    }

    fn register_target_class() -> Option<&'static AnyClass> {
        if let Some(existing) = AnyClass::get(c"CeruNowPlayingTarget") {
            return Some(existing);
        }
        let superclass = AnyClass::get(c"NSObject")?;
        let mut builder = ClassBuilder::new(c"CeruNowPlayingTarget", superclass)?;
        unsafe {
            builder.add_method(
                sel!(handleToggle:),
                handle_toggle as extern "C" fn(_, _, _) -> _,
            );
            builder.add_method(
                sel!(handlePlay:),
                handle_play as extern "C" fn(_, _, _) -> _,
            );
            builder.add_method(
                sel!(handlePause:),
                handle_pause as extern "C" fn(_, _, _) -> _,
            );
            builder.add_method(
                sel!(handleNext:),
                handle_next as extern "C" fn(_, _, _) -> _,
            );
            builder.add_method(
                sel!(handlePrev:),
                handle_prev as extern "C" fn(_, _, _) -> _,
            );
            builder.add_method(
                sel!(handleStop:),
                handle_stop as extern "C" fn(_, _, _) -> _,
            );
        }
        Some(builder.register())
    }

    fn enable_command(command: *mut AnyObject, action: Sel, target: *mut AnyObject) {
        if command.is_null() || target.is_null() {
            return;
        }
        unsafe {
            let nil: *mut AnyObject = std::ptr::null_mut();
            let _: () = msg_send![command, removeTarget: nil];
            let _: () = msg_send![command, addTarget: target, action: action];
            let _: () = msg_send![command, setEnabled: true];
        }
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

    fn dict_set_object(dict: *mut AnyObject, key: &str, value: *mut AnyObject) {
        if dict.is_null() || value.is_null() {
            return;
        }
        let key_obj = ns_string(key);
        if key_obj.is_null() {
            return;
        }
        unsafe {
            let _: () = msg_send![dict, setObject: value, forKey: key_obj];
        }
    }

    fn dict_set_string(dict: *mut AnyObject, key: &str, value: &str) {
        dict_set_object(dict, key, ns_string(value));
    }

    fn dict_set_f64(dict: *mut AnyObject, key: &str, value: f64) {
        let Some(ns_number) = AnyClass::get(c"NSNumber") else {
            return;
        };
        let num: *mut AnyObject = unsafe { msg_send![ns_number, numberWithDouble: value] };
        dict_set_object(dict, key, num);
    }

    /// MPRemoteCommandCenter / MediaRemote 只会把耳机（AVRCP）和控制面板的播放
    /// 指令投给"有 bundle 身份、且当前被系统认定为正在播放"的 App。裸跑的 dev 版
    /// 没有 bundle id 时注册会静默成功但永远收不到事件，所以把 bundle id 写进日志，
    /// 一眼能分清是"没注册"还是"注册了但系统没路由过来"。
    fn bundle_identifier() -> String {
        let Some(bundle_class) = AnyClass::get(c"NSBundle") else {
            return "<no NSBundle>".to_string();
        };
        unsafe {
            let bundle: *mut AnyObject = msg_send![bundle_class, mainBundle];
            if bundle.is_null() {
                return "<nil mainBundle>".to_string();
            }
            let value: *mut AnyObject = msg_send![bundle, bundleIdentifier];
            if value.is_null() {
                return "<nil bundleIdentifier>".to_string();
            }
            let utf8: *const std::os::raw::c_char = msg_send![value, UTF8String];
            if utf8.is_null() {
                return "<unreadable>".to_string();
            }
            std::ffi::CStr::from_ptr(utf8).to_string_lossy().into_owned()
        }
    }

    // 注意：不要再调 -[NSApplication beginReceivingRemoteControlEvents]。
    // 实测在 macOS 上从 Tauri setup 里调用会直接 abort 进程（panic in a
    // function that cannot unwind），而且 MPRemoteCommandCenter 本身不需要它。

    fn install_remote_commands() {
        eprintln!("[now-playing] 开始注册 MPRemoteCommandCenter");
        let identity = bundle_identifier();
        log_media_event("init", &format!("bundleIdentifier={identity}"));
        eprintln!("[now-playing] bundleIdentifier = {identity}");
        let Some(cls) = register_target_class() else {
            eprintln!("[now-playing] CeruNowPlayingTarget 注册失败");
            return;
        };
        eprintln!("[now-playing] class 已就绪");

        let target: *mut AnyObject = unsafe { msg_send![cls, new] };
        if target.is_null() {
            eprintln!("[now-playing] target 创建失败");
            return;
        }
        if TARGET.set(TargetHolder(target)).is_err() {
            unsafe {
                let _: () = msg_send![target, release];
            }
        }
        let Some(target) = TARGET.get() else {
            eprintln!("[now-playing] target 保存失败");
            return;
        };

        let Some(center_class) = AnyClass::get(c"MPRemoteCommandCenter") else {
            eprintln!("[now-playing] MPRemoteCommandCenter 不可用");
            return;
        };
        let center: *mut AnyObject = unsafe { msg_send![center_class, sharedCommandCenter] };
        if center.is_null() {
            eprintln!("[now-playing] sharedCommandCenter 为空");
            return;
        }

        unsafe {
            let toggle: *mut AnyObject = msg_send![center, togglePlayPauseCommand];
            let play: *mut AnyObject = msg_send![center, playCommand];
            let pause: *mut AnyObject = msg_send![center, pauseCommand];
            let next: *mut AnyObject = msg_send![center, nextTrackCommand];
            let prev: *mut AnyObject = msg_send![center, previousTrackCommand];
            let stop: *mut AnyObject = msg_send![center, stopCommand];
            enable_command(toggle, sel!(handleToggle:), target.0);
            enable_command(play, sel!(handlePlay:), target.0);
            enable_command(pause, sel!(handlePause:), target.0);
            enable_command(next, sel!(handleNext:), target.0);
            enable_command(prev, sel!(handlePrev:), target.0);
            enable_command(stop, sel!(handleStop:), target.0);
        }

        eprintln!("[now-playing] MPRemoteCommandCenter 已接管键盘媒体键");
        log_media_event("init", "MPRemoteCommandCenter 已注册 toggle/play/pause/next/prev/stop");

        // 设置初始 Now Playing 状态，让 macOS 立即把媒体键路由到本 App
        set_info(&NowPlayingPayload {
            title: Some("澜音".to_string()),
            artist: None,
            album: None,
            artwork_url: None,
            duration: None,
            elapsed: None,
            playing: Some(false),
            rate: Some(0.0),
        });
    }

    pub fn init(app: &AppHandle) {
        let _ = APP_HANDLE.set(app.clone());
        install_remote_commands();
    }

    pub fn set_info(payload: &NowPlayingPayload) {
        let Some(info_class) = AnyClass::get(c"MPNowPlayingInfoCenter") else {
            return;
        };
        let Some(dict_class) = AnyClass::get(c"NSMutableDictionary") else {
            return;
        };
        let center: *mut AnyObject = unsafe { msg_send![info_class, defaultCenter] };
        if center.is_null() {
            return;
        }
        let dict: *mut AnyObject = unsafe { msg_send![dict_class, dictionary] };
        if dict.is_null() {
            return;
        }

        let title = payload
            .title
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("澜音");
        dict_set_string(dict, "title", title);
        if let Some(artist) = payload
            .artist
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            dict_set_string(dict, "artist", artist);
        }
        if let Some(album) = payload
            .album
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            dict_set_string(dict, "albumTitle", album);
        }
        if let Some(duration) = payload.duration.filter(|value| *value > 0.0) {
            dict_set_f64(dict, "playbackDuration", duration);
        }
        if let Some(elapsed) = payload.elapsed.filter(|value| *value >= 0.0) {
            dict_set_f64(dict, "elapsedPlaybackTime", elapsed);
        }
        let rate = if payload.playing.unwrap_or(false) {
            payload.rate.filter(|value| *value > 0.0).unwrap_or(1.0)
        } else {
            0.0
        };
        dict_set_f64(dict, "playbackRate", rate);

        // Set artwork (album cover) on Now Playing info center.
        // 缓存持有自己的 +1，setObject:forKey: 会再保留一份，这里不能 release。
        if let Some(artwork_url) = payload
            .artwork_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if let Some(artwork) = artwork_for(artwork_url) {
                dict_set_object(dict, "MPMediaItemPropertyArtwork", artwork);
            }
        }

        let state: isize = if payload.playing.unwrap_or(false) {
            1
        } else {
            2
        };

        unsafe {
            let _: () = msg_send![center, setNowPlayingInfo: dict];
            let _: () = msg_send![center, setPlaybackState: state];
        }
        // 状态时间线诊断：每次系统侧状态更新都留一行，方便从 /tmp/ceru-media-keys.log
        // 直接判断"状态到底有没有同步、什么时候又被覆盖回 playing"。
        log_media_event(
            "np",
            &format!(
                "state={} rate={:.2} elapsed={:.1} title={}",
                state,
                rate,
                payload.elapsed.unwrap_or(0.0),
                title
            ),
        );
    }
}

#[cfg(target_os = "macos")]
pub fn init_now_playing(app: &AppHandle) {
    macos::init(app);
}

#[cfg(not(target_os = "macos"))]
pub fn init_now_playing(app: &AppHandle) {
    let _ = APP_HANDLE.set(app.clone());
}

#[cfg(target_os = "macos")]
fn set_now_playing_info(payload: &NowPlayingPayload) {
    macos::set_info(payload);
}

#[cfg(not(target_os = "macos"))]
fn set_now_playing_info(_payload: &NowPlayingPayload) {}

#[tauri::command]
pub fn now_playing_update(
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    duration: Option<f64>,
    elapsed: Option<f64>,
    playing: Option<bool>,
    rate: Option<f64>,
) -> Result<(), String> {
    set_now_playing_info(&NowPlayingPayload {
        title,
        artist,
        album,
        artwork_url,
        duration,
        elapsed,
        playing,
        rate,
    });
    Ok(())
}

#[tauri::command]
pub fn hotkeys_set_recording(recording: bool) -> Result<(), String> {
    set_recording_media_key(recording);
    Ok(())
}

/// 前端关键节点（暂停/状态同步/控制事件）诊断日志，与媒体键事件同写一份文件，
/// 打包后的 .app 没有控制台，全靠这份时间线定位"事件到了但状态没同步"这类问题。
#[tauri::command]
pub fn media_diag_log(source: String, detail: String) {
    log_media_event(&source, &detail);
}
