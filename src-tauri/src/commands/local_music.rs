use crate::db::Database;
use crate::models::*;
use base64::{engine::general_purpose, Engine as _};
use md5::{Digest, Md5};
use serde_json::Value;
use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use walkdir::WalkDir;

const AUDIO_EXTS: &[&str] = &[".mp3", ".flac", ".wav", ".aac", ".m4a", ".ogg", ".wma"];

// ==================== Helpers ====================

fn md5_hash(input: &str) -> String {
    format!("{:x}", Md5::digest(input.as_bytes()))
}

fn norm_path(p: &str) -> String {
    p.replace("file://", "").replace('\\', "/").to_lowercase()
}

fn gen_id(input: &str) -> String {
    md5_hash(input)
}

fn gen_cover_key(file_path: &str, mtime_ms: i64) -> String {
    md5_hash(&format!("{}:{}", file_path, mtime_ms))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis() as i64
}

fn format_duration(secs: f64) -> String {
    if !secs.is_finite() || secs <= 0.0 {
        return String::new();
    }
    let total_secs = secs as u64;
    let m = total_secs / 60;
    let s = total_secs % 60;
    format!("{}:{:02}", m, s)
}

/// Parse artist/title from filename when tags are missing.
fn parse_filename_tags(file_path: &str) -> (String, String) {
    let file_name = Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let parts: Vec<&str> = file_name
        .split(|c: char| c == '-' || c == '_')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() >= 2 {
        (parts[0].to_string(), parts[1..].join(" "))
    } else {
        (String::new(), file_name.to_string())
    }
}

fn has_audio_ext(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e.to_lowercase()))
        .map(|ext| AUDIO_EXTS.contains(&ext.as_str()))
        .unwrap_or(false)
}

/// Emit scan progress event.
fn emit_scan_progress(
    app: &tauri::AppHandle,
    processed: i64,
    total: i64,
    scanned: i64,
    reused: i64,
) {
    let _ = app.emit(
        "local-music:scan-progress",
        serde_json::json!({
            "processed": processed,
            "total": total,
            "scanned": scanned,
            "reused": reused,
        }),
    );
}

// ==================== ExifTool Integration ====================

/// Read tags quickly (title/artist/album/year/has_cover/lrc only).
fn read_audio_tags_quick(
    file_path: &str,
    include_lyrics: bool,
) -> (String, String, String, i64, bool, Option<String>) {
    let mut args = vec!["-json", "-Title", "-Artist", "-Album", "-Year", "-Picture"];
    if include_lyrics {
        args.push("-Lyrics");
    }
    args.push(file_path);

    let output = Command::new("exiftool").args(&args).output();
    let json_str = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Default::default(),
    };

    let parsed: Vec<Value> = match serde_json::from_str(&json_str) {
        Ok(v) => v,
        _ => return Default::default(),
    };

    let entry = match parsed.first() {
        Some(e) => e,
        None => return Default::default(),
    };

    let title = entry
        .get("Title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let artist = entry
        .get("Artist")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let album = entry
        .get("Album")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let year = entry.get("Year").and_then(|v| v.as_i64()).unwrap_or(0);
    let has_cover = entry.get("Picture").is_some();
    let lrc = if include_lyrics {
        entry
            .get("Lyrics")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    } else {
        None
    };

    (title, artist, album, year, has_cover, lrc)
}

/// Extract cover art from audio file, return base64 data URL.
fn extract_cover_base64(file_path: &str) -> Option<String> {
    // Check if picture exists
    let check = Command::new("exiftool")
        .args(&["-json", "-Picture", file_path])
        .output()
        .ok()?;
    let has_pic = if check.status.success() {
        let s = String::from_utf8_lossy(&check.stdout);
        serde_json::from_str::<Vec<Value>>(&s)
            .ok()
            .and_then(|v| v.into_iter().next())
            .map(|e| e.get("Picture").is_some())
            .unwrap_or(false)
    } else {
        false
    };
    if !has_pic {
        return None;
    }

    // Extract with -b flag
    let output = Command::new("exiftool")
        .args(&["-Picture", "-b", file_path])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    // Detect image type from magic bytes
    let mime = if output.stdout.len() > 4 {
        let head = &output.stdout[..4.min(output.stdout.len())];
        if head.starts_with(b"\xff\xd8\xff") {
            "image/jpeg"
        } else if head.starts_with(b"\x89PNG") {
            "image/png"
        } else if head.starts_with(b"RIFF") {
            "image/webp"
        } else {
            "image/jpeg"
        }
    } else {
        "image/jpeg"
    };

    let b64 = general_purpose::STANDARD.encode(&output.stdout);
    Some(format!("data:{};base64,{}", mime, b64))
}

// ==================== Commands ====================

/// Select music directories via native dialog.
///
/// 必须保持 `async`：非 async 命令跑在主线程，`blocking_pick_folders()` 会在
/// 主线程上等自己的对话框回调，主线程被占住后 sheet 收不到事件 → 应用卡死。
#[tauri::command]
pub async fn local_music_select_dirs(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folders(move |paths| {
        let _ = tx.send(paths);
    });
    let paths = rx
        .await
        .map_err(|_| "选择目录失败".to_string())?
        .unwrap_or_default();
    let result: Vec<String> = paths
        .into_iter()
        .filter_map(|f| {
            let s = f.to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        })
        .collect();
    Ok(result)
}

/// Scan local music directories for audio files.
/// Emits `local-music:scan-progress` and `local-music:scan-finished` events.
#[tauri::command]
pub fn local_music_scan(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    dirs: Vec<String>,
) -> Result<String, String> {
    if dirs.is_empty() {
        return Ok(String::new());
    }

    // Filter existing directories
    let exists_dirs: Vec<String> = dirs.into_iter().filter(|d| Path::new(d).exists()).collect();

    if exists_dirs.is_empty() {
        return Ok(String::new());
    }

    // Collect audio files
    let mut files: Vec<String> = Vec::new();
    for dir in &exists_dirs {
        for entry in WalkDir::new(dir)
            .follow_links(true)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            if entry.file_type().is_file() && has_audio_ext(entry.path()) {
                files.push(entry.path().to_string_lossy().to_string());
            }
        }
    }

    let total_files = files.len() as i64;

    // Cell-based counters for interior mutability (used in progress emission)
    let processed_count = Cell::new(0i64);
    let scanned_count = Cell::new(0i64);
    let reused_count = Cell::new(0i64);
    let last_progress_ms = Cell::new(0i64);

    // Pre-load existing track stats for cache check
    let all_tracks = db.get_all_tracks();
    let stats_map: HashMap<String, &TrackRow> =
        all_tracks.iter().map(|t| (t.path.clone(), t)).collect();

    // Closure to emit progress (only borrows app, not the counters)
    let emit_progress = |app: &tauri::AppHandle, force: bool| {
        let now = now_ms();
        if !force && now - last_progress_ms.get() < 80 {
            return;
        }
        last_progress_ms.set(now);
        emit_scan_progress(
            app,
            processed_count.get(),
            total_files,
            scanned_count.get(),
            reused_count.get(),
        );
    };

    // Process files in batches using exiftool for efficiency
    let exif_batch_size = 20;
    for chunk in files.chunks(exif_batch_size) {
        // Stat files and check cache first
        let mut uncached: Vec<(String, i64, i64)> = Vec::new(); // (path, size, mtime)

        for file_path in chunk {
            let meta = match fs::metadata(file_path) {
                Ok(m) => m,
                Err(_) => {
                    processed_count.set(processed_count.get() + 1);
                    emit_progress(&app, false);
                    continue;
                }
            };
            let size = meta.len() as i64;
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);

            let cached = stats_map.get(file_path.as_str());
            if let Some(cached) = cached {
                if cached.size == size && cached.mtime_ms == mtime_ms && size > 0 {
                    reused_count.set(reused_count.get() + 1);
                    processed_count.set(processed_count.get() + 1);
                    emit_progress(&app, false);
                    continue;
                }
            }

            uncached.push((file_path.clone(), size, mtime_ms));
        }

        // Process uncached files with exiftool batch
        if !uncached.is_empty() {
            let uncached_paths: Vec<&str> = uncached.iter().map(|(p, _, _)| p.as_str()).collect();
            let mut args = vec![
                "-json",
                "-Title",
                "-Artist",
                "-Album",
                "-Year",
                "-Duration",
                "-AudioBitrate",
                "-AudioSampleRate",
                "-Channels",
                "-Picture",
            ];
            args.extend(uncached_paths);

            let output = Command::new("exiftool").args(&args).output().ok();

            let mut pending_rows: Vec<TrackRow> = Vec::new();
            let mut processed_set: HashSet<usize> = HashSet::new();

            if let Some(o) = output {
                if o.status.success() {
                    let json_str = String::from_utf8_lossy(&o.stdout);
                    if let Ok(entries) = serde_json::from_str::<Vec<Value>>(&json_str) {
                        for entry in entries {
                            let source = entry
                                .get("SourceFile")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if source.is_empty() {
                                continue;
                            }
                            // Find index in uncached
                            if let Some(idx) = uncached.iter().position(|(p, _, _)| p == source) {
                                processed_set.insert(idx);
                                let (file_path, size, mtime_ms) = &uncached[idx];

                                let title =
                                    entry.get("Title").and_then(|v| v.as_str()).unwrap_or("");
                                let artist =
                                    entry.get("Artist").and_then(|v| v.as_str()).unwrap_or("");
                                let album =
                                    entry.get("Album").and_then(|v| v.as_str()).unwrap_or("");
                                let year = entry.get("Year").and_then(|v| v.as_i64()).unwrap_or(0);
                                let has_cover = entry.get("Picture").is_some();
                                let duration = entry
                                    .get("Duration")
                                    .and_then(|v| v.as_f64())
                                    .unwrap_or(0.0);
                                let bitrate = entry
                                    .get("AudioBitrate")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(0);
                                let sample_rate = entry
                                    .get("AudioSampleRate")
                                    .and_then(|v| v.as_i64())
                                    .unwrap_or(0);
                                let channels =
                                    entry.get("Channels").and_then(|v| v.as_i64()).unwrap_or(0);

                                let (parsed_singer, parsed_name) =
                                    if title.is_empty() || artist.is_empty() {
                                        parse_filename_tags(file_path)
                                    } else {
                                        (String::new(), String::new())
                                    };

                                let final_singer = if !artist.is_empty() {
                                    artist.to_string()
                                } else if !parsed_singer.is_empty() {
                                    parsed_singer
                                } else {
                                    "未知艺术家".to_string()
                                };
                                let final_name = if !title.is_empty() {
                                    title.to_string()
                                } else if !parsed_name.is_empty() {
                                    parsed_name
                                } else {
                                    "未知曲目".to_string()
                                };
                                let final_album = if !album.is_empty() {
                                    album.to_string()
                                } else {
                                    "未知专辑".to_string()
                                };

                                let normalized = norm_path(file_path);
                                let songmid = gen_id(&normalized);
                                let cover_key = gen_cover_key(file_path, *mtime_ms);
                                let hash =
                                    md5_hash(&format!("{}-{}-local", final_name, final_singer));

                                pending_rows.push(TrackRow {
                                    songmid,
                                    path: file_path.clone(),
                                    url: Some(format!("file://{}", file_path)),
                                    singer: final_singer,
                                    name: final_name,
                                    album_name: final_album,
                                    album_id: 0,
                                    source: "local".into(),
                                    interval: format_duration(duration),
                                    has_cover: if has_cover { 1 } else { 0 },
                                    cover_key: Some(cover_key),
                                    year,
                                    lrc: None,
                                    types: "[]".into(),
                                    _types: "{}".into(),
                                    type_url: "{}".into(),
                                    bitrate,
                                    sample_rate,
                                    channels,
                                    duration,
                                    size: *size,
                                    mtime_ms: *mtime_ms,
                                    hash: Some(hash),
                                    updated_at: now_ms(),
                                });
                            }
                        }
                    }
                }
            }

            // Fallback for uncached entries that exiftool didn't process
            for (idx, (file_path, size, mtime_ms)) in uncached.iter().enumerate() {
                if processed_set.contains(&idx) {
                    continue; // Already processed via exiftool
                }
                let (parsed_singer, parsed_name) = parse_filename_tags(file_path);
                let final_singer = if !parsed_singer.is_empty() {
                    parsed_singer
                } else {
                    "未知艺术家".to_string()
                };
                let final_name = if !parsed_name.is_empty() {
                    parsed_name
                } else {
                    "未知曲目".to_string()
                };

                let normalized = norm_path(file_path);
                let songmid = gen_id(&normalized);
                let cover_key = gen_cover_key(file_path, *mtime_ms);
                let hash = md5_hash(&format!("{}-{}-local", final_name, final_singer));

                pending_rows.push(TrackRow {
                    songmid,
                    path: file_path.clone(),
                    url: Some(format!("file://{}", file_path)),
                    singer: final_singer,
                    name: final_name,
                    album_name: "未知专辑".into(),
                    album_id: 0,
                    source: "local".into(),
                    interval: String::new(),
                    has_cover: 0,
                    cover_key: Some(cover_key),
                    year: 0,
                    lrc: None,
                    types: "[]".into(),
                    _types: "{}".into(),
                    type_url: "{}".into(),
                    bitrate: 0,
                    sample_rate: 0,
                    channels: 0,
                    duration: 0.0,
                    size: *size,
                    mtime_ms: *mtime_ms,
                    hash: Some(hash),
                    updated_at: now_ms(),
                });
            }

            // Batch upsert
            for row in &pending_rows {
                db.upsert_track(row);
            }

            // Update counts
            scanned_count.set(scanned_count.get() + pending_rows.len() as i64);
            processed_count.set(processed_count.get() + pending_rows.len() as i64);
            emit_progress(&app, false);
        }
    }

    // Emit final progress
    emit_progress(&app, true);

    // Prune stale entries
    let scanned_set: HashSet<String> = files.iter().cloned().collect();
    db.prune_by_scan(&exists_dirs, &scanned_set);

    // Emit scan-finished with full list
    let all_songs = db.get_all_tracks();
    let _ = app.emit("local-music:scan-finished", &all_songs);

    Ok(String::new())
}

/// Write tags to a local audio file using exiftool.
#[tauri::command]
pub fn local_music_write_tags(
    db: State<'_, Database>,
    file_path: String,
    song_info: Option<serde_json::Value>,
    _tag_write_options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "文件不存在"
        }));
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if ext == "wav" {
        return Ok(serde_json::json!({
            "success": false,
            "message": "WAV 文件不支持写入封面/歌词标签"
        }));
    }

    let mut cmd_args = vec!["-overwrite_original".to_string()];

    if let Some(info) = &song_info {
        if let Some(name) = info.get("name").and_then(|v| v.as_str()) {
            cmd_args.push(format!("-Title={}", name));
        }
        if let Some(singer) = info.get("singer").and_then(|v| v.as_str()) {
            cmd_args.push(format!("-Artist={}", singer));
        }
        if let Some(album) = info.get("albumName").and_then(|v| v.as_str()) {
            cmd_args.push(format!("-Album={}", album));
        }
        if let Some(year) = info.get("year").and_then(|v| v.as_i64()) {
            cmd_args.push(format!("-Year={}", year));
        }
        if let Some(lrc) = info.get("lrc").and_then(|v| v.as_str()) {
            if !lrc.is_empty() {
                cmd_args.push(format!("-Lyrics={}", lrc));
            }
        }
    }

    cmd_args.push(file_path.clone());

    let output = Command::new("exiftool").args(&cmd_args).output();

    match output {
        Ok(o) if o.status.success() => {
            // Update index
            let normalized = norm_path(&file_path);
            let songmid = gen_id(&normalized);
            if let Some(mut row) = db.get_track_by_id(&songmid) {
                if let Some(info) = &song_info {
                    if let Some(name) = info.get("name").and_then(|v| v.as_str()) {
                        row.name = name.to_string();
                    }
                    if let Some(singer) = info.get("singer").and_then(|v| v.as_str()) {
                        row.singer = singer.to_string();
                    }
                    if let Some(album) = info.get("albumName").and_then(|v| v.as_str()) {
                        row.album_name = album.to_string();
                    }
                    if let Some(year) = info.get("year").and_then(|v| v.as_i64()) {
                        row.year = year;
                    }
                }
                row.updated_at = now_ms();
                db.upsert_track(&row);
            }

            Ok(serde_json::json!({ "success": true }))
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr);
            Ok(serde_json::json!({
                "success": false,
                "message": format!("写入标签失败: {}", stderr)
            }))
        }
        Err(e) => Ok(serde_json::json!({
            "success": false,
            "message": format!("写入标签失败: {}", e)
        })),
    }
}

/// Get the URL for a local track by ID.
#[tauri::command]
pub fn local_music_get_url(
    db: State<'_, Database>,
    id: String,
) -> Result<serde_json::Value, String> {
    let track = db.get_track_by_id(&id);
    match track {
        Some(t) => {
            let url = t.url.unwrap_or_else(|| format!("file://{}", t.path));
            Ok(serde_json::json!({ "url": url }))
        }
        None => Ok(serde_json::json!({ "error": "未找到本地文件" })),
    }
}

/// Get cover art as base64 data URL for a track.
#[tauri::command]
pub fn local_music_get_cover(db: State<'_, Database>, track_id: String) -> Result<String, String> {
    let track = match db.get_track_by_id(&track_id) {
        Some(t) => t,
        None => return Ok(String::new()),
    };
    if !Path::new(&track.path).exists() {
        return Ok(String::new());
    }
    Ok(extract_cover_base64(&track.path).unwrap_or_default())
}

/// Batch get covers for multiple track IDs.
#[tauri::command]
pub fn local_music_get_covers(
    db: State<'_, Database>,
    track_ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let mut result = HashMap::new();
    for id in &track_ids {
        if let Some(track) = db.get_track_by_id(id) {
            if !track.path.is_empty() && Path::new(&track.path).exists() {
                if let Some(b64) = extract_cover_base64(&track.path) {
                    result.insert(id.clone(), b64);
                }
            }
        }
    }
    Ok(result)
}

/// Read tags for a local track.
#[tauri::command]
pub fn local_music_get_tags(
    db: State<'_, Database>,
    songmid: String,
    include_lyrics: Option<bool>,
) -> Result<Option<serde_json::Value>, String> {
    let track = match db.get_track_by_id(&songmid) {
        Some(t) => t,
        None => return Ok(None),
    };

    if !Path::new(&track.path).exists() {
        return Ok(None);
    }

    let incl_lrc = include_lyrics.unwrap_or(false);
    let (title, artist, album, year, _has_cover, lrc) =
        read_audio_tags_quick(&track.path, incl_lrc);

    Ok(Some(serde_json::json!({
        "name": title,
        "singer": artist,
        "albumName": album,
        "year": year,
        "lrc": lrc
    })))
}

/// Read lyrics from a local track.
#[tauri::command]
pub fn local_music_get_lyric(
    db: State<'_, Database>,
    songmid: String,
) -> Result<Option<String>, String> {
    let track = match db.get_track_by_id(&songmid) {
        Some(t) => t,
        None => return Ok(None),
    };

    if !Path::new(&track.path).exists() {
        return Ok(None);
    }

    let (_, _, _, _, _, lrc) = read_audio_tags_quick(&track.path, true);
    Ok(lrc)
}

/// Batch match local songs via NetEase search.
/// For each unmatched song, searches NetEase by artist/title,
/// writes matched metadata (title, artist, album, lyrics) to file tags,
/// updates the local index, and emits progress events.
#[tauri::command]
pub async fn local_music_batch_match(
    app: tauri::AppHandle,
    songmids: Vec<String>,
) -> Result<serde_json::Value, String> {
    let total = songmids.len();
    let mut processed = 0i64;
    let mut matched = 0i64;

    for songmid in &songmids {
        // Get track from DB — drop state before await
        let track = {
            let db = app.state::<Database>();
            db.get_track_by_id(songmid)
        };

        if let Some(ref track) = track {
            let (artist, title) = if !track.singer.is_empty() && !track.name.is_empty() {
                (track.singer.clone(), track.name.clone())
            } else {
                parse_filename_tags(&track.path)
            };

            if !title.is_empty() {
                let query = if !artist.is_empty() {
                    format!("{} {}", artist, title)
                } else {
                    title.clone()
                };

                // Search NetEase
                if let Ok(search_result) =
                    crate::commands::misc::search_netease(&query, 1, 5, false).await
                {
                    let song = search_result
                        .pointer("/result/songs")
                        .and_then(|v| v.as_array())
                        .and_then(|arr| arr.first().cloned());

                    if let Some(first) = song {
                        let song_name = first
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let artist_str: String = first
                            .get("artists")
                            .and_then(|v| v.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|a| a.get("name").and_then(|n| n.as_str()))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            })
                            .unwrap_or_default();
                        let album_name = first
                            .get("album")
                            .and_then(|a| a.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let song_id = first.get("id").and_then(|v| v.as_i64());

                        // fetch lyrics
                        let lrc = if let Some(id) = song_id {
                            crate::commands::misc::netease_get_lyric(&id.to_string())
                                .await
                                .ok()
                                .and_then(|v| {
                                    v.pointer("/lrc/lyric")
                                        .and_then(|l| l.as_str())
                                        .map(|s| s.to_string())
                                })
                        } else {
                            None
                        };

                        // write tags via exiftool
                        let file_path = &track.path;
                        let path = Path::new(file_path);
                        if path.exists() {
                            let ext = path
                                .extension()
                                .and_then(|e| e.to_str())
                                .map(|e| e.to_lowercase())
                                .unwrap_or_default();
                            if ext != "wav" {
                                let mut cmd_args = vec!["-overwrite_original".to_string()];
                                if !song_name.is_empty() {
                                    cmd_args.push(format!("-Title={}", song_name));
                                }
                                if !artist_str.is_empty() {
                                    cmd_args.push(format!("-Artist={}", artist_str));
                                }
                                if !album_name.is_empty() {
                                    cmd_args.push(format!("-Album={}", album_name));
                                }
                                if let Some(ref lrc_text) = lrc {
                                    cmd_args.push(format!("-Lyrics={}", lrc_text));
                                }
                                cmd_args.push(file_path.to_string());

                                if let Ok(output) =
                                    Command::new("exiftool").args(&cmd_args).output()
                                {
                                    if output.status.success() {
                                        // update DB
                                        if let Some(mut row) =
                                            { app.state::<Database>() }.get_track_by_id(songmid)
                                        {
                                            if !song_name.is_empty() {
                                                row.name = song_name;
                                            }
                                            if !artist_str.is_empty() {
                                                row.singer = artist_str;
                                            }
                                            if !album_name.is_empty() {
                                                row.album_name = album_name;
                                            }
                                            row.updated_at = now_ms();
                                            app.state::<Database>().upsert_track(&row);
                                        }
                                        matched += 1;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        processed += 1;
        let _ = app.emit(
            "local-music:batch-match-progress",
            serde_json::json!({
                "processed": processed,
                "total": total,
                "matched": matched,
            }),
        );
    }

    let _ = app.emit(
        "local-music:batch-match-finished",
        serde_json::json!({
            "success": true,
            "total": total,
            "matched": matched,
        }),
    );

    Ok(serde_json::json!({
        "success": true,
        "total": total,
        "matched": matched,
    }))
}
