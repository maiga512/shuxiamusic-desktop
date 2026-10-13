use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub const MPV_STATE_EVENT: &str = "mpv://state";
pub const MPV_PROGRESS_EVENT: &str = "mpv://progress";
pub const MPV_ENDED_EVENT: &str = "mpv://ended";
pub const MPV_ERROR_EVENT: &str = "mpv://error";

const MPV_BACKEND: &str = "mpv-sidecar";
const MPV_SOCKET_NAME: &str = "ceru-mpv-ipc.sock";
const SURROUND_IR_VERSION: &str = "v2";
const SURROUND_IR_SAMPLE_RATE: u32 = 48_000;
const WEB_AUDIO_GAIN_CALIBRATION_DB: f64 = -58.0;
const WEB_AUDIO_GAIN_CALIBRATION_SAMPLE_RATE: f64 = 44_100.0;
const WEB_AUDIO_MIN_POWER: f64 = 0.000125;

use std::sync::atomic::{AtomicU64, Ordering};

static HOT_IPC_CONNECTS: AtomicU64 = AtomicU64::new(0);
static HOT_GET_STATE: AtomicU64 = AtomicU64::new(0);
static HOT_EMIT_STATE: AtomicU64 = AtomicU64::new(0);
static HOT_EMIT_PROGRESS: AtomicU64 = AtomicU64::new(0);
static HOT_SET_VOLUME: AtomicU64 = AtomicU64::new(0);
static HOT_SET_FILTERS: AtomicU64 = AtomicU64::new(0);
static HOT_SET_RATE: AtomicU64 = AtomicU64::new(0);
static HOT_LOG_STARTED: AtomicU64 = AtomicU64::new(0);

fn ensure_hot_logger() {
    if !cfg!(debug_assertions) {
        return;
    }
    if HOT_LOG_STARTED.swap(1, Ordering::SeqCst) == 1 {
        return;
    }
    thread::spawn(|| loop {
        thread::sleep(Duration::from_secs(1));
        let connects = HOT_IPC_CONNECTS.swap(0, Ordering::SeqCst);
        let get_state = HOT_GET_STATE.swap(0, Ordering::SeqCst);
        let emit_state = HOT_EMIT_STATE.swap(0, Ordering::SeqCst);
        let emit_progress = HOT_EMIT_PROGRESS.swap(0, Ordering::SeqCst);
        let set_volume = HOT_SET_VOLUME.swap(0, Ordering::SeqCst);
        let set_filters = HOT_SET_FILTERS.swap(0, Ordering::SeqCst);
        let set_rate = HOT_SET_RATE.swap(0, Ordering::SeqCst);
        if connects == 0
            && get_state == 0
            && emit_state == 0
            && emit_progress == 0
            && set_volume == 0
            && set_filters == 0
            && set_rate == 0
        {
            continue;
        }
        let line = format!(
            "{} connects={} get_state={} emit_state={} emit_progress={} set_volume={} set_filters={} set_rate={}\n",
            now_ms(),
            connects,
            get_state,
            emit_state,
            emit_progress,
            set_volume,
            set_filters,
            set_rate
        );
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open("/tmp/ceru-mpv-hot.log")
            .and_then(|mut file| file.write_all(line.as_bytes()));
    });
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MpvPhase {
    Idle,
    Loading,
    Playing,
    Paused,
    Ended,
    Stopped,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSnapshot {
    pub backend: String,
    pub backend_ready: bool,
    pub phase: MpvPhase,
    pub url: Option<String>,
    pub current_time: f64,
    pub duration: Option<f64>,
    pub volume: f64,
    pub muted: bool,
    pub playback_rate: f64,
    pub generation: u64,
    pub paused: bool,
    // 真实缓冲/空转信号：paused 只反映用户显式暂停,无法区分"用户暂停"与"正在
    // 缓冲"。前端失速看门狗必须靠这两个字段把"在线缓冲中"与"死链不出声"分开,
    // 否则会把正常缓冲误判成死链。
    pub paused_for_cache: bool,
    pub core_idle: bool,
    pub last_error: Option<String>,
    pub last_action: Option<String>,
    pub updated_at_ms: u64,
}

impl Default for MpvSnapshot {
    fn default() -> Self {
        Self {
            backend: MPV_BACKEND.to_string(),
            backend_ready: false,
            phase: MpvPhase::Idle,
            url: None,
            current_time: 0.0,
            duration: None,
            // 初值只在首次 set_volume/load 前可见。它必须不与任何整数滑条百分比的
            // sliderToMpvVolume 映射值相等(89.44% 才映射到 80)，否则首次设音量会被去抖
            // 阈值吞掉、mpv 停留在默认 100。
            volume: 80.0,
            muted: false,
            playback_rate: 1.0,
            generation: 0,
            paused: true,
            paused_for_cache: false,
            core_idle: false,
            last_error: None,
            last_action: None,
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvLoadRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub autoplay: Option<bool>,
    #[serde(default)]
    pub start_time_seconds: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub playback_rate: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvProbeRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvProbeResult {
    pub ok: bool,
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvEqualizerRequest {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub gains: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvBassBoostRequest {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub gain: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvSurroundRequest {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub mode: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvBalanceRequest {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub value: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvLoudnessRequest {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub target: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvAudioFiltersRequest {
    #[serde(default)]
    pub filters: Vec<String>,
    #[serde(default)]
    pub equalizer: Option<MpvEqualizerRequest>,
    #[serde(default)]
    pub bass_boost: Option<MpvBassBoostRequest>,
    #[serde(default)]
    pub surround: Option<MpvSurroundRequest>,
    #[serde(default)]
    pub balance: Option<MpvBalanceRequest>,
    #[serde(default)]
    pub loudness: Option<MpvLoudnessRequest>,
}

struct MpvRuntime {
    child: Option<Child>,
    ipc_path: String,
    listener_started: bool,
    applied_filters: Vec<(String, String)>,
}

impl Default for MpvRuntime {
    fn default() -> Self {
        Self {
            child: None,
            ipc_path: String::new(),
            listener_started: false,
            applied_filters: Vec::new(),
        }
    }
}

fn runtime_store() -> &'static Mutex<MpvRuntime> {
    static RUNTIME: OnceLock<Mutex<MpvRuntime>> = OnceLock::new();
    RUNTIME.get_or_init(|| Mutex::new(MpvRuntime::default()))
}

fn current_ipc_path() -> String {
    match runtime_store().lock() {
        Ok(guard) => guard.ipc_path.clone(),
        Err(poisoned) => poisoned.into_inner().ipc_path.clone(),
    }
}

fn state_store() -> &'static Mutex<MpvSnapshot> {
    static STATE: OnceLock<Mutex<MpvSnapshot>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(MpvSnapshot::default()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn snapshot() -> MpvSnapshot {
    match state_store().lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn update_state(apply: impl FnOnce(&mut MpvSnapshot)) -> MpvSnapshot {
    let mut guard = match state_store().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    apply(&mut guard);
    guard.updated_at_ms = now_ms();
    guard.clone()
}

fn emit_state_event(app: &AppHandle, reason: &str) {
    ensure_hot_logger();
    HOT_EMIT_STATE.fetch_add(1, Ordering::Relaxed);
    let state = snapshot();
    let _ = app.emit(MPV_STATE_EVENT, json!({ "reason": reason, "state": state }));
}

fn emit_progress_event(app: &AppHandle, reason: &str) {
    ensure_hot_logger();
    HOT_EMIT_PROGRESS.fetch_add(1, Ordering::Relaxed);
    let state = snapshot();
    let _ = app.emit(
        MPV_PROGRESS_EVENT,
        json!({
            "reason": reason,
            "current_time": state.current_time,
            "duration": state.duration,
            "phase": state.phase,
        }),
    );
}

fn emit_ended_event(app: &AppHandle, reason: &str) {
    let state = snapshot();
    let _ = app.emit(MPV_ENDED_EVENT, json!({ "reason": reason, "state": state }));
}

fn emit_error_event(app: &AppHandle, code: &str, message: &str) {
    let state = snapshot();
    let _ = app.emit(
        MPV_ERROR_EVENT,
        json!({ "code": code, "message": message, "state": state }),
    );
}

fn apply_error(action: &str, message: &str) -> MpvSnapshot {
    update_state(|state| {
        state.backend = MPV_BACKEND.to_string();
        state.backend_ready = false;
        state.phase = MpvPhase::Error;
        state.last_action = Some(action.to_string());
        state.last_error = Some(message.to_string());
    })
}

fn current_generation() -> u64 {
    snapshot().generation
}

fn mpv_socket_path(app: &AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {}", error))?;
    fs::create_dir_all(&dir).map_err(|error| format!("创建缓存目录失败: {}", error))?;
    Ok(dir.join(MPV_SOCKET_NAME).to_string_lossy().to_string())
}

fn is_child_running(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(Some(_)) => false,
        Ok(None) => true,
        Err(_) => false,
    }
}

fn wait_for_socket(path: &str) -> bool {
    for _ in 0..50 {
        if fs::metadata(path).is_ok() {
            #[cfg(unix)]
            if UnixStream::connect(path).is_ok() {
                return true;
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn apply_mpv_command_env(command: &mut Command, binary: &Path) {
    let extra = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/opt/local/bin:/usr/bin:/bin";
    match std::env::var("PATH") {
        Ok(path)
            if path.split(':').any(|item| {
                item == "/opt/homebrew/bin" || item == "/usr/local/bin" || item == "/opt/local/bin"
            }) => {}
        Ok(path) => {
            command.env("PATH", format!("{}:{}", extra, path));
        }
        Err(_) => {
            command.env("PATH", extra);
        }
    }
    if let Some(bin_dir) = binary.parent() {
        let lib_dir = bin_dir.join("../lib");
        if let Ok(canonical) = lib_dir.canonicalize() {
            if canonical.is_dir() {
                command.env("DYLD_LIBRARY_PATH", &canonical);
                command.env("DYLD_FALLBACK_LIBRARY_PATH", canonical);
            }
        } else if lib_dir.is_dir() {
            command.env("DYLD_LIBRARY_PATH", &lib_dir);
            command.env("DYLD_FALLBACK_LIBRARY_PATH", lib_dir);
        }
    }
}

fn resolve_mpv_binary(app: Option<&AppHandle>) -> PathBuf {
    if let Ok(custom) = std::env::var("CERU_MPV_PATH") {
        let path = PathBuf::from(custom.trim());
        if path.is_file() {
            return path;
        }
    }
    if let Some(app) = app {
        if let Ok(resource_dir) = app.path().resource_dir() {
            for candidate in ["mpv/bin/mpv", "mpv", "bin/mpv", "sidecar/mpv", "mpv/mpv"] {
                let path = resource_dir.join(candidate);
                if path.is_file() {
                    return path;
                }
            }
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["mpv", "mpv.exe"] {
                let path = dir.join(name);
                if path.is_file() {
                    return path;
                }
            }
            for candidate in [
                "../Resources/mpv/bin/mpv",
                "../Resources/mpv",
                "mpv/bin/mpv",
            ] {
                let bundled = dir.join(candidate);
                if bundled.is_file() {
                    return bundled;
                }
            }
        }
    }
    for candidate in [
        "/opt/homebrew/bin/mpv",
        "/usr/local/bin/mpv",
        "/opt/local/bin/mpv",
        "/usr/bin/mpv",
    ] {
        let path = Path::new(candidate);
        if path.is_file() {
            return path.to_path_buf();
        }
    }
    PathBuf::from("mpv")
}

fn start_mpv_process(app: AppHandle, runtime: &mut MpvRuntime) -> Result<(), String> {
    if let Some(child) = runtime.child.as_mut() {
        if is_child_running(child) {
            return Ok(());
        }
    }

    let ipc_path = mpv_socket_path(&app)?;
    let _ = fs::remove_file(&ipc_path);
    let binary = resolve_mpv_binary(Some(&app));
    let mut command = Command::new(&binary);
    apply_mpv_command_env(&mut command, &binary);
    let child = command
        .arg("--idle=yes")
        .arg("--no-video")
        .arg("--vo=null")
        .arg("--keep-open=no")
        .arg("--force-window=no")
        .arg("--terminal=no")
        .arg("--really-quiet")
        .arg("--audio-display=no")
        .arg("--hr-seek=no")
        .arg("--osd-level=0")
        .arg("--input-media-keys=no")
        .arg(format!("--input-ipc-server={}", ipc_path))
        .arg("--cache=yes")
        .arg("--cache-on-disk=no")
        // 在线播放抗网络抖动:原来只缓存 2 秒,网络稍有波动音频输出就会瞬间断流,
        // 恢复时听到"砰"的一声。放大到 30 秒缓存 / 20 秒预读,音频数据量很小,
        // 30 秒 320kbps 也就 ~1MB,内存代价可忽略。
        .arg("--cache-secs=30")
        .arg("--demuxer-readahead-secs=20")
        .arg("--demuxer-max-bytes=32MiB")
        .arg("--demuxer-max-back-bytes=1MiB")
        // 歌曲"播到一半突然断了、不播了"的根因:在线直链在播放途中偶发 TCP 连接被服务器
        // 关闭 / 网络瞬断,ffmpeg 的 http 协议默认不重连,直接读失败 -> mpv 发出
        // end-file(reason=error) -> 前端当成播放错误走换源/自动下一首,听感就是中途掐断。
        // 仅靠上面的 30 秒缓存只能平滑短暂卡顿,socket 真断了必须让 ffmpeg 自动重连。
        // 开启 ffmpeg http 重连(IINA / mpv.net 等同款做法),配合 network-timeout 容忍瞬断。
        .arg("--network-timeout=30")
        .arg(
            "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=5",
        )
        // 加大音频输出缓冲:默认 0.2s,前端频谱/WebGL/GC 偶发占用 CPU 时,
        // 音频输出线程会短暂饿死产生爆破音;0.5s 缓冲给足余量,对音乐播放
        // 的响应延迟无感知。
        .arg("--audio-buffer=0.5")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("启动内置 mpv 失败 ({}): {}", binary.display(), error))?;

    runtime.child = Some(child);
    runtime.ipc_path = ipc_path.clone();
    runtime.listener_started = false;
    runtime.applied_filters.clear();

    if !wait_for_socket(&ipc_path) {
        return Err("mpv IPC socket 未就绪".to_string());
    }

    let _ = set_property(&ipc_path, "input-media-keys", json!(false));

    update_state(|state| {
        state.backend = MPV_BACKEND.to_string();
        state.backend_ready = true;
        state.phase = MpvPhase::Idle;
        state.last_action = Some("init".to_string());
        state.last_error = None;
    });

    Ok(())
}

#[cfg(unix)]
fn send_ipc_command(path: &str, command: Value) -> Result<Value, String> {
    ensure_hot_logger();
    HOT_IPC_CONNECTS.fetch_add(1, Ordering::Relaxed);
    let mut stream =
        UnixStream::connect(path).map_err(|error| format!("连接 mpv IPC 失败: {}", error))?;
    let payload = json!({ "command": command }).to_string();
    stream
        .write_all(format!("{}\n", payload).as_bytes())
        .map_err(|error| format!("写入 mpv IPC 失败: {}", error))?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|error| format!("读取 mpv IPC 响应失败: {}", error))?;
    if line.trim().is_empty() {
        return Ok(json!({}));
    }
    let response = serde_json::from_str::<Value>(&line)
        .map_err(|error| format!("解析 mpv IPC 响应失败: {}", error))?;
    if response
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("success")
        != "success"
    {
        return Err(format!(
            "mpv IPC 命令失败: {}",
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
    }
    Ok(response)
}

#[cfg(not(unix))]
fn send_ipc_command(_path: &str, _command: Value) -> Result<Value, String> {
    Err("当前平台暂未启用 mpv IPC".to_string())
}

fn command(path: &str, items: Vec<Value>) -> Result<Value, String> {
    send_ipc_command(path, Value::Array(items))
}

fn set_property(path: &str, name: &str, value: Value) -> Result<Value, String> {
    command(path, vec![json!("set_property"), json!(name), value])
}

fn is_safe_audio_filter(filter: &str) -> bool {
    let value = filter.trim();
    !value.is_empty()
        && value.len() <= 2048
        && value.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(
                    ch,
                    '_' | '-'
                        | '='
                        | ':'
                        | '.'
                        | ','
                        | '+'
                        | '/'
                        | '\\'
                        | '['
                        | ']'
                        | '|'
                        | '*'
                        | '('
                        | ')'
                        | ';'
                        | ' '
                        | '@'
                )
        })
}

fn lavfi_escape_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
}

fn surround_ir_params(mode: &str) -> Option<(f64, f64, f64)> {
    match mode {
        "small" => Some((0.5, 3.0, 0.3)),
        "medium" => Some((1.5, 2.0, 0.5)),
        "large" => Some((3.0, 1.5, 0.8)),
        _ => None,
    }
}

fn lcg_unit(state: &mut u64) -> f64 {
    *state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1);
    ((*state >> 33) as f64) / ((1u64 << 31) as f64)
}

fn web_audio_convolver_scale(sum_sq: f64, channels: f64, length: f64, sample_rate: f64) -> f64 {
    // Match WebKit/Chromium ConvolverNode normalize: RMS power, then -58dB
    // GainCalibration so wet reverb is perceived near the dry signal.
    let mut power = (sum_sq / (channels * length)).sqrt();
    if !power.is_finite() || power < WEB_AUDIO_MIN_POWER {
        power = WEB_AUDIO_MIN_POWER;
    }
    let mut scale = 1.0 / power;
    scale *= 10f64.powf(WEB_AUDIO_GAIN_CALIBRATION_DB * 0.05);
    if sample_rate > 0.0 {
        scale *= WEB_AUDIO_GAIN_CALIBRATION_SAMPLE_RATE / sample_rate;
    }
    scale
}

fn write_float32le_wav(path: &Path, sample_rate: u32, frames: &[(f32, f32)]) -> Result<(), String> {
    let channels: u16 = 2;
    let bits_per_sample: u16 = 32;
    let audio_format: u16 = 3;
    let block_align = channels * bits_per_sample / 8;
    let byte_rate = sample_rate * u32::from(block_align);
    let data_bytes = (frames.len() as u32) * u32::from(block_align);
    let mut bytes = Vec::with_capacity(44 + data_bytes as usize);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    bytes.extend_from_slice(b"WAVE");
    bytes.extend_from_slice(b"fmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&audio_format.to_le_bytes());
    bytes.extend_from_slice(&channels.to_le_bytes());
    bytes.extend_from_slice(&sample_rate.to_le_bytes());
    bytes.extend_from_slice(&byte_rate.to_le_bytes());
    bytes.extend_from_slice(&block_align.to_le_bytes());
    bytes.extend_from_slice(&bits_per_sample.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    for (left, right) in frames {
        bytes.extend_from_slice(&left.to_le_bytes());
        bytes.extend_from_slice(&right.to_le_bytes());
    }
    fs::write(path, bytes).map_err(|error| format!("写入环绕 IR 失败: {}", error))
}

fn ensure_surround_ir(cache_dir: &Path, mode: &str) -> Result<PathBuf, String> {
    let (duration, decay, _) =
        surround_ir_params(mode).ok_or_else(|| format!("不支持的环绕模式: {}", mode))?;
    let ir_dir = cache_dir.join("surround-ir");
    fs::create_dir_all(&ir_dir).map_err(|error| format!("创建环绕 IR 目录失败: {}", error))?;
    let path = ir_dir.join(format!(
        "ceru-surround-ir-{}-{}.wav",
        SURROUND_IR_VERSION, mode
    ));
    if path.is_file() {
        return Ok(path);
    }
    let frame_count = ((duration * f64::from(SURROUND_IR_SAMPLE_RATE)).round() as usize).max(1);
    let mut state: u64 = 0xC0FF_EE5E_ED00_0001;
    let mut frames = Vec::with_capacity(frame_count);
    let mut sum_sq = 0.0f64;
    for index in 0..frame_count {
        let progress = index as f64 / frame_count as f64;
        let volume = (1.0 - progress).powf(decay);
        let left = ((lcg_unit(&mut state) * 2.0 - 1.0) * volume) as f32;
        let right = ((lcg_unit(&mut state) * 2.0 - 1.0) * volume) as f32;
        sum_sq += f64::from(left) * f64::from(left) + f64::from(right) * f64::from(right);
        frames.push((left, right));
    }
    let scale = web_audio_convolver_scale(
        sum_sq,
        2.0,
        frame_count as f64,
        f64::from(SURROUND_IR_SAMPLE_RATE),
    ) as f32;
    for frame in &mut frames {
        frame.0 *= scale;
        frame.1 *= scale;
    }
    write_float32le_wav(&path, SURROUND_IR_SAMPLE_RATE, &frames)?;
    Ok(path)
}

fn fmt_db(value: f64) -> String {
    let normalized = if value.abs() < 0.005 { 0.0 } else { value };
    format!("{:.2}", normalized)
        .trim_end_matches('0')
        .trim_end_matches('.')
        .to_string()
}

fn push_eq_filters(filters: &mut Vec<String>, equalizer: Option<&MpvEqualizerRequest>) {
    const EQ_FREQUENCIES: [u32; 10] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    let Some(equalizer) = equalizer else { return };
    if !equalizer.enabled {
        return;
    }
    for (index, frequency) in EQ_FREQUENCIES.iter().enumerate() {
        let gain = equalizer
            .gains
            .get(index)
            .copied()
            .filter(|value| value.is_finite())
            .unwrap_or(0.0)
            .clamp(-12.0, 12.0);
        if gain.abs() < 0.05 {
            continue;
        }
        filters.push(format!(
            "equalizer=f={}:t=q:w=1:g={}",
            frequency,
            fmt_db(gain)
        ));
    }
}

fn push_bass_filter(filters: &mut Vec<String>, bass_boost: Option<&MpvBassBoostRequest>) {
    let Some(bass_boost) = bass_boost else {
        return;
    };
    if !bass_boost.enabled {
        return;
    }
    let gain = bass_boost
        .gain
        .is_finite()
        .then_some(bass_boost.gain)
        .unwrap_or(0.0)
        .clamp(-12.0, 12.0);
    if gain.abs() < 0.05 {
        return;
    }
    filters.push(format!(
        // Match Electron Web Audio BiquadFilter lowshelf@200Hz, Q=1.
        "lowshelf=f=200:t=q:w=1:g={}",
        fmt_db(gain)
    ));
}

fn surround_wet_gain(mode: &str) -> Option<f64> {
    surround_ir_params(mode).map(|(_, _, wet)| wet)
}

fn surround_enabled(request: &MpvAudioFiltersRequest) -> bool {
    request
        .surround
        .as_ref()
        .is_some_and(|surround| surround.enabled && surround_wet_gain(&surround.mode).is_some())
}

fn surround_graph_fragment(cache_dir: &Path, mode: &str, wet: f64) -> Result<String, String> {
    let ir_path = ensure_surround_ir(cache_dir, mode)?;
    Ok(format!(
        "aformat=sample_fmts=fltp:channel_layouts=stereo,aresample={},asplit=2[dry][src];amovie={}[ir];[src][ir]afir=dry=1:wet={}:irnorm=-1:irfmt=input:minp=256:maxp=8192[wet];[dry][wet]amix=inputs=2:duration=first:dropout_transition=0:normalize=0",
        SURROUND_IR_SAMPLE_RATE,
        lavfi_escape_path(&ir_path),
        fmt_db(wet)
    ))
}

fn push_balance_filter(filters: &mut Vec<String>, balance: Option<&MpvBalanceRequest>) {
    let Some(balance) = balance else { return };
    if !balance.enabled {
        return;
    }
    let value = balance
        .value
        .is_finite()
        .then_some(balance.value)
        .unwrap_or(0.0)
        .clamp(-1.0, 1.0);
    if value.abs() < 0.01 {
        return;
    }
    let left = if value > 0.0 { 1.0 - value } else { 1.0 };
    let right = if value < 0.0 { 1.0 + value } else { 1.0 };
    filters.push(format!(
        "pan=stereo|c0={}*c0|c1={}*c1",
        fmt_db(left),
        fmt_db(right)
    ));
}

fn push_loudness_filter(filters: &mut Vec<String>, loudness: Option<&MpvLoudnessRequest>) {
    let Some(loudness) = loudness else {
        return;
    };
    if !loudness.enabled {
        return;
    }
    // mpv/FFmpeg realtime loudness uses dynaudnorm, not DynamicsCompressor.
    // Downward acompressor + limiter made hot masters quieter than bypass.
    // Delay is (g-1)/2*f ms; f=80,g=5 stays around 160ms.
    let params = match loudness.target.as_str() {
        "gentle" => "f=80:g=5:p=0.95:m=4:s=3:b=1",
        "strong" => "f=80:g=5:p=0.95:m=16:s=10:b=1",
        _ => "f=80:g=5:p=0.95:m=8:s=6:b=1",
    };
    filters.push(format!("dynaudnorm={}", params));
}

fn has_energy_boosting_effects(request: &MpvAudioFiltersRequest) -> bool {
    let eq_boost = request.equalizer.as_ref().is_some_and(|equalizer| {
        equalizer.enabled
            && equalizer
                .gains
                .iter()
                .any(|value| value.is_finite() && *value > 0.05)
    });
    let bass_boost = request
        .bass_boost
        .as_ref()
        .is_some_and(|bass| bass.enabled && bass.gain.is_finite() && bass.gain > 0.05);
    eq_boost || bass_boost
}

fn build_audio_filters(
    request: &MpvAudioFiltersRequest,
    cache_dir: Option<&Path>,
) -> Result<Vec<String>, String> {
    let mut filters = Vec::new();
    let mut eq = Vec::new();
    push_eq_filters(&mut eq, request.equalizer.as_ref());
    if !eq.is_empty() {
        filters.push(format!("@eq:lavfi=[{}]", eq.join(",")));
    }

    let mut bass = Vec::new();
    push_bass_filter(&mut bass, request.bass_boost.as_ref());
    if let Some(spec) = bass.first() {
        filters.push(format!("@bass:{}", spec));
    }

    if surround_enabled(request) {
        let surround = request
            .surround
            .as_ref()
            .ok_or_else(|| "缺少环绕设置".to_string())?;
        let wet = surround_wet_gain(&surround.mode)
            .ok_or_else(|| format!("不支持的环绕模式: {}", surround.mode))?;
        let dir = cache_dir.ok_or_else(|| "缺少环绕 IR 缓存目录".to_string())?;
        for mode in ["small", "medium", "large"] {
            let _ = ensure_surround_ir(dir, mode);
        }
        let surround_fragment = surround_graph_fragment(dir, &surround.mode, wet)?;
        filters.push(format!("@sur:lavfi=[{}]", surround_fragment));
    }

    let mut balance = Vec::new();
    push_balance_filter(&mut balance, request.balance.as_ref());
    if let Some(spec) = balance.first() {
        filters.push(format!("@bal:lavfi=[{}]", spec));
    }

    let mut loudness = Vec::new();
    push_loudness_filter(&mut loudness, request.loudness.as_ref());
    if let Some(spec) = loudness.first() {
        filters.push(format!("@loud:{}", spec));
    }

    if has_energy_boosting_effects(request) {
        filters.push("@lim:alimiter=limit=0.95:attack=5:release=80".to_string());
    }

    filters.extend(request.filters.iter().cloned());
    Ok(filters)
}

fn filter_label(spec: &str) -> String {
    spec.trim()
        .strip_prefix('@')
        .and_then(|value| value.split(':').next())
        .filter(|value| !value.is_empty())
        .unwrap_or("extra")
        .to_string()
}

fn apply_labeled_audio_filters(
    path: &str,
    filters: &[String],
    applied: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let desired = filters
        .iter()
        .map(|filter| filter.trim().to_string())
        .filter(|filter| !filter.is_empty())
        .map(|spec| (filter_label(&spec), spec))
        .collect::<Vec<_>>();
    if desired.iter().any(|(_, spec)| !is_safe_audio_filter(spec)) {
        return Err("mpv 音频滤镜包含非法字符".to_string());
    }

    if applied.is_empty() {
        let value = if desired.is_empty() {
            json!("")
        } else {
            json!(desired
                .iter()
                .map(|(_, spec)| spec.as_str())
                .collect::<Vec<_>>()
                .join(","))
        };
        set_property(path, "af", value)?;
        *applied = desired;
        return Ok(());
    }

    let desired_labels = desired
        .iter()
        .map(|(label, _)| label.clone())
        .collect::<HashSet<_>>();
    applied.retain(|(label, _)| {
        if desired_labels.contains(label) {
            true
        } else {
            let _ = command(
                path,
                vec![json!("af"), json!("remove"), json!(format!("@{}", label))],
            );
            false
        }
    });

    for (label, spec) in desired {
        if applied
            .iter()
            .any(|(current, value)| current == &label && value == &spec)
        {
            continue;
        }
        command(path, vec![json!("af"), json!("add"), json!(spec.clone())])?;
        if let Some(entry) = applied.iter_mut().find(|(current, _)| current == &label) {
            entry.1 = spec;
        } else {
            applied.push((label, spec));
        }
    }
    Ok(())
}

fn get_runtime_ipc_path(app: AppHandle) -> Result<String, String> {
    let mut runtime = match runtime_store().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    start_mpv_process(app.clone(), &mut runtime)?;
    if !runtime.listener_started {
        runtime.listener_started = true;
        start_event_listener(app, runtime.ipc_path.clone(), current_generation());
    }
    Ok(runtime.ipc_path.clone())
}

fn apply_http_options(path: &str, request: &MpvLoadRequest) -> Result<(), String> {
    if let Some(user_agent) = request
        .user_agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let _ = set_property(path, "user-agent", json!(user_agent))?;
    }
    if let Some(referrer) = request
        .referrer
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let _ = set_property(path, "referrer", json!(referrer))?;
    }

    let header_fields = request
        .headers
        .iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            let value = value.trim();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some(format!("{}: {}", key, value))
            }
        })
        .collect::<Vec<_>>();
    if !header_fields.is_empty() {
        let _ = set_property(path, "http-header-fields", json!(header_fields))?;
    }
    Ok(())
}

fn ipc_property_f64(path: &str, name: &str) -> Option<f64> {
    let response = command(path, vec![json!("get_property"), json!(name)]).ok()?;
    response
        .get("data")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
}

fn ipc_property_value(path: &str, name: &str) -> Option<Value> {
    let response = command(path, vec![json!("get_property"), json!(name)]).ok()?;
    response.get("data").cloned().filter(|value| !value.is_null())
}

// 强制 mpv 重建音频输出(AO)。macOS 上 CoreAudio AO 在系统默认输出设备切换、
// 蓝牙连接/断开、coreaudiod 重启或睡眠唤醒后会"静默死亡":解码和时钟继续推进,
// 但没有声音,只有彻底重建 AO 才能恢复。实测(mpv 0.41):把 audio-device 设成
// 当前同值是 no-op(mpv 对相同选项值去重,不会 reinit);而把 aid 先设为 "no"
// 再还原,会可靠地拆掉并重建整条音频链(含 AO),且不会重开网络流——demuxer/
// 缓存和播放位置都保留,只有一瞬间的音频断点。这正是从"死 AO"恢复所需。
fn reload_audio_output(path: &str) -> Result<(), String> {
    let restore = match ipc_property_value(path, "aid") {
        // 有选中的音轨时 aid 返回音轨号(如 1);空闲/无音轨时返回 false。
        Some(value) if value != Value::Bool(false) => value,
        _ => return Ok(()),
    };
    set_property(path, "aid", json!("no"))?;
    set_property(path, "aid", restore)?;
    Ok(())
}

fn refresh_time_pos(path: &str) {
    if path.is_empty() {
        return;
    }
    if let Some(current_time) = ipc_property_f64(path, "time-pos") {
        update_state(|state| {
            state.current_time = current_time.max(0.0);
        });
    }
}

#[cfg(unix)]
fn start_event_listener(app: AppHandle, ipc_path: String, listener_generation: u64) {
    thread::spawn(move || {
        let stream = match UnixStream::connect(&ipc_path) {
            Ok(stream) => stream,
            Err(error) => {
                let message = format!("mpv 事件监听连接失败: {}", error);
                apply_error("listen", &message);
                emit_error_event(&app, "mpv_listen_failed", &message);
                return;
            }
        };
        let mut writer = match stream.try_clone() {
            Ok(writer) => writer,
            Err(error) => {
                let message = format!("mpv 事件监听克隆失败: {}", error);
                apply_error("listen", &message);
                emit_error_event(&app, "mpv_listen_failed", &message);
                return;
            }
        };

        for (index, property) in ["duration", "pause", "idle-active", "paused-for-cache", "core-idle"]
            .iter()
            .enumerate()
        {
            let payload = json!({
                "command": ["observe_property", index + 1, property],
                "request_id": index + 1,
            });
            let _ = writer.write_all(format!("{}\n", payload).as_bytes());
        }

        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            handle_mpv_event(&app, payload, listener_generation);
        }

        let message = "mpv IPC 事件连接已断开".to_string();
        apply_error("listen", &message);
        emit_error_event(&app, "mpv_ipc_disconnected", &message);
    });
}

#[cfg(not(unix))]
fn start_event_listener(_app: AppHandle, _ipc_path: String, _listener_generation: u64) {}

fn handle_mpv_event(app: &AppHandle, payload: Value, _listener_generation: u64) {
    let event = payload
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match event {
        "property-change" => handle_property_change(app, &payload),
        "file-loaded" => {
            update_state(|state| {
                state.backend_ready = true;
                state.phase = if state.paused {
                    MpvPhase::Paused
                } else {
                    MpvPhase::Playing
                };
                state.last_action = Some("file_loaded".to_string());
                state.last_error = None;
            });
            refresh_time_pos(&current_ipc_path());
            emit_state_event(app, "file-loaded");
            emit_progress_event(app, "file-loaded");
        }
        "end-file" => {
            let reason = payload
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default();
            update_state(|state| {
                state.phase = if reason == "eof" {
                    MpvPhase::Ended
                } else {
                    MpvPhase::Stopped
                };
                state.paused = true;
                state.last_action = Some(format!("end_file:{}", reason));
                if reason == "error" {
                    state.phase = MpvPhase::Error;
                    state.last_error = Some("mpv 加载或播放当前资源失败".to_string());
                }
            });
            emit_state_event(app, "end-file");
            emit_progress_event(app, "end-file");
            if reason == "eof" {
                emit_ended_event(app, "eof");
            } else if reason == "error" {
                emit_error_event(app, "mpv_end_file_error", "mpv 加载或播放当前资源失败");
            }
        }
        "shutdown" => {
            update_state(|state| {
                state.backend_ready = false;
                state.phase = MpvPhase::Stopped;
                state.paused = true;
                state.last_action = Some("shutdown".to_string());
            });
            emit_state_event(app, "shutdown");
        }
        _ => {}
    }
}

fn handle_property_change(app: &AppHandle, payload: &Value) {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let data = payload.get("data").cloned().unwrap_or(Value::Null);
    let mut progress_changed = false;
    let mut state_changed = false;

    update_state(|state| match name {
        "duration" => {
            state.duration = data
                .as_f64()
                .filter(|value| value.is_finite() && *value >= 0.0);
            progress_changed = true;
        }
        "pause" => {
            let paused = data.as_bool().unwrap_or(true);
            state.paused = paused;
            if state.phase != MpvPhase::Loading && state.url.is_some() {
                state.phase = if paused {
                    MpvPhase::Paused
                } else {
                    MpvPhase::Playing
                };
            }
            state_changed = true;
        }
        "idle-active" => {
            if data.as_bool().unwrap_or(false) && state.url.is_none() {
                state.phase = MpvPhase::Idle;
                state_changed = true;
            }
        }
        "paused-for-cache" => {
            state.paused_for_cache = data.as_bool().unwrap_or(false);
            state_changed = true;
        }
        "core-idle" => {
            state.core_idle = data.as_bool().unwrap_or(false);
            state_changed = true;
        }
        _ => {}
    });

    if state_changed {
        emit_state_event(app, name);
    }
    if progress_changed {
        emit_progress_event(app, name);
    }
}

pub fn init(app: &AppHandle) {
    emit_state_event(app, "init");
}

#[tauri::command]
pub fn mpv_init(app: AppHandle) -> Result<MpvSnapshot, String> {
    match get_runtime_ipc_path(app.clone()) {
        Ok(_) => {
            emit_state_event(&app, "init");
            Ok(snapshot())
        }
        Err(error) => {
            apply_error("init", &error);
            emit_error_event(&app, "mpv_init_failed", &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn mpv_load(app: AppHandle, request: MpvLoadRequest) -> Result<MpvSnapshot, String> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        let message = "音频 URL 不能为空".to_string();
        apply_error("load", &message);
        emit_error_event(&app, "invalid_url", &message);
        return Err(message);
    }

    let path = match get_runtime_ipc_path(app.clone()) {
        Ok(path) => path,
        Err(error) => {
            apply_error("load", &error);
            emit_error_event(&app, "mpv_init_failed", &error);
            return Err(error);
        }
    };

    let volume = request
        .volume
        .unwrap_or_else(|| snapshot().volume)
        .clamp(0.0, 100.0);
    let playback_rate = request
        .playback_rate
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(1.0)
        .clamp(0.25, 4.0);
    let generation = update_state(|state| {
        state.generation = state.generation.saturating_add(1);
    })
    .generation;
    if let Err(error) = apply_http_options(&path, &request) {
        apply_error("load", &error);
        emit_error_event(&app, "mpv_options_failed", &error);
        return Err(error);
    }
    let _ = set_property(&path, "volume", json!(volume))?;
    let _ = set_property(&path, "audio-pitch-correction", json!(true))?;
    let _ = set_property(&path, "speed", json!(playback_rate))?;
    let _ = set_property(&path, "pause", json!(!request.autoplay.unwrap_or(true)))?;

    let start_time = request.start_time_seconds.unwrap_or(0.0).max(0.0);
    // loadfile 返回时文件还在异步打开，紧接着发 seek 会得到
    // "error running command" 然后被丢掉（mpv 0.41 实测），续播位置就是这么丢的。
    // 改用 loadfile 的 file-local options 传 start=，让 mpv 在文件就绪后自己定位。
    let load_args = if start_time > 0.0 {
        vec![
            json!("loadfile"),
            json!(url),
            json!("replace"),
            json!(-1),
            json!(format!("start={}", start_time)),
        ]
    } else {
        vec![json!("loadfile"), json!(url), json!("replace")]
    };
    if let Err(error) = command(&path, load_args) {
        apply_error("load", &error);
        emit_error_event(&app, "mpv_load_failed", &error);
        return Err(error);
    }

    let snapshot = update_state(|state| {
        state.backend = MPV_BACKEND.to_string();
        state.backend_ready = true;
        state.phase = MpvPhase::Loading;
        state.url = Some(url);
        state.current_time = start_time;
        state.duration = None;
        state.volume = volume;
        state.playback_rate = playback_rate;
        state.generation = generation;
        state.paused = !request.autoplay.unwrap_or(true);
        state.last_action = Some("load".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "load");
    emit_progress_event(&app, "load");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_play(app: AppHandle) -> Result<MpvSnapshot, String> {
    let path = get_runtime_ipc_path(app.clone())?;
    let _ = set_property(&path, "pause", json!(false))?;
    refresh_time_pos(&path);
    let snapshot = update_state(|state| {
        state.phase = MpvPhase::Playing;
        state.paused = false;
        state.last_action = Some("play".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "play");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_pause(app: AppHandle) -> Result<MpvSnapshot, String> {
    let path = get_runtime_ipc_path(app.clone())?;
    let _ = set_property(&path, "pause", json!(true))?;
    refresh_time_pos(&path);
    let snapshot = update_state(|state| {
        state.phase = MpvPhase::Paused;
        state.paused = true;
        state.last_action = Some("pause".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "pause");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_toggle(app: AppHandle) -> Result<MpvSnapshot, String> {
    if snapshot().paused {
        mpv_play(app)
    } else {
        mpv_pause(app)
    }
}

#[tauri::command]
pub fn mpv_stop(app: AppHandle) -> Result<MpvSnapshot, String> {
    let path = get_runtime_ipc_path(app.clone())?;
    let _ = command(&path, vec![json!("stop")])?;
    let snapshot = update_state(|state| {
        state.phase = MpvPhase::Stopped;
        state.paused = true;
        state.current_time = 0.0;
        state.last_action = Some("stop".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "stop");
    emit_progress_event(&app, "stop");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_seek(app: AppHandle, seconds: f64) -> Result<MpvSnapshot, String> {
    if !seconds.is_finite() {
        let message = "seek 时间必须是有限数字".to_string();
        emit_error_event(&app, "invalid_seek", &message);
        return Err(message);
    }
    let path = get_runtime_ipc_path(app.clone())?;
    let next_time = seconds.max(0.0);
    let _ = command(
        &path,
        vec![json!("seek"), json!(next_time), json!("absolute")],
    )?;
    refresh_time_pos(&path);
    let snapshot = update_state(|state| {
        state.current_time = next_time;
        state.last_action = Some("seek".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "seek");
    emit_progress_event(&app, "seek");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_set_volume(app: AppHandle, volume: f64) -> Result<MpvSnapshot, String> {
    ensure_hot_logger();
    HOT_SET_VOLUME.fetch_add(1, Ordering::Relaxed);
    if !volume.is_finite() {
        let message = "音量必须是有限数字".to_string();
        emit_error_event(&app, "invalid_volume", &message);
        return Err(message);
    }
    let path = get_runtime_ipc_path(app.clone())?;
    let next_volume = volume.clamp(0.0, 100.0);
    let current_volume = snapshot().volume;
    // 前端下发的是感知曲线映射值(p^2/100)，低音量段变化步长小，阈值相应收紧
    if (current_volume - next_volume).abs() < 0.25 {
        return Ok(snapshot());
    }
    let _ = set_property(&path, "volume", json!(next_volume))?;
    let snapshot = update_state(|state| {
        state.volume = next_volume;
        state.last_action = Some("set_volume".to_string());
        state.last_error = None;
    });
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_set_playback_rate(app: AppHandle, playback_rate: f64) -> Result<MpvSnapshot, String> {
    ensure_hot_logger();
    HOT_SET_RATE.fetch_add(1, Ordering::Relaxed);
    if !playback_rate.is_finite() || playback_rate <= 0.0 {
        let message = "播放倍速必须是正数".to_string();
        emit_error_event(&app, "invalid_playback_rate", &message);
        return Err(message);
    }
    let path = get_runtime_ipc_path(app.clone())?;
    let next_rate = playback_rate.clamp(0.25, 4.0);
    // Skip identical rates. Frontend used to re-apply 1.0 on every canplay,
    // and emitting state here re-entered that path through custom-protocol IPC.
    let current_rate = snapshot().playback_rate;
    if (current_rate - next_rate).abs() < 0.001 {
        return Ok(snapshot());
    }
    let _ = set_property(&path, "audio-pitch-correction", json!(true))?;
    let _ = set_property(&path, "speed", json!(next_rate))?;
    let snapshot = update_state(|state| {
        state.playback_rate = next_rate;
        state.last_action = Some("set_playback_rate".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "set_playback_rate");
    Ok(snapshot)
}

fn probe_http_header_arg(headers: &HashMap<String, String>) -> Option<String> {
    let fields = headers
        .iter()
        .filter_map(|(key, value)| {
            let key = key.trim();
            let value = value.trim();
            if key.is_empty() || value.is_empty() {
                None
            } else {
                Some(format!("{}: {}", key, value))
            }
        })
        .collect::<Vec<_>>();
    if fields.is_empty() {
        None
    } else {
        Some(fields.join(","))
    }
}

fn mpv_probe_once(
    app: Option<&AppHandle>,
    request: &MpvProbeRequest,
) -> Result<MpvProbeResult, String> {
    let url = request.url.trim();
    if url.is_empty() {
        return Err("音频 URL 不能为空".to_string());
    }
    let timeout_ms = request.timeout_ms.unwrap_or(3500).clamp(800, 10_000);
    let started = Instant::now();
    let binary = resolve_mpv_binary(app);
    let mut command = Command::new(&binary);
    apply_mpv_command_env(&mut command, &binary);
    command
        .arg("--no-config")
        .arg("--no-video")
        .arg("--vo=null")
        .arg("--terminal=no")
        .arg("--really-quiet")
        .arg("--ao=null")
        .arg("--untimed")
        .arg("--length=1")
        .arg("--audio-display=no")
        .arg("--input-media-keys=no")
        .arg("--cache=yes")
        .arg("--cache-on-disk=no")
        .arg("--cache-secs=1")
        .arg("--demuxer-readahead-secs=1")
        .arg("--demuxer-max-bytes=4MiB")
        .arg("--demuxer-max-back-bytes=512KiB")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(user_agent) = request
        .user_agent
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg(format!("--user-agent={}", user_agent));
    }
    if let Some(referrer) = request
        .referrer
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg(format!("--referrer={}", referrer));
    }
    if let Some(headers) = probe_http_header_arg(&request.headers) {
        command.arg(format!("--http-header-fields={}", headers));
    }
    let mut child = command
        .arg(url)
        .spawn()
        .map_err(|error| format!("启动 mpv probe 失败: {}", error))?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(MpvProbeResult {
                        ok: true,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    });
                }
                return Err(format!("mpv probe 失败: {}", status));
            }
            Ok(None) => {
                if started.elapsed() >= Duration::from_millis(timeout_ms) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("mpv probe 超时 {}ms", timeout_ms));
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("mpv probe 状态读取失败: {}", error));
            }
        }
    }
}

#[tauri::command]
pub fn mpv_probe(app: AppHandle, request: MpvProbeRequest) -> Result<MpvProbeResult, String> {
    mpv_probe_once(Some(&app), &request)
}

#[tauri::command]
pub fn mpv_set_audio_filters(
    app: AppHandle,
    request: MpvAudioFiltersRequest,
) -> Result<MpvSnapshot, String> {
    ensure_hot_logger();
    HOT_SET_FILTERS.fetch_add(1, Ordering::Relaxed);
    let path = get_runtime_ipc_path(app.clone())?;
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("获取缓存目录失败: {}", error))?;
    let filters = build_audio_filters(&request, Some(&cache_dir))?;
    let mut applied = {
        let runtime = match runtime_store().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        runtime.applied_filters.clone()
    };
    apply_labeled_audio_filters(&path, &filters, &mut applied)?;
    {
        let mut runtime = match runtime_store().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        runtime.applied_filters = applied;
    }
    let snapshot = update_state(|state| {
        state.last_action = Some("set_audio_filters".to_string());
        state.last_error = None;
    });
    emit_state_event(&app, "set_audio_filters");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_reload_audio_output(app: AppHandle) -> Result<MpvSnapshot, String> {
    let path = get_runtime_ipc_path(app.clone())?;
    // 失败软处理:AO 重建失败不应冒充"播放错误"去触发前端换源/自动下一首,
    // 只记录动作、把错误交给调用方静默处理。
    reload_audio_output(&path)?;
    refresh_time_pos(&path);
    let snapshot = update_state(|state| {
        state.last_action = Some("reload_audio_output".to_string());
        state.last_error = None;
    });
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_get_state() -> Result<MpvSnapshot, String> {
    ensure_hot_logger();
    HOT_GET_STATE.fetch_add(1, Ordering::Relaxed);
    refresh_time_pos(&current_ipc_path());
    Ok(snapshot())
}

#[tauri::command]
pub fn mpv_shutdown(app: AppHandle) -> Result<MpvSnapshot, String> {
    // 直接终止已持有的子进程，不在退出路径等待 MPV IPC 响应。MPV 是本进程创建的
    // 直接子进程，kill + wait 能可靠回收它，也避免 IPC 卡住导致退出后继续播放。
    let child = {
        let mut runtime = match runtime_store().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let child = runtime.child.take();
        runtime.ipc_path.clear();
        runtime.listener_started = false;
        runtime.applied_filters.clear();
        child
    };

    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }

    let snapshot = update_state(|state| {
        state.backend_ready = false;
        state.phase = MpvPhase::Stopped;
        state.paused = true;
        state.last_action = Some("shutdown".to_string());
    });
    emit_state_event(&app, "shutdown");
    Ok(snapshot)
}

#[tauri::command]
pub fn mpv_debug_hot_ping(label: Option<String>) -> Result<bool, String> {
    if !cfg!(debug_assertions) {
        return Ok(false);
    }
    ensure_hot_logger();
    let line = format!(
        "{} frontend_ping label={}
",
        now_ms(),
        label.unwrap_or_else(|| "default".to_string())
    );
    let _ = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/ceru-mpv-hot.log")
        .and_then(|mut file| file.write_all(line.as_bytes()));
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request(mode: &str) -> MpvAudioFiltersRequest {
        MpvAudioFiltersRequest {
            filters: Vec::new(),
            equalizer: Some(MpvEqualizerRequest {
                enabled: true,
                gains: vec![3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            }),
            bass_boost: Some(MpvBassBoostRequest {
                enabled: true,
                gain: 6.0,
            }),
            surround: Some(MpvSurroundRequest {
                enabled: true,
                mode: mode.to_string(),
            }),
            balance: None,
            loudness: Some(MpvLoudnessRequest {
                enabled: true,
                target: "standard".to_string(),
            }),
        }
    }

    #[test]
    fn surround_graph_uses_afir_impulse() {
        let dir = std::env::temp_dir().join("ceru-surround-ir-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let filters = build_audio_filters(&sample_request("small"), Some(&dir)).unwrap();
        let graph = filters.join(",");
        assert!(graph.contains("@eq:lavfi=["));
        assert!(graph.contains("@bass:lowshelf=f=200:t=q:w=1:g=6"));
        assert!(graph.contains("@sur:lavfi=["));
        assert!(graph.contains("@loud:dynaudnorm=f=80:g=5:p=0.95:m=8:s=6:b=1"));
        assert!(graph.contains("afir=dry=1:wet=0.3:irnorm=-1"));
        assert!(graph.contains("aresample=48000"));
        assert!(graph.contains("asplit=2[dry][src]"));
        assert!(graph.contains("lowshelf=f=200:t=q:w=1:g=6"));
        assert!(graph.contains("equalizer=f=31:t=q:w=1:g=3"));
        assert!(graph.contains("dynaudnorm=f=80:g=5:p=0.95:m=8:s=6:b=1"));
        assert!(!graph.contains("acompressor="));
        assert!(graph.contains("amovie="));
        assert!(!graph.contains("aecho="));
        assert!(!graph.contains("volume=0.82"));
        assert!(!graph.contains("afir=dry=0"));
        assert!(filters.iter().all(|filter| is_safe_audio_filter(filter)));
        assert!(dir
            .join("surround-ir")
            .join("ceru-surround-ir-v2-medium.wav")
            .is_file());
        assert!(dir
            .join("surround-ir")
            .join("ceru-surround-ir-v2-large.wav")
            .is_file());
        let ir = dir
            .join("surround-ir")
            .join("ceru-surround-ir-v2-small.wav");
        assert!(ir.is_file());
        let bytes = fs::read(&ir).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[20..22], 3u16.to_le_bytes());
        assert!(bytes.len() > 44);
    }

    #[test]
    fn disabled_effects_do_not_build_filters() {
        let request = MpvAudioFiltersRequest::default();
        let filters = build_audio_filters(&request, None).unwrap();
        assert!(filters.is_empty());
    }

    #[test]
    fn surround_only_does_not_add_limiter() {
        let dir = std::env::temp_dir().join("ceru-surround-ir-only-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let request = MpvAudioFiltersRequest {
            surround: Some(MpvSurroundRequest {
                enabled: true,
                mode: "medium".to_string(),
            }),
            ..MpvAudioFiltersRequest::default()
        };
        let graph = build_audio_filters(&request, Some(&dir)).unwrap().join(",");
        assert!(graph.contains("afir=dry=1:wet=0.5:irnorm=-1"));
        assert!(graph.contains("@sur:lavfi=["));
        assert!(!graph.contains("alimiter="));
        assert!(build_audio_filters(&request, Some(&dir))
            .unwrap()
            .iter()
            .all(|filter| is_safe_audio_filter(filter)));
    }

    #[test]
    fn loudness_uses_dynaudnorm_without_limiter() {
        let request = MpvAudioFiltersRequest {
            loudness: Some(MpvLoudnessRequest {
                enabled: true,
                target: "strong".to_string(),
            }),
            ..MpvAudioFiltersRequest::default()
        };
        let graph = build_audio_filters(&request, None).unwrap().join(",");
        assert!(graph.contains("dynaudnorm=f=80:g=5:p=0.95:m=16:s=10:b=1"));
        assert!(graph.contains("@loud:dynaudnorm="));
        assert!(!graph.contains("alimiter="));
        assert!(!graph.contains("acompressor="));
    }

    #[test]
    fn labeled_filters_replace_one_effect_at_a_time() {
        let dir = std::env::temp_dir().join("ceru-labeled-af-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let first = build_audio_filters(&sample_request("small"), Some(&dir)).unwrap();
        let second = build_audio_filters(&sample_request("large"), Some(&dir)).unwrap();
        let first_sur = first
            .iter()
            .find(|filter| filter.starts_with("@sur:"))
            .cloned()
            .unwrap();
        let second_sur = second
            .iter()
            .find(|filter| filter.starts_with("@sur:"))
            .cloned()
            .unwrap();
        assert_ne!(first_sur, second_sur);
        assert_eq!(
            first.iter().find(|filter| filter.starts_with("@eq:")),
            second.iter().find(|filter| filter.starts_with("@eq:"))
        );
        assert_eq!(
            first.iter().find(|filter| filter.starts_with("@loud:")),
            second.iter().find(|filter| filter.starts_with("@loud:"))
        );
    }
}
