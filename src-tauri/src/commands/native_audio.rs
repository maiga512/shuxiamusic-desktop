use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SizedSample};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use tauri::{AppHandle, Emitter};

pub const NATIVE_AUDIO_STATE_EVENT: &str = "native-audio:state";
pub const NATIVE_AUDIO_PROGRESS_EVENT: &str = "native-audio:progress";
pub const NATIVE_AUDIO_ENDED_EVENT: &str = "native-audio:ended";
pub const NATIVE_AUDIO_ERROR_EVENT: &str = "native-audio:error";
pub const NATIVE_AUDIO_EQUALIZER_EVENT: &str = "native-audio:equalizer";

pub const NATIVE_AUDIO_EQ_FREQUENCIES: [f64; 10] = [
    31.0, 62.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0,
];

const CPAL_SYMPHONIA_BACKEND: &str = "cpal-symphonia";
const NATIVE_AUDIO_EQ_BAND_COUNT: usize = 10;
const NATIVE_AUDIO_EQ_Q: f64 = 1.0;
const NATIVE_AUDIO_EQ_MIN_GAIN_DB: f64 = -12.0;
const NATIVE_AUDIO_EQ_MAX_GAIN_DB: f64 = 12.0;
const NATIVE_AUDIO_EQ_PREVIEW_SAMPLE_RATE: f64 = 44_100.0;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NativeAudioPhase {
    Idle,
    Loaded,
    Playing,
    Paused,
    Stopped,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioSnapshot {
    pub backend: String,
    pub backend_ready: bool,
    pub phase: NativeAudioPhase,
    pub url: Option<String>,
    pub song_info: Option<Value>,
    pub current_time: f64,
    pub duration: Option<f64>,
    pub volume: f64,
    pub playback_rate: f64,
    pub muted: bool,
    pub last_error: Option<String>,
    pub last_action: Option<String>,
    pub equalizer: NativeAudioEqualizerSnapshot,
    pub updated_at_ms: u64,
}

impl Default for NativeAudioSnapshot {
    fn default() -> Self {
        Self {
            backend: CPAL_SYMPHONIA_BACKEND.to_string(),
            backend_ready: false,
            phase: NativeAudioPhase::Idle,
            url: None,
            song_info: None,
            current_time: 0.0,
            duration: None,
            volume: 80.0,
            playback_rate: 1.0,
            muted: false,
            last_error: None,
            last_action: None,
            equalizer: NativeAudioEqualizerSnapshot::default(),
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioLoadRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub song_info: Option<Value>,
    #[serde(default)]
    pub autoplay: Option<bool>,
    #[serde(default)]
    pub start_time_seconds: Option<f64>,
    #[serde(default)]
    pub volume: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioEqualizerRequest {
    #[serde(default)]
    pub enabled: bool,
    pub gains: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioBiquadCoefficients {
    pub frequency: f64,
    pub q: f64,
    pub gain_db: f64,
    pub sample_rate: f64,
    pub b0: f64,
    pub b1: f64,
    pub b2: f64,
    pub a1: f64,
    pub a2: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioEqualizerSnapshot {
    pub enabled: bool,
    pub frequencies: Vec<f64>,
    pub gains: Vec<f64>,
    pub effective_gains: Vec<f64>,
    pub q: f64,
    pub sample_rate: f64,
    pub bands: Vec<NativeAudioBiquadCoefficients>,
    pub updated_at_ms: u64,
}

impl Default for NativeAudioEqualizerSnapshot {
    fn default() -> Self {
        Self::new(false, vec![0.0; NATIVE_AUDIO_EQ_BAND_COUNT])
    }
}

impl NativeAudioEqualizerSnapshot {
    pub fn new(enabled: bool, gains: Vec<f64>) -> Self {
        let normalized_gains = normalize_eq_gains(&gains);
        let effective_gains = if enabled {
            normalized_gains.clone()
        } else {
            vec![0.0; NATIVE_AUDIO_EQ_BAND_COUNT]
        };
        let bands = build_eq_coefficients(&effective_gains, NATIVE_AUDIO_EQ_PREVIEW_SAMPLE_RATE);

        Self {
            enabled,
            frequencies: NATIVE_AUDIO_EQ_FREQUENCIES.to_vec(),
            gains: normalized_gains,
            effective_gains,
            q: NATIVE_AUDIO_EQ_Q,
            sample_rate: NATIVE_AUDIO_EQ_PREVIEW_SAMPLE_RATE,
            bands,
            updated_at_ms: now_ms(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct NativeAudioBiquadFilter {
    pub coefficients: NativeAudioBiquadCoefficients,
    pub z1: f64,
    pub z2: f64,
}

impl NativeAudioBiquadFilter {
    pub fn new(coefficients: NativeAudioBiquadCoefficients) -> Self {
        Self {
            coefficients,
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn process_sample(&mut self, sample: f64) -> f64 {
        let output = self.coefficients.b0 * sample + self.z1;
        self.z1 = self.coefficients.b1 * sample - self.coefficients.a1 * output + self.z2;
        self.z2 = self.coefficients.b2 * sample - self.coefficients.a2 * output;
        output
    }
}

#[derive(Clone, Debug)]
pub struct NativeAudioEqualizerDsp {
    pub filters: Vec<NativeAudioBiquadFilter>,
}

impl NativeAudioEqualizerDsp {
    pub fn from_snapshot(snapshot: &NativeAudioEqualizerSnapshot, sample_rate: f64) -> Self {
        let gains = if snapshot.enabled {
            snapshot.gains.clone()
        } else {
            vec![0.0; NATIVE_AUDIO_EQ_BAND_COUNT]
        };
        let filters = build_eq_coefficients(&normalize_eq_gains(&gains), sample_rate)
            .into_iter()
            .map(NativeAudioBiquadFilter::new)
            .collect();

        Self { filters }
    }

    pub fn process_sample(&mut self, sample: f64) -> f64 {
        self.filters
            .iter_mut()
            .fold(sample, |current, filter| filter.process_sample(current))
    }
}

#[derive(Clone, Debug)]
struct DecodedAudio {
    samples: Arc<Vec<f32>>,
    channels: usize,
    sample_rate: u32,
    duration: Option<f64>,
}

#[derive(Debug)]
struct PlaybackCursor {
    samples: Arc<Vec<f32>>,
    input_channels: usize,
    output_channels: usize,
    source_sample_rate: u32,
    output_sample_rate: u32,
    position_frames: f64,
    volume: f32,
    playback_rate: f64,
}

impl PlaybackCursor {
    fn next_sample(&mut self, output_channel: usize) -> Option<f32> {
        let frame_index = self.position_frames.floor() as usize;
        let total_frames = self.samples.len() / self.input_channels;
        if frame_index >= total_frames {
            return None;
        }

        let source_channel = output_channel.min(self.input_channels.saturating_sub(1));
        let sample = self
            .samples
            .get(frame_index * self.input_channels + source_channel)
            .copied()
            .unwrap_or(0.0)
            * self.volume;

        if output_channel + 1 >= self.output_channels {
            self.position_frames += (f64::from(self.source_sample_rate)
                / f64::from(self.output_sample_rate))
                * self.playback_rate.clamp(0.25, 4.0);
        }

        Some(sample.clamp(-1.0, 1.0))
    }

    fn current_time(&self) -> f64 {
        self.position_frames / f64::from(self.source_sample_rate)
    }
}

#[derive(Debug)]
struct PlaybackSharedState {
    cursor: Option<PlaybackCursor>,
    equalizer: NativeAudioEqualizerSnapshot,
    eq_dsps: Vec<NativeAudioEqualizerDsp>,
    paused: bool,
    ended: bool,
}

struct CpalSymphoniaBackend {
    decoded: Option<DecodedAudio>,
    shared: Arc<Mutex<PlaybackSharedState>>,
    stream: Option<cpal::Stream>,
}

impl Default for CpalSymphoniaBackend {
    fn default() -> Self {
        Self {
            decoded: None,
            shared: Arc::new(Mutex::new(PlaybackSharedState {
                cursor: None,
                equalizer: NativeAudioEqualizerSnapshot::default(),
                eq_dsps: Vec::new(),
                paused: true,
                ended: false,
            })),
            stream: None,
        }
    }
}

impl CpalSymphoniaBackend {
    fn load(&mut self, url: &str, start_time: f64, volume: f64) -> Result<(), String> {
        self.stop();
        let bytes = read_media_bytes(url)?;
        let decoded = decode_media(bytes)?;
        let start_frame = seconds_to_frame(
            start_time,
            decoded.sample_rate,
            decoded.samples.len(),
            decoded.channels,
        );
        let cursor = PlaybackCursor {
            samples: decoded.samples.clone(),
            input_channels: decoded.channels,
            output_channels: decoded.channels,
            source_sample_rate: decoded.sample_rate,
            output_sample_rate: decoded.sample_rate,
            position_frames: start_frame as f64,
            volume: volume_to_gain(volume),
            playback_rate: snapshot().playback_rate,
        };

        if let Ok(mut shared) = self.shared.lock() {
            shared.cursor = Some(cursor);
            shared.eq_dsps =
                build_eq_dsps(&shared.equalizer, decoded.channels, decoded.sample_rate);
            shared.paused = true;
            shared.ended = false;
        }
        self.decoded = Some(decoded);
        Ok(())
    }

    fn play(&mut self) -> Result<(), String> {
        if self.decoded.is_none() {
            return Err("尚未加载音频源".to_string());
        }
        self.ensure_stream()?;
        if let Ok(mut shared) = self.shared.lock() {
            shared.paused = false;
            shared.ended = false;
        }
        if let Some(stream) = self.stream.as_ref() {
            stream
                .play()
                .map_err(|error| format!("启动 cpal 输出流失败: {}", error))?;
        }
        Ok(())
    }

    fn pause(&mut self) -> Result<(), String> {
        if let Ok(mut shared) = self.shared.lock() {
            shared.paused = true;
        }
        if let Some(stream) = self.stream.as_ref() {
            let _ = stream.pause();
        }
        Ok(())
    }

    fn stop(&mut self) {
        self.stream = None;
        if let Ok(mut shared) = self.shared.lock() {
            shared.cursor = None;
            shared.eq_dsps.clear();
            shared.paused = true;
            shared.ended = false;
        }
    }

    fn seek(&mut self, seconds: f64) -> Result<(), String> {
        let decoded = self
            .decoded
            .as_ref()
            .ok_or_else(|| "尚未加载音频源".to_string())?;
        let frame = seconds_to_frame(
            seconds,
            decoded.sample_rate,
            decoded.samples.len(),
            decoded.channels,
        );
        if let Ok(mut shared) = self.shared.lock() {
            let was_paused = shared.paused;
            shared.cursor = Some(PlaybackCursor {
                samples: decoded.samples.clone(),
                input_channels: decoded.channels,
                output_channels: decoded.channels,
                source_sample_rate: decoded.sample_rate,
                output_sample_rate: decoded.sample_rate,
                position_frames: frame as f64,
                volume: snapshot_volume_gain(),
                playback_rate: snapshot().playback_rate,
            });
            shared.eq_dsps =
                build_eq_dsps(&shared.equalizer, decoded.channels, decoded.sample_rate);
            shared.paused = was_paused;
            shared.ended = false;
        }
        Ok(())
    }

    fn set_volume(&mut self, volume: f64) {
        if let Ok(mut shared) = self.shared.lock() {
            if let Some(cursor) = shared.cursor.as_mut() {
                cursor.volume = volume_to_gain(volume);
            }
        }
    }

    fn set_playback_rate(&mut self, playback_rate: f64) {
        if let Ok(mut shared) = self.shared.lock() {
            if let Some(cursor) = shared.cursor.as_mut() {
                cursor.playback_rate = playback_rate.clamp(0.25, 4.0);
            }
        }
    }

    fn set_equalizer(&mut self, equalizer: NativeAudioEqualizerSnapshot) {
        if let Ok(mut shared) = self.shared.lock() {
            let output_channels = shared
                .cursor
                .as_ref()
                .map(|cursor| cursor.output_channels)
                .unwrap_or(0);
            let output_sample_rate = shared
                .cursor
                .as_ref()
                .map(|cursor| cursor.output_sample_rate)
                .unwrap_or(44_100);
            shared.eq_dsps = build_eq_dsps(&equalizer, output_channels, output_sample_rate);
            shared.equalizer = equalizer;
        }
    }

    fn current_time(&self) -> f64 {
        match self.shared.lock() {
            Ok(shared) => shared
                .cursor
                .as_ref()
                .map(PlaybackCursor::current_time)
                .unwrap_or(0.0),
            Err(poisoned) => poisoned
                .into_inner()
                .cursor
                .as_ref()
                .map(PlaybackCursor::current_time)
                .unwrap_or(0.0),
        }
    }

    fn duration(&self) -> Option<f64> {
        self.decoded.as_ref().and_then(|decoded| decoded.duration)
    }

    fn is_ended(&self) -> bool {
        match self.shared.lock() {
            Ok(shared) => shared.ended,
            Err(poisoned) => poisoned.into_inner().ended,
        }
    }

    fn ensure_stream(&mut self) -> Result<(), String> {
        if self.stream.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let device = host
            .default_output_device()
            .ok_or_else(|| "没有可用的默认音频输出设备".to_string())?;
        let supported_config = device
            .default_output_config()
            .map_err(|error| format!("读取默认输出配置失败: {}", error))?;
        let stream_config: cpal::StreamConfig = supported_config.clone().into();
        let output_channels = usize::from(stream_config.channels).max(1);
        let output_sample_rate = stream_config.sample_rate.max(1);

        if let Ok(mut shared) = self.shared.lock() {
            if let Some(cursor) = shared.cursor.as_mut() {
                cursor.output_channels = output_channels;
                cursor.output_sample_rate = output_sample_rate;
            }
            shared.eq_dsps = build_eq_dsps(&shared.equalizer, output_channels, output_sample_rate);
        }

        let shared = self.shared.clone();
        let err_fn = |error| eprintln!("[native-audio] cpal stream error: {}", error);
        let stream = match supported_config.sample_format() {
            cpal::SampleFormat::I8 => {
                build_output_stream::<i8>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::I16 => {
                build_output_stream::<i16>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::I24 => {
                build_output_stream::<cpal::I24>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::I32 => {
                build_output_stream::<i32>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::I64 => {
                build_output_stream::<i64>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::U8 => {
                build_output_stream::<u8>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::U16 => {
                build_output_stream::<u16>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::U32 => {
                build_output_stream::<u32>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::U64 => {
                build_output_stream::<u64>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::F32 => {
                build_output_stream::<f32>(&device, &stream_config, shared, err_fn)
            }
            cpal::SampleFormat::F64 => {
                build_output_stream::<f64>(&device, &stream_config, shared, err_fn)
            }
            sample_format => Err(format!("不支持的音频输出采样格式: {}", sample_format)),
        }?;

        self.stream = Some(stream);
        Ok(())
    }
}

static NATIVE_AUDIO_STATE: OnceLock<Mutex<NativeAudioSnapshot>> = OnceLock::new();
static CPAL_SYMPHONIA_AUDIO_BACKEND: OnceLock<Mutex<CpalSymphoniaBackend>> = OnceLock::new();
static PLAYBACK_GENERATION: AtomicU64 = AtomicU64::new(0);

fn state_store() -> &'static Mutex<NativeAudioSnapshot> {
    NATIVE_AUDIO_STATE.get_or_init(|| Mutex::new(NativeAudioSnapshot::default()))
}

fn audio_backend() -> &'static Mutex<CpalSymphoniaBackend> {
    CPAL_SYMPHONIA_AUDIO_BACKEND.get_or_init(|| Mutex::new(CpalSymphoniaBackend::default()))
}

fn next_playback_generation() -> u64 {
    PLAYBACK_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

fn current_playback_generation() -> u64 {
    PLAYBACK_GENERATION.load(Ordering::SeqCst)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn snapshot() -> NativeAudioSnapshot {
    match state_store().lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    }
}

fn update_state(apply: impl FnOnce(&mut NativeAudioSnapshot)) -> NativeAudioSnapshot {
    let mut guard = match state_store().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    apply(&mut guard);
    guard.updated_at_ms = now_ms();
    guard.clone()
}

pub fn emit_state_event(app: &AppHandle, reason: &str) {
    let state = snapshot();
    let _ = app.emit(
        NATIVE_AUDIO_STATE_EVENT,
        json!({
            "reason": reason,
            "state": state,
        }),
    );
}

pub fn emit_progress_event(app: &AppHandle, reason: &str) {
    let state = snapshot();
    let _ = app.emit(
        NATIVE_AUDIO_PROGRESS_EVENT,
        json!({
            "reason": reason,
            "state": state,
            "current_time": state.current_time,
            "duration": state.duration,
            "phase": state.phase,
            "backend_ready": state.backend_ready,
        }),
    );
}

pub fn emit_ended_event(app: &AppHandle, reason: &str) {
    let state = snapshot();
    let _ = app.emit(
        NATIVE_AUDIO_ENDED_EVENT,
        json!({
            "reason": reason,
            "state": state,
        }),
    );
}

pub fn emit_error_event(app: &AppHandle, code: &str, message: &str) {
    let state = snapshot();
    let _ = app.emit(
        NATIVE_AUDIO_ERROR_EVENT,
        json!({
            "code": code,
            "message": message,
            "state": state,
        }),
    );
}

pub fn emit_equalizer_event(app: &AppHandle, reason: &str) {
    let state = snapshot();
    let _ = app.emit(
        NATIVE_AUDIO_EQUALIZER_EVENT,
        json!({
            "reason": reason,
            "equalizer": state.equalizer,
            "state": state,
        }),
    );
}

fn normalize_eq_gains(gains: &[f64]) -> Vec<f64> {
    (0..NATIVE_AUDIO_EQ_BAND_COUNT)
        .map(|index| {
            gains
                .get(index)
                .copied()
                .filter(|gain| gain.is_finite())
                .unwrap_or(0.0)
                .clamp(NATIVE_AUDIO_EQ_MIN_GAIN_DB, NATIVE_AUDIO_EQ_MAX_GAIN_DB)
        })
        .collect()
}

fn build_eq_coefficients(gains: &[f64], sample_rate: f64) -> Vec<NativeAudioBiquadCoefficients> {
    let safe_sample_rate = if sample_rate.is_finite() && sample_rate > 0.0 {
        sample_rate
    } else {
        NATIVE_AUDIO_EQ_PREVIEW_SAMPLE_RATE
    };

    NATIVE_AUDIO_EQ_FREQUENCIES
        .iter()
        .zip(gains.iter().copied())
        .map(|(frequency, gain_db)| {
            build_peaking_coefficients(*frequency, gain_db, NATIVE_AUDIO_EQ_Q, safe_sample_rate)
        })
        .collect()
}

fn build_peaking_coefficients(
    frequency: f64,
    gain_db: f64,
    q: f64,
    sample_rate: f64,
) -> NativeAudioBiquadCoefficients {
    let nyquist_safe_frequency = frequency.clamp(1.0, (sample_rate / 2.0) - 1.0);
    let a = 10.0_f64.powf(gain_db / 40.0);
    let omega = 2.0 * std::f64::consts::PI * nyquist_safe_frequency / sample_rate;
    let sin_omega = omega.sin();
    let cos_omega = omega.cos();
    let alpha = sin_omega / (2.0 * q.max(0.000_001));

    let b0 = 1.0 + alpha * a;
    let b1 = -2.0 * cos_omega;
    let b2 = 1.0 - alpha * a;
    let a0 = 1.0 + alpha / a;
    let a1 = -2.0 * cos_omega;
    let a2 = 1.0 - alpha / a;

    NativeAudioBiquadCoefficients {
        frequency: nyquist_safe_frequency,
        q,
        gain_db,
        sample_rate,
        b0: b0 / a0,
        b1: b1 / a0,
        b2: b2 / a0,
        a1: a1 / a0,
        a2: a2 / a0,
    }
}

fn build_eq_dsps(
    equalizer: &NativeAudioEqualizerSnapshot,
    channels: usize,
    sample_rate: u32,
) -> Vec<NativeAudioEqualizerDsp> {
    if !equalizer.enabled {
        return Vec::new();
    }
    let channel_count = channels.max(1);
    let sample_rate = f64::from(sample_rate.max(1));
    (0..channel_count)
        .map(|_| NativeAudioEqualizerDsp::from_snapshot(equalizer, sample_rate))
        .collect()
}

fn build_output_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    shared: Arc<Mutex<PlaybackSharedState>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: Sample + SizedSample + FromSample<f32>,
{
    let channels = usize::from(config.channels).max(1);
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
                write_output_data(data, channels, &shared);
            },
            err_fn,
            None,
        )
        .map_err(|error| format!("创建 cpal 输出流失败: {}", error))
}

fn write_output_data<T>(output: &mut [T], channels: usize, shared: &Arc<Mutex<PlaybackSharedState>>)
where
    T: Sample + FromSample<f32>,
{
    let Ok(mut state) = shared.lock() else {
        fill_silence(output);
        return;
    };

    if state.paused {
        fill_silence(output);
        return;
    }

    for frame in output.chunks_mut(channels) {
        for (channel, sample) in frame.iter_mut().enumerate() {
            let value = match state
                .cursor
                .as_mut()
                .and_then(|cursor| cursor.next_sample(channel))
            {
                Some(value) => {
                    let dsp_index = channel.min(state.eq_dsps.len().saturating_sub(1));
                    state
                        .eq_dsps
                        .get_mut(dsp_index)
                        .map(|dsp| dsp.process_sample(f64::from(value)) as f32)
                        .unwrap_or(value)
                        .clamp(-1.0, 1.0)
                }
                None => {
                    state.ended = true;
                    state.paused = true;
                    0.0
                }
            };
            *sample = T::from_sample(value);
        }
    }
}

fn fill_silence<T>(output: &mut [T])
where
    T: Sample + FromSample<f32>,
{
    for sample in output.iter_mut() {
        *sample = T::from_sample(0.0);
    }
}

fn read_media_bytes(url: &str) -> Result<Vec<u8>, String> {
    if url.starts_with("http://") || url.starts_with("https://") {
        read_http_media_bytes(url)
    } else {
        std::fs::read(url).map_err(|error| format!("读取本地音频文件失败: {}", error))
    }
}

fn read_http_media_bytes(url: &str) -> Result<Vec<u8>, String> {
    let mut stream = std::net::TcpStream::connect(parse_local_http_addr(url)?)
        .map_err(|error| format!("连接本地音频流代理失败: {}", error))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|error| format!("配置音频流读取超时失败: {}", error))?;

    let request_path = url
        .split_once("//")
        .and_then(|(_, rest)| rest.split_once('/').map(|(_, path)| format!("/{}", path)))
        .unwrap_or_else(|| "/".to_string());
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\nAccept: */*\r\n\r\n",
        request_path
    );
    use std::io::Write;
    stream
        .write_all(request.as_bytes())
        .map_err(|error| format!("请求本地音频流失败: {}", error))?;

    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .map_err(|error| format!("读取本地音频流失败: {}", error))?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "本地音频流响应无效".to_string())?;
    let head = String::from_utf8_lossy(&response[..header_end]);
    let status_ok = head
        .lines()
        .next()
        .map(|line| line.contains(" 200 ") || line.contains(" 206 "))
        .unwrap_or(false);
    if !status_ok {
        return Err(format!(
            "本地音频流响应失败: {}",
            head.lines().next().unwrap_or("unknown")
        ));
    }
    Ok(response[(header_end + 4)..].to_vec())
}

fn parse_local_http_addr(url: &str) -> Result<String, String> {
    let rest = url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
        .ok_or_else(|| "音频流 URL 协议无效".to_string())?;
    let host = rest.split('/').next().unwrap_or_default();
    if host.is_empty() {
        return Err("音频流 URL 主机为空".to_string());
    }
    Ok(host.to_string())
}

fn decode_media(bytes: Vec<u8>) -> Result<DecodedAudio, String> {
    let source = Box::new(Cursor::new(bytes));
    let mss = MediaSourceStream::new(source, Default::default());
    let hint = Hint::new();
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            mss,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| format!("识别音频格式失败: {}", error))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "音频中没有可播放音轨".to_string())?;
    let track_id = track.id;
    let codec_params = track
        .codec_params
        .as_ref()
        .ok_or_else(|| "音频缺少解码参数".to_string())?;
    let sample_rate = codec_params
        .audio()
        .and_then(|audio| audio.sample_rate)
        .unwrap_or(44_100);
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(
            codec_params
                .audio()
                .ok_or_else(|| "音频解码参数无效".to_string())?,
            &AudioDecoderOptions::default(),
        )
        .map_err(|error| format!("创建音频解码器失败: {}", error))?;

    let mut samples = Vec::new();
    let mut channels = 0usize;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(SymphoniaError::ResetRequired) => break,
            Err(error) => return Err(format!("读取音频包失败: {}", error)),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                let spec = audio_buf.spec();
                channels = spec.channels().count().max(1);
                let mut chunk = vec![0.0f32; audio_buf.samples_interleaved()];
                audio_buf.copy_to_slice_interleaved(&mut chunk);
                samples.extend(chunk);
            }
            Err(SymphoniaError::IoError(_)) | Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(format!("解码音频失败: {}", error)),
        }
    }

    if samples.is_empty() || channels == 0 {
        return Err("音频解码结果为空".to_string());
    }

    let duration = Some(samples.len() as f64 / channels as f64 / f64::from(sample_rate));
    Ok(DecodedAudio {
        samples: Arc::new(samples),
        channels,
        sample_rate,
        duration,
    })
}

fn seconds_to_frame(seconds: f64, sample_rate: u32, sample_count: usize, channels: usize) -> usize {
    let total_frames = sample_count / channels.max(1);
    let frame = (seconds.max(0.0) * f64::from(sample_rate)).round() as usize;
    frame.min(total_frames)
}

fn volume_to_gain(volume: f64) -> f32 {
    (volume.clamp(0.0, 100.0) / 100.0) as f32
}

fn snapshot_volume_gain() -> f32 {
    volume_to_gain(snapshot().volume)
}

fn sync_backend_state(action: &str) -> NativeAudioSnapshot {
    let (current_time, duration, ended) = match audio_backend().lock() {
        Ok(backend) => (
            backend.current_time(),
            backend.duration(),
            backend.is_ended(),
        ),
        Err(poisoned) => {
            let backend = poisoned.into_inner();
            (
                backend.current_time(),
                backend.duration(),
                backend.is_ended(),
            )
        }
    };

    update_state(|state| {
        state.backend = CPAL_SYMPHONIA_BACKEND.to_string();
        state.backend_ready = true;
        state.current_time = current_time.max(0.0);
        state.duration = duration;
        if ended {
            state.phase = NativeAudioPhase::Stopped;
            if let Some(value) = duration {
                state.current_time = value;
            }
            state.last_action = Some("ended".to_string());
        } else {
            state.last_action = Some(action.to_string());
        }
    })
}

fn start_progress_loop(app: AppHandle, generation: u64) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        if current_playback_generation() != generation {
            break;
        }

        let state = sync_backend_state("progress");
        emit_progress_event(&app, "progress");

        if matches!(state.last_action.as_deref(), Some("ended")) {
            emit_state_event(&app, "ended");
            emit_ended_event(&app, "ended");
            break;
        }

        if !matches!(
            state.phase,
            NativeAudioPhase::Playing | NativeAudioPhase::Paused
        ) {
            break;
        }
    });
}

fn apply_error(action: &str, message: &str) -> NativeAudioSnapshot {
    update_state(|state| {
        state.backend = CPAL_SYMPHONIA_BACKEND.to_string();
        state.phase = NativeAudioPhase::Error;
        state.last_action = Some(action.to_string());
        state.last_error = Some(message.to_string());
    })
}

fn require_url_loaded() -> Result<NativeAudioSnapshot, String> {
    let state = snapshot();
    if state.url.is_none() {
        Err("尚未加载音频源".to_string())
    } else {
        Ok(state)
    }
}

pub fn init(app: &AppHandle) {
    emit_state_event(app, "init");
    emit_equalizer_event(app, "init");
}

#[tauri::command]
pub fn native_audio_load(
    app: AppHandle,
    request: NativeAudioLoadRequest,
) -> Result<NativeAudioSnapshot, String> {
    let url = request.url.trim().to_string();
    if url.is_empty() {
        let message = "音频 URL 不能为空".to_string();
        emit_error_event(&app, "invalid_url", &message);
        return Err(message);
    }

    let playback_url = match crate::commands::media_stream_proxy::proxied_stream_url(
        crate::commands::media_stream_proxy::MediaStreamRequest {
            url: url.clone(),
            headers: request.headers.clone(),
            referrer: request.referrer.clone(),
            user_agent: request.user_agent.clone(),
        },
    ) {
        Ok(value) => value,
        Err(error) => {
            let message = format!("本地音频流代理准备失败: {}", error);
            apply_error("load", &message);
            emit_state_event(&app, "load-error");
            emit_error_event(&app, "native_stream_proxy_failed", &message);
            return Err(message);
        }
    };

    let volume = request.volume.unwrap_or_else(|| snapshot().volume);
    let start_time = request.start_time_seconds.unwrap_or(0.0).max(0.0);
    let duration = {
        let mut backend = match audio_backend().lock() {
            Ok(backend) => backend,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Err(error) = backend.load(&playback_url, start_time, volume) {
            let message = format!("cpal+symphonia 原生音频加载失败: {}", error);
            apply_error("load", &message);
            emit_state_event(&app, "load-error");
            emit_error_event(&app, "native_load_failed", &message);
            return Err(message);
        }
        backend.duration()
    };

    let snapshot = update_state(|state| {
        state.backend = CPAL_SYMPHONIA_BACKEND.to_string();
        state.backend_ready = true;
        state.phase = NativeAudioPhase::Loaded;
        state.url = Some(url.clone());
        state.song_info = request.song_info.clone();
        state.current_time = start_time;
        state.duration = duration;
        state.volume = volume.clamp(0.0, 100.0);
        state.playback_rate = state.playback_rate.clamp(0.25, 4.0);
        state.muted = false;
        state.last_action = Some("load".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "load");
    emit_progress_event(&app, "load");

    if request.autoplay.unwrap_or(false) {
        return native_audio_play(app);
    }

    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_play(app: AppHandle) -> Result<NativeAudioSnapshot, String> {
    require_url_loaded()?;

    {
        let mut backend = match audio_backend().lock() {
            Ok(backend) => backend,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Err(error) = backend.play() {
            let message = format!("cpal+symphonia 原生音频播放失败: {}", error);
            let snapshot = apply_error("play", &message);
            emit_state_event(&app, "play-error");
            emit_error_event(&app, "native_play_failed", &message);
            return Err(snapshot.last_error.unwrap_or(message));
        }
    }

    let generation = next_playback_generation();
    let snapshot = update_state(|state| {
        state.backend = CPAL_SYMPHONIA_BACKEND.to_string();
        state.backend_ready = true;
        state.phase = NativeAudioPhase::Playing;
        state.last_action = Some("play".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "play");
    emit_progress_event(&app, "play");
    start_progress_loop(app, generation);
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_pause(app: AppHandle) -> Result<NativeAudioSnapshot, String> {
    require_url_loaded()?;
    {
        let mut backend = match audio_backend().lock() {
            Ok(backend) => backend,
            Err(poisoned) => poisoned.into_inner(),
        };
        backend.pause()?;
    }
    let current_time = match audio_backend().lock() {
        Ok(backend) => backend.current_time(),
        Err(poisoned) => poisoned.into_inner().current_time(),
    };
    let snapshot = update_state(|state| {
        state.phase = NativeAudioPhase::Paused;
        state.current_time = current_time.max(0.0);
        state.last_action = Some("pause".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "pause");
    emit_progress_event(&app, "pause");
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_stop(app: AppHandle) -> Result<NativeAudioSnapshot, String> {
    next_playback_generation();
    if let Ok(mut backend) = audio_backend().lock() {
        backend.stop();
    }
    let snapshot = update_state(|state| {
        state.backend = CPAL_SYMPHONIA_BACKEND.to_string();
        state.backend_ready = true;
        state.phase = NativeAudioPhase::Stopped;
        state.current_time = 0.0;
        state.last_action = Some("stop".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "stop");
    emit_progress_event(&app, "stop");
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_seek(app: AppHandle, seconds: f64) -> Result<NativeAudioSnapshot, String> {
    require_url_loaded()?;

    if !seconds.is_finite() {
        let message = "seek 时间必须是有限数字".to_string();
        emit_error_event(&app, "invalid_seek", &message);
        return Err(message);
    }

    {
        let mut backend = match audio_backend().lock() {
            Ok(backend) => backend,
            Err(poisoned) => poisoned.into_inner(),
        };
        backend.seek(seconds)?;
    }
    let snapshot = update_state(|state| {
        state.current_time = seconds.max(0.0);
        state.last_action = Some("seek".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "seek");
    emit_progress_event(&app, "seek");
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_set_volume(app: AppHandle, volume: f64) -> Result<NativeAudioSnapshot, String> {
    if !volume.is_finite() {
        let message = "音量必须是有限数字".to_string();
        emit_error_event(&app, "invalid_volume", &message);
        return Err(message);
    }

    if let Ok(mut backend) = audio_backend().lock() {
        backend.set_volume(volume);
    }
    let snapshot = update_state(|state| {
        state.volume = volume.clamp(0.0, 100.0);
        state.last_action = Some("set_volume".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "set_volume");
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_set_playback_rate(
    app: AppHandle,
    playback_rate: f64,
) -> Result<NativeAudioSnapshot, String> {
    if !playback_rate.is_finite() || playback_rate <= 0.0 {
        let message = "播放倍速必须是正数".to_string();
        emit_error_event(&app, "invalid_playback_rate", &message);
        return Err(message);
    }

    let safe_playback_rate = playback_rate.clamp(0.25, 4.0);
    if let Ok(mut backend) = audio_backend().lock() {
        backend.set_playback_rate(safe_playback_rate);
    }

    let snapshot = update_state(|state| {
        state.playback_rate = safe_playback_rate;
        state.last_action = Some("set_playback_rate".to_string());
        state.last_error = None;
    });

    emit_state_event(&app, "set_playback_rate");
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_set_equalizer(
    app: AppHandle,
    request: NativeAudioEqualizerRequest,
) -> Result<NativeAudioSnapshot, String> {
    if request.gains.iter().any(|gain| !gain.is_finite()) {
        let message = "EQ 增益必须是有限数字".to_string();
        emit_error_event(&app, "invalid_equalizer", &message);
        return Err(message);
    }

    let equalizer = NativeAudioEqualizerSnapshot::new(request.enabled, request.gains);
    if let Ok(mut backend) = audio_backend().lock() {
        backend.set_equalizer(equalizer.clone());
    }
    let snapshot = update_state(|state| {
        state.equalizer = equalizer;
        state.last_action = Some("set_equalizer".to_string());
        state.last_error = None;
    });

    emit_equalizer_event(&app, "set_equalizer");
    emit_state_event(&app, "set_equalizer");
    Ok(snapshot)
}

#[tauri::command]
pub fn native_audio_get_equalizer() -> Result<NativeAudioEqualizerSnapshot, String> {
    Ok(snapshot().equalizer)
}

#[tauri::command]
pub fn native_audio_get_state() -> Result<NativeAudioSnapshot, String> {
    Ok(snapshot())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioOutputDevice {
    pub device_id: String,
    pub label: String,
    pub kind: String,
    pub group_id: String,
    pub is_default: bool,
}

/// Enumerate host audio output devices for the settings UI.
/// WKWebView often returns an empty `audiooutput` list until media permission is
/// granted; cpal can still see the real device names.
#[tauri::command]
pub fn native_audio_list_output_devices() -> Result<Vec<NativeAudioOutputDevice>, String> {
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|device| device.name().ok());

    let mut devices = Vec::new();
    devices.push(NativeAudioOutputDevice {
        device_id: "default".to_string(),
        label: "系统默认".to_string(),
        kind: "audiooutput".to_string(),
        group_id: "default".to_string(),
        is_default: true,
    });

    let output_devices = host
        .output_devices()
        .map_err(|error| format!("枚举音频输出设备失败: {}", error))?;

    for (index, device) in output_devices.enumerate() {
        let label = device
            .name()
            .unwrap_or_else(|_| format!("Speaker {}", index + 1));
        let is_default = default_name
            .as_ref()
            .map(|name| name == &label)
            .unwrap_or(false);
        // Keep ids stable enough for A/B persistence within a session.
        let device_id = format!("cpal:{}", label);
        devices.push(NativeAudioOutputDevice {
            device_id,
            label,
            kind: "audiooutput".to_string(),
            group_id: format!("cpal-group-{}", index),
            is_default,
        });
    }

    Ok(devices)
}
