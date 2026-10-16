use crate::db::Database;
use crate::models::DownloadTask;
use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// Managed state: tracks active downloads and provides wake-up signal.
pub struct DownloadEngine {
    /// Cancel-signal senders keyed by task_id.
    /// Engine inserts when a task starts; pause/cancel commands remove and send.
    pub cancel_signals: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    /// Sending () here wakes the engine loop immediately.
    wake_tx: tokio::sync::mpsc::UnboundedSender<()>,
}

impl DownloadEngine {
    /// Signal the background loop to re-process the queue.
    pub fn wake(&self) {
        let _ = self.wake_tx.send(());
    }
}

/// Initialise the download engine as managed state and start the background loop.
pub fn init(app: &AppHandle) {
    let (wake_tx, wake_rx) = tokio::sync::mpsc::unbounded_channel();

    let engine = DownloadEngine {
        cancel_signals: Arc::new(Mutex::new(HashMap::new())),
        wake_tx,
    };
    app.manage(engine);

    // Stuck "downloading" tasks from previous session → paused
    if let Some(db) = app.try_state::<Database>() {
        db.update_download_tasks_status("downloading", "paused");
    }

    let handle = app.clone();
    // Spawn a dedicated OS thread with its own Tokio runtime for the download engine.
    // Using tokio::spawn directly from the sync setup() callback would panic because
    // there's no active reactor at that point.
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("failed to create download engine runtime");
        rt.block_on(async move {
            engine_loop(handle, wake_rx).await;
        });
    });
}

// ── Background engine loop ────────────────────────────────────────────

async fn engine_loop(app: AppHandle, mut rx: tokio::sync::mpsc::UnboundedReceiver<()>) {
    loop {
        // Wait for a wake signal or a periodic tick
        tokio::select! {
            _ = rx.recv() => {}
            _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {}
        }
        process_queue(&app).await;
    }
}

/// Read pending tasks from DB, honouring concurrency limit, and spawn downloads.
pub async fn process_queue(app: &AppHandle) {
    let db = match app.try_state::<Database>() {
        Some(db) => db,
        None => return,
    };

    let max = db
        .get_setting("max_concurrent_downloads")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(3);

    let all = db.get_download_tasks();
    let active = all.iter().filter(|t| t.status == "downloading").count();
    let slots = max.saturating_sub(active);
    if slots == 0 {
        return;
    }

    let pending: Vec<DownloadTask> = all
        .into_iter()
        .filter(|t| t.status == "pending")
        .take(slots)
        .collect();
    drop(db); // release DB lock before spawning

    for mut task in pending {
        let task_id = task.task_id.clone();

        // Mark as downloading in DB and in-memory task before spawning.
        task.status = "downloading".into();
        task.progress = 0.0;
        task.downloaded_bytes = 0;
        if let Some(db) = app.try_state::<Database>() {
            db.update_download_task_status(&task_id, "downloading");
            let now = chrono::Utc::now().to_rfc3339();
            let db_conn = db.conn.lock().unwrap();
            let _ = db_conn.execute(
                "UPDATE download_tasks SET progress = 0, downloaded_bytes = 0, updated_at = ?1 WHERE task_id = ?2",
                rusqlite::params![now, task_id],
            );
        }
        let _ = app.emit("download:task-status-changed", &task);

        // Prepare cancel channel
        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();

        if let Some(engine) = app.try_state::<DownloadEngine>() {
            engine
                .cancel_signals
                .lock()
                .unwrap()
                .insert(task_id.clone(), cancel_tx);
        }

        let app_clone = app.clone();
        tokio::spawn(async move {
            download_file(app_clone, task, cancel_rx).await;
        });
    }
}

// ── Download implementation ───────────────────────────────────────────

fn download_headers(task: &DownloadTask) -> Vec<(String, String)> {
    let media = task.song_info.get("__nativeMedia");
    let mut headers = Vec::new();

    if let Some(raw_headers) = media
        .and_then(|value| value.get("headers"))
        .or_else(|| task.song_info.get("headers"))
        .and_then(|value| value.as_object())
    {
        for (key, value) in raw_headers {
            let name = key.trim();
            let text = value.as_str().unwrap_or_default().trim();
            if !name.is_empty() && !text.is_empty() {
                headers.push((name.to_string(), text.to_string()));
            }
        }
    }

    if let Some(referrer) = media
        .and_then(|value| value.get("referrer").or_else(|| value.get("referer")))
        .or_else(|| {
            task.song_info
                .get("referrer")
                .or_else(|| task.song_info.get("referer"))
        })
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("referer"))
        {
            headers.push(("Referer".to_string(), referrer.to_string()));
        }
    }

    if let Some(user_agent) = media
        .and_then(|value| value.get("userAgent").or_else(|| value.get("user_agent")))
        .or_else(|| {
            task.song_info
                .get("userAgent")
                .or_else(|| task.song_info.get("user_agent"))
        })
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if !headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("user-agent"))
        {
            headers.push(("User-Agent".to_string(), user_agent.to_string()));
        }
    }

    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("user-agent"))
    {
        headers.push((
            "User-Agent".to_string(),
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".to_string(),
        ));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("accept"))
    {
        headers.push(("Accept".to_string(), "*/*".to_string()));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("connection"))
    {
        headers.push(("Connection".to_string(), "keep-alive".to_string()));
    }

    headers
}

async fn download_file(app: AppHandle, mut task: DownloadTask, cancel_rx: oneshot::Receiver<()>) {
    let task_id = task.task_id.clone();
    let temp_path = format!("{}.temp", task.file_path);

    // Ensure parent directory exists
    if let Some(parent) = std::path::Path::new(&task.file_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Build reqwest client
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .unwrap_or_default();

    // Prepare cancel-aware stream wrapper
    let mut request = client.get(&task.url);
    for (key, value) in download_headers(&task) {
        request = request.header(key, value);
    }
    let response = match request.send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            let status = r.status().as_u16();
            return fail(&app, &mut task, &format!("服务器返回 HTTP {}", status)).await;
        }
        Err(e) => {
            if e.is_timeout() {
                return fail(&app, &mut task, "网络请求超时").await;
            }
            return fail(&app, &mut task, &format!("网络请求失败: {}", e)).await;
        }
    };

    let total_size = response.content_length().unwrap_or(0);
    task.total_bytes = total_size as i64;
    store_task(&app, &task);

    // Open temp file
    let mut file = match tokio::fs::File::create(&temp_path).await {
        Ok(f) => f,
        Err(e) => {
            return fail(&app, &mut task, &format!("创建文件失败: {}", e)).await;
        }
    };

    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut cancel_rx = cancel_rx;

    loop {
        tokio::select! {
            chunk = stream.next() => {
                match chunk {
                    Some(Ok(data)) => {
                        downloaded += data.len() as u64;

                        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &data).await {
                            let _ = tokio::fs::remove_file(&temp_path).await;
                            return fail(&app, &mut task, &format!("写入文件失败: {}", e)).await;
                        }

                        // Emit progress periodically
                        let elapsed = last_emit.elapsed();
                        if elapsed.as_millis() >= 200 {
                            last_emit = std::time::Instant::now();
                            let progress = if total_size > 0 {
                                (downloaded as f64 / total_size as f64) * 100.0
                            } else {
                                0.0
                            };
                            task.progress = progress.min(99.9);
                            task.downloaded_bytes = downloaded as i64;

                            let _ = app.emit("download:task-progress", &task);
                            store_task(&app, &task);
                        }
                    }
                    Some(Err(e)) => {
                        let _ = tokio::fs::remove_file(&temp_path).await;
                        return fail(&app, &mut task, &format!("下载错误: {}", e)).await;
                    }
                    None => {
                        // Stream completed – rename temp → final
                        drop(file);
                        if let Err(e) = tokio::fs::rename(&temp_path, &task.file_path).await {
                            return fail(&app, &mut task, &format!("重命名文件失败: {}", e)).await;
                        }

                        // Mark completed
                        task.status = "completed".into();
                        task.progress = 100.0;
                        task.downloaded_bytes = total_size as i64;
                        task.total_bytes = total_size as i64;
                        finalize_download_metadata(&mut task).await;
                        store_task(&app, &task);

                        let _ = app.emit("download:task-completed", &task);
                        let _ = app.emit("download:task-status-changed", &task);

                        cleanup(&app, &task_id);
                        wake_engine(&app);
                        return;
                    }
                }
            }
            _ = &mut cancel_rx => {
                // Paused or removed by a queue command.
                drop(file);
                let _ = tokio::fs::remove_file(&temp_path).await;
                let still_exists = app
                    .try_state::<Database>()
                    .and_then(|db| db.get_download_task(&task_id))
                    .is_some();
                if still_exists {
                    task.status = "paused".into();
                    task.progress = 0.0;
                    task.downloaded_bytes = 0;
                    store_task(&app, &task);
                    let _ = app.emit("download:task-status-changed", &task);
                }
                cleanup(&app, &task_id);
                wake_engine(&app);
                return;
            }
        }
    }
}

// ── Completion metadata ───────────────────────────────────────────────

async fn finalize_download_metadata(task: &mut DownloadTask) {
    let mut errors = Vec::new();

    if should_download_lyrics(&task.tag_write_options) {
        if let Some(lrc) = task.song_info.get("lrc").and_then(|value| value.as_str()) {
            if !lrc.trim().is_empty() {
                if let Err(error) = write_lyric_file(&task.file_path, lrc).await {
                    errors.push(error);
                }
            }
        }
    }

    if should_write_tags(&task.tag_write_options) {
        if let Err(error) = write_basic_tags(task).await {
            errors.push(error);
        }
    }

    task.metadata_error = if errors.is_empty() {
        None
    } else {
        Some(errors.join("; "))
    };
}

fn should_write_tags(options: &Value) -> bool {
    value_bool(options, "basicInfo")
        || value_bool(options, "lyrics")
        || value_bool(options, "cover")
}

fn should_download_lyrics(options: &Value) -> bool {
    value_bool(options, "downloadLyrics")
}

fn value_bool(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|item| item.as_bool())
        .unwrap_or(false)
}

async fn write_lyric_file(file_path: &str, lrc: &str) -> Result<(), String> {
    let path = std::path::Path::new(file_path);
    let lyric_path = path.with_extension("lrc");
    tokio::fs::write(&lyric_path, lrc)
        .await
        .map_err(|error| format!("歌词文件写入失败: {}", error))
}

fn first_song_text<'a>(song_info: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(text) = song_info.get(*key).and_then(|value| value.as_str()) {
            if !text.trim().is_empty() {
                return Some(text.trim());
            }
        }
    }
    None
}

fn cover_url(task: &DownloadTask) -> Option<&str> {
    if !task.cover.trim().is_empty() {
        return Some(task.cover.trim());
    }
    first_song_text(
        &task.song_info,
        &[
            "img",
            "picUrl",
            "pic_url",
            "coverImg",
            "coverImgUrl",
            "cover",
            "artwork",
            "image",
            "pic",
        ],
    )
}

fn cover_extension(url: &str, content_type: Option<&str>) -> &'static str {
    let lower_url = url.to_lowercase();
    if lower_url.contains(".png") {
        return "png";
    }
    if lower_url.contains(".webp") {
        return "webp";
    }
    if lower_url.contains(".bmp") {
        return "bmp";
    }
    if lower_url.contains(".jpg") || lower_url.contains(".jpeg") {
        return "jpg";
    }

    let content_type = content_type.unwrap_or_default().to_lowercase();
    if content_type.contains("image/png") {
        "png"
    } else if content_type.contains("image/webp") {
        "webp"
    } else if content_type.contains("image/bmp") {
        "bmp"
    } else {
        "jpg"
    }
}

async fn write_cover_temp_file(task: &DownloadTask) -> Result<Option<String>, String> {
    if !value_bool(&task.tag_write_options, "cover") {
        return Ok(None);
    }

    let Some(url) = cover_url(task) else {
        return Ok(None);
    };

    let (bytes, ext) = if url.starts_with("data:image/") {
        let Some((header, body)) = url.split_once(',') else {
            return Err("封面数据格式无效".into());
        };
        let ext = cover_extension(header, Some(header));
        let bytes = general_purpose::STANDARD
            .decode(body.as_bytes())
            .map_err(|error| format!("封面数据解码失败: {}", error))?;
        (bytes, ext)
    } else if url.starts_with("http://") || url.starts_with("https://") {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|error| format!("封面请求初始化失败: {}", error))?;
        let response = client
            .get(url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .send()
            .await
            .map_err(|error| format!("封面下载失败: {}", error))?;
        if !response.status().is_success() {
            return Err(format!("封面下载失败: HTTP {}", response.status().as_u16()));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let ext = cover_extension(url, content_type.as_deref());
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("封面读取失败: {}", error))?
            .to_vec();
        (bytes, ext)
    } else {
        return Ok(None);
    };

    if bytes.is_empty() {
        return Ok(None);
    }

    let temp_path =
        std::path::PathBuf::from(format!("{}.cover.{}.{}", task.file_path, task.task_id, ext));
    tokio::fs::write(&temp_path, bytes)
        .await
        .map_err(|error| format!("封面文件写入失败: {}", error))?;
    Ok(Some(temp_path.to_string_lossy().to_string()))
}

async fn write_basic_tags(task: &DownloadTask) -> Result<(), String> {
    let path = std::path::Path::new(&task.file_path);
    if !path.exists() {
        return Err("标签写入失败: 文件不存在".into());
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .unwrap_or_default();
    if ext == "wav" {
        return Ok(());
    }

    // 优先 ffmpeg：本机 exiftool 写不了 mp3/flac（"Writing not yet supported"），
    // ffmpeg 的 UTF-8 + 内嵌封面支持稳定。找不到 ffmpeg 才降级到下方 exiftool 兜底。
    if let Some(ffmpeg) = resolve_ffmpeg() {
        let title = first_song_text(&task.song_info, &["name"])
            .map(str::to_string)
            .or_else(|| Some(task.name.clone()))
            .unwrap_or_default();
        let artist = first_song_text(&task.song_info, &["singer"])
            .map(str::to_string)
            .or_else(|| Some(task.singer.clone()))
            .unwrap_or_default();
        let album = first_song_text(&task.song_info, &["albumName", "album_name"])
            .map(str::to_string)
            .unwrap_or_default();
        let year = task.song_info.get("year").and_then(|v| v.as_i64());
        let lyrics = first_song_text(&task.song_info, &["lrc"]).map(str::to_string).unwrap_or_default();
        let cover_temp = if value_bool(&task.tag_write_options, "cover") {
            write_cover_temp_file(task).await.ok().flatten()
        } else {
            None
        };
        let result = write_tags_with_ffmpeg(
            ffmpeg,
            task.file_path.clone(),
            value_bool(&task.tag_write_options, "basicInfo"),
            title,
            artist,
            album,
            year,
            value_bool(&task.tag_write_options, "lyrics"),
            lyrics,
            cover_temp.clone(),
        )
        .await;
        if let Some(p) = cover_temp {
            let _ = tokio::fs::remove_file(p).await;
        }
        return result;
    }

    let mut args = vec!["-overwrite_original".to_string()];
    let mut deferred_errors = Vec::new();
    let cover_temp_path = match write_cover_temp_file(task).await {
        Ok(path) => path,
        Err(error) => {
            deferred_errors.push(error);
            None
        }
    };
    if value_bool(&task.tag_write_options, "basicInfo") {
        push_exif_arg(
            &mut args,
            "Title",
            task.song_info
                .get("name")
                .and_then(|v| v.as_str())
                .or(Some(&task.name)),
        );
        push_exif_arg(
            &mut args,
            "Artist",
            task.song_info
                .get("singer")
                .and_then(|v| v.as_str())
                .or(Some(&task.singer)),
        );
        push_exif_arg(
            &mut args,
            "Album",
            task.song_info
                .get("albumName")
                .or_else(|| task.song_info.get("album_name"))
                .and_then(|v| v.as_str()),
        );
        if let Some(year) = task.song_info.get("year").and_then(|v| v.as_i64()) {
            args.push(format!("-Year={}", year));
        }
    }
    if value_bool(&task.tag_write_options, "lyrics") {
        push_exif_arg(
            &mut args,
            "Lyrics",
            task.song_info.get("lrc").and_then(|v| v.as_str()),
        );
    }
    if let Some(cover_path) = &cover_temp_path {
        args.push(format!("-Picture<={}", cover_path));
    }

    if args.len() == 1 {
        if let Some(cover_path) = cover_temp_path {
            let _ = tokio::fs::remove_file(cover_path).await;
        }
        if deferred_errors.is_empty() {
            return Ok(());
        }
        return Err(deferred_errors.join("; "));
    }
    args.push(task.file_path.clone());

    let output = tokio::task::spawn_blocking(move || {
        std::process::Command::new(resolve_exiftool()).args(&args).output()
    })
    .await
    .map_err(|error| format!("标签写入任务失败: {}", error))?
    .map_err(|error| format!("标签写入失败: {}", error))?;

    if let Some(cover_path) = cover_temp_path {
        let _ = tokio::fs::remove_file(cover_path).await;
    }

    if output.status.success() {
        if deferred_errors.is_empty() {
            Ok(())
        } else {
            Err(deferred_errors.join("; "))
        }
    } else {
        Err(format!(
            "标签写入失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn push_exif_arg(args: &mut Vec<String>, key: &str, value: Option<&str>) {
    if let Some(value) = value {
        if !value.trim().is_empty() {
            args.push(format!("-{}={}", key, value));
        }
    }
}

/// 解析 exiftool 可执行文件。GUI 应用从 Dock/Finder 启动时 PATH 往往不含
/// Homebrew 目录，直接 `Command::new("exiftool")` 会找不到；这里按常见安装位置
/// 兜底，最后再退回 PATH。
fn resolve_exiftool() -> String {
    for candidate in [
        "/opt/homebrew/bin/exiftool",
        "/usr/local/bin/exiftool",
        "/usr/bin/exiftool",
    ] {
        if std::path::Path::new(candidate).exists() {
            return candidate.to_string();
        }
    }
    "exiftool".to_string()
}

/// 解析 ffmpeg 可执行文件（写标签主工具）。本机 exiftool 实测
/// "Writing of MP3/FLAC files is not yet supported"（写不了音频标签），
/// 而 ffmpeg 对 UTF-8（中文歌名/歌词）与内嵌封面支持稳定，且 mp3/flac/m4a/wav/ogg
/// 都能 `-c copy` 只做标签 remux（不重编码、秒级完成）。找不到就返回 None，
/// 让调用方降级到 exiftool。
fn resolve_ffmpeg() -> Option<String> {
    for candidate in [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// 用 ffmpeg 写标签（basicInfo / 内嵌封面 / 内嵌歌词），`-c copy` 只 remux 不改音质。
/// 内嵌歌词落到 comment（ffmpeg 对各容器无统一 USLT 通道，多数播放器会展示；
/// 完整歌词由"单独下载歌词文件(.lrc)"承载，finalize 里已单独写文件）。
async fn write_tags_with_ffmpeg(
    ffmpeg: String,
    file_path: String,
    want_basic: bool,
    title: String,
    artist: String,
    album: String,
    year: Option<i64>,
    want_lyrics: bool,
    lyrics: String,
    cover: Option<String>,
) -> Result<(), String> {
    if !(want_basic || want_lyrics || cover.is_some()) {
        return Ok(());
    }
    let out_path = format!("{}.tagtmp.{}", file_path, uuid::Uuid::new_v4());
    let out = out_path.clone();
    let file = file_path.clone();
    let file_arg = file.clone();
    let out_arg = out.clone();
    let output = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new(ffmpeg);
        cmd.arg("-y")
            .arg("-hide_banner")
            .arg("-loglevel")
            .arg("error")
            .arg("-i")
            .arg(&file_arg);
        if let Some(c) = &cover {
            cmd.arg("-i").arg(c);
        }
        cmd.arg("-map").arg("0:a");
        if cover.is_some() {
            cmd.arg("-map")
                .arg("1")
                .arg("-disposition:v:0")
                .arg("attached_pic");
        }
        cmd.arg("-c").arg("copy");
        if want_basic {
            cmd.arg("-metadata").arg(format!("title={}", title));
            cmd.arg("-metadata").arg(format!("artist={}", artist));
            if !album.trim().is_empty() {
                cmd.arg("-metadata").arg(format!("album={}", album));
            }
            if let Some(y) = year {
                cmd.arg("-metadata").arg(format!("date={}", y));
            }
        }
        if want_lyrics && !lyrics.trim().is_empty() {
            cmd.arg("-metadata").arg(format!("comment={}", lyrics.trim()));
        }
        cmd.arg(&out_arg);
        cmd.output()
    })
    .await
    .map_err(|error| format!("标签写入任务失败: {}", error))?
    .map_err(|error| format!("ffmpeg 启动失败: {}", error))?;

    if output.status.success() {
        tokio::fs::rename(&out, &file)
            .await
            .map_err(|error| format!("标签写入失败: 替换文件失败: {}", error))
    } else {
        let _ = tokio::fs::remove_file(&out).await;
        Err(format!(
            "标签写入失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

/// 仅供"下载完成后补写元数据"使用：对一个已落盘的文件写入封面/基础信息/歌词，
/// 复用引擎自带的 `finalize_download_metadata`（内嵌封面用 exiftool、写 .lrc、写基础 tag）。
/// Node sidecar 下载引擎本身只负责把音频字节写到磁盘，标签写入统一走这里，
/// 让"下载标签写入设置"（基础信息/封面/标准歌词/逐字歌词）真正生效。
#[tauri::command]
pub async fn download_finalize_metadata(
    _app: AppHandle,
    args: Value,
) -> Result<Value, String> {
    let args = args;
    let file_path = args
        .get("filePath")
        .or_else(|| args.get("file_path"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if file_path.is_empty() {
        return Err("缺少文件路径".into());
    }
    if !std::path::Path::new(&file_path).exists() {
        return Ok(serde_json::json!({ "success": false, "skipped": true, "reason": "文件不存在" }));
    }

    let song_info = args
        .get("songInfo")
        .or_else(|| args.get("song_info"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let tag_write_options = args
        .get("tagWriteOptions")
        .or_else(|| args.get("tag_write_options"))
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));

    // 完全没勾任何标签选项就跳过（避免对 wav 等无意义地跑 exiftool）
    if !should_write_tags(&tag_write_options) && !should_download_lyrics(&tag_write_options) {
        return Ok(serde_json::json!({ "success": true, "skipped": true }));
    }

    let name = song_info.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let singer = song_info.get("singer").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let cover = song_info.get("img").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let songmid = song_info.get("songmid").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let now = chrono::Utc::now().to_rfc3339();

    let mut task = DownloadTask {
        task_id: uuid::Uuid::new_v4().to_string(),
        songmid,
        url: String::new(),
        file_path,
        status: "completed".into(),
        progress: 100.0,
        total_bytes: 0,
        downloaded_bytes: 0,
        name,
        singer,
        cover,
        error_message: None,
        retries: 0,
        created_at: now.clone(),
        updated_at: now,
        song_info,
        tag_write_options,
        plugin_id: None,
        quality: None,
        metadata_error: None,
    };

    finalize_download_metadata(&mut task).await;
    Ok(serde_json::json!({
        "success": task.metadata_error.is_none(),
        "error": task.metadata_error,
    }))
}

// ── Error handling with retries ───────────────────────────────────────

async fn fail(app: &AppHandle, task: &mut DownloadTask, msg: &str) {
    // Clean up temp if exists
    let temp = format!("{}.temp", task.file_path);
    let _ = tokio::fs::remove_file(&temp).await;

    let task_id = task.task_id.clone();
    // Read current retry count from DB
    let retries = if let Some(db) = app.try_state::<Database>() {
        let tasks = db.get_download_tasks();
        tasks
            .into_iter()
            .find(|t| t.task_id == task_id)
            .map(|t| t.retries)
            .unwrap_or(0)
    } else {
        0
    };

    if retries < 5 {
        task.status = "pending".into();
        task.error_message = Some(msg.to_string());
        task.retries = retries + 1;
        if let Some(db) = app.try_state::<Database>() {
            db.update_download_task_status(&task_id, "pending");
            let now = chrono::Utc::now().to_rfc3339();
            let conn = db.conn.lock().unwrap();
            let _ = conn.execute(
                "UPDATE download_tasks SET retries = retries + 1, error_message = ?1, updated_at = ?2 WHERE task_id = ?3",
                rusqlite::params![msg, now, task_id],
            );
        }
        let _ = app.emit("download:task-retrying", &*task);
        let _ = app.emit("download:task-status-changed", &*task);
    } else {
        // Final failure
        if let Some(db) = app.try_state::<Database>() {
            let now = chrono::Utc::now().to_rfc3339();
            let conn = db.conn.lock().unwrap();
            let _ = conn.execute(
                "UPDATE download_tasks SET status = 'error', error_message = ?1, updated_at = ?2 WHERE task_id = ?3",
                rusqlite::params![msg, now, task_id],
            );
        }
        task.status = "error".into();
        task.error_message = Some(msg.to_string());
        let _ = app.emit("download:task-error", &*task);
        let _ = app.emit("download:task-status-changed", &*task);
    }

    cleanup(app, &task_id);
    wake_engine(app);
}

// ── Helpers ───────────────────────────────────────────────────────────

fn store_task(app: &AppHandle, task: &DownloadTask) {
    if let Some(db) = app.try_state::<Database>() {
        let _ = db.upsert_download_task(task);
    }
}

fn cleanup(app: &AppHandle, task_id: &str) {
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.cancel_signals.lock().unwrap().remove(task_id);
    }
}

fn wake_engine(app: &AppHandle) {
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.wake();
    }
}
