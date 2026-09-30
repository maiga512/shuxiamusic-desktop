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
const MEDIA_EVENT_DEBOUNCE_MS: u64 = 220;

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
        return;
    }
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
            let image: *mut AnyObject = msg_send![image_class, imageWithData: data];
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

    struct TargetHolder(*mut AnyObject);
    unsafe impl Send for TargetHolder {}
    unsafe impl Sync for TargetHolder {}

    static TARGET: OnceLock<TargetHolder> = OnceLock::new();

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
            let enabled: objc2::runtime::Bool = objc2::runtime::Bool::YES;
            let _: () = msg_send![command, setEnabled: enabled];
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

    fn install_remote_commands() {
        eprintln!("[now-playing] 开始注册 MPRemoteCommandCenter");
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
        if let Some(artwork_url) = payload.artwork_url.as_deref() {
            if let Some(artwork) = create_mpmedia_artwork(artwork_url) {
                dict_set_object(dict, "MPMediaItemPropertyArtwork", artwork);
                unsafe {
                    let _: () = msg_send![artwork, release];
                }
            }
        }

        unsafe {
            let _: () = msg_send![center, setNowPlayingInfo: dict];
            let state: isize = if payload.playing.unwrap_or(false) {
                1
            } else {
                2
            };
            let _: () = msg_send![center, setPlaybackState: state];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn create_mpmedia_artwork(_url_str: &str) -> Option<*mut AnyObject> {
    None
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
