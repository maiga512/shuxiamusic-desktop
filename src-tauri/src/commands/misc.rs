use crate::db::Database;
use crate::process_util;
use base64::Engine;
use chrono::TimeZone;
use std::path::Path;
use std::process::Child;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ==================== Music SDK / Search ====================

fn unwrap_invoke_args(args: serde_json::Value) -> serde_json::Value {
    args.get("args").cloned().unwrap_or(args)
}

/// Bridge for music provider search requests.
/// Receives `api` name ("search", "tipSearch", "searchPlaylist", "getPic", ...)
/// and `args` with source/keyword/page/limit etc.
#[tauri::command]
pub async fn music_sdk_request(
    app: tauri::AppHandle,
    api: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match api.as_str() {
        "search" => handle_search(args, false).await,
        "searchPlaylist" => handle_search(args, true).await,
        "tipSearch" => handle_tip_search(args).await,
        "getPic" => Ok(handle_get_pic(args)),
        "getSongUrl" => handle_get_song_url(args).await,
        "getMusicUrl" => handle_get_music_url(args).await,
        "getLyric" => handle_get_lyric(args).await,
        "getSongDetail" => handle_get_song_detail(args).await,
        "getPlaylistDetail" => handle_get_playlist_detail(args).await,
        "getPlaylistTags" => handle_get_playlist_tags(args).await,
        "getCategoryPlaylists" => handle_get_category_playlists(args).await,
        "getLeaderboards" => handle_get_leaderboards(args).await,
        "getLeaderboardDetail" => handle_get_leaderboard_detail(args).await,
        "getHotComment" => handle_get_hot_comment(args).await,
        "getComment" => handle_get_comment(args).await,
        "parsePlaylistId" => handle_parse_playlist_id(args),
        "getToplist" => handle_get_leaderboards(args).await,
        "getToplistDetail" => handle_get_leaderboard_detail(args).await,
        "getListSongs" => handle_get_playlist_detail(args).await,
        "downloadSingleSong" => handle_download_single_song(&app, args).await,
        "downloadBatchSongs" => handle_download_batch_songs(&app, args).await,
        _ => Ok(serde_json::json!({
            "result": { "songs": [], "songCount": 0 },
            "code": 200
        })),
    }
}

async fn handle_search(
    args: serde_json::Value,
    is_playlist: bool,
) -> Result<serde_json::Value, String> {
    let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("wy");
    let keyword = args.get("keyword").and_then(|v| v.as_str()).unwrap_or("");
    let page = args.get("page").and_then(|v| v.as_i64()).unwrap_or(1);
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(50);

    if keyword.is_empty() {
        return Ok(empty_search_result(is_playlist));
    }

    match source {
        "wy" => search_netease(keyword, page, limit, is_playlist).await,
        _ => {
            // Route to provider-specific implementations (kg, kw, mg, tx/qq)
            let result =
                crate::commands::music_search::dispatch_search(source, keyword, page, limit)
                    .await?;
            Ok(result)
        }
    }
}

pub(crate) async fn search_netease(
    keyword: &str,
    page: i64,
    limit: i64,
    is_playlist: bool,
) -> Result<serde_json::Value, String> {
    let offset = (page - 1) * limit;
    let search_type = if is_playlist { "1000" } else { "1" };

    let url = reqwest::Url::parse_with_params(
        "https://music.163.com/api/search/pc",
        &[
            ("s", keyword),
            ("type", search_type),
            ("offset", &offset.to_string()),
            ("limit", &limit.to_string()),
        ],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .get(url)
        .header("Referer", "https://music.163.com/")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    // NetEase returns:
    // - songs: { "result": { "songs": [...], "songCount": N }, "code": 200 }
    // - playlists: { "result": { "playlists": [...], "playlistCount": N }, "code": 200 }
    // UI expects normalized { "list": [...], "total": N }.
    let result = json
        .get("result")
        .cloned()
        .unwrap_or_else(|| empty_search_result(is_playlist));

    if is_playlist {
        let playlists: Vec<serde_json::Value> = result
            .get("playlists")
            .and_then(|v| v.as_array())
            .map(|items| items.iter().map(netease_playlist_card).collect())
            .unwrap_or_default();
        let total = result
            .get("playlistCount")
            .or_else(|| result.get("total"))
            .cloned()
            .unwrap_or(serde_json::json!(playlists.len()));
        return Ok(serde_json::json!({
            "list": playlists,
            "total": total,
            "page": page,
            "limit": limit,
            "source": "wy"
        }));
    }

    let songs: Vec<serde_json::Value> = result
        .get("songs")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter(|item| value_i64(item, &["id"]) != 0)
                .map(netease_search_song)
                .collect()
        })
        .unwrap_or_default();
    let song_count = result
        .get("songCount")
        .or_else(|| result.get("total"))
        .cloned()
        .unwrap_or(serde_json::json!(songs.len()));
    Ok(serde_json::json!({
        "list": songs,
        "total": song_count,
        "page": page,
        "limit": limit,
        "source": "wy"
    }))
}

fn empty_search_result(is_playlist: bool) -> serde_json::Value {
    if is_playlist {
        serde_json::json!({ "list": [], "playlists": [], "total": 0 })
    } else {
        serde_json::json!({ "list": [], "songs": [], "songCount": 0, "total": 0 })
    }
}

async fn handle_tip_search(args: serde_json::Value) -> Result<serde_json::Value, String> {
    let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("wy");
    let keyword = args.get("keyword").and_then(|v| v.as_str()).unwrap_or("");

    if keyword.is_empty() {
        return Ok(empty_tip_result());
    }

    match source {
        "wy" => tip_search_netease(keyword).await,
        _ => Ok(empty_tip_result()),
    }
}

async fn tip_search_netease(keyword: &str) -> Result<serde_json::Value, String> {
    let url = reqwest::Url::parse_with_params(
        "https://music.163.com/api/search/suggest/web",
        &[("s", keyword)],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .get(url)
        .header("Referer", "https://music.163.com/")
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    // NetEase returns { "result": { "songs": [...], "artists": [...], ... }, "code": 200 }
    let result = json.get("result").cloned().unwrap_or_else(empty_tip_result);
    Ok(result)
}

fn empty_tip_result() -> serde_json::Value {
    serde_json::json!({
        "songs": [],
        "artists": [],
        "albums": [],
        "playlists": [],
        "songCount": 0
    })
}

fn handle_get_pic(args: serde_json::Value) -> serde_json::Value {
    let song_info = args.get("songInfo");
    let empty_song = serde_json::Value::Null;
    let song = song_info.unwrap_or(&empty_song);
    let img = value_str(
        song,
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
    );

    if !img.is_empty() {
        return serde_json::json!({ "url": img });
    }

    for album_key in ["album", "al"] {
        if let Some(album) = song.get(album_key) {
            let album_img = value_str(album, &["picUrl", "cover", "coverImgUrl", "pic", "image"]);
            if !album_img.is_empty() {
                return serde_json::json!({ "url": album_img });
            }
        }
    }

    serde_json::json!({ "url": null })
}

#[tauri::command]
pub async fn music_resolve_playback_url(
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    handle_get_music_url(unwrap_invoke_args(args)).await
}

#[tauri::command]
pub fn music_resolve_cover(args: serde_json::Value) -> Result<serde_json::Value, String> {
    Ok(handle_get_pic(unwrap_invoke_args(args)))
}

#[tauri::command]
pub async fn music_get_comments(args: serde_json::Value) -> Result<serde_json::Value, String> {
    let args = unwrap_invoke_args(args);
    let kind = args
        .get("type")
        .or_else(|| args.get("commentType"))
        .and_then(|v| v.as_str())
        .unwrap_or("hot");
    if kind == "latest" || kind == "new" || kind == "comment" {
        handle_get_comment(args).await
    } else {
        handle_get_hot_comment(args).await
    }
}

#[tauri::command]
pub async fn music_get_lyric(args: serde_json::Value) -> Result<serde_json::Value, String> {
    handle_get_lyric(unwrap_invoke_args(args)).await
}

#[tauri::command]
pub async fn get_cover_proxy(song_id: String, origin_url: String) -> Result<String, String> {
    let _ = song_id;
    let url = origin_url.trim();
    if url.is_empty() {
        return Ok(String::new());
    }
    if url.starts_with("data:image/") {
        return Ok(url.to_string());
    }
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(String::new());
    }

    let client = proxy_http_client()?;
    let response = client
        .get(url)
        .header("User-Agent", default_media_user_agent())
        .header(
            "Accept",
            "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        )
        .send()
        .await
        .map_err(|error| format!("封面代理请求失败: {}", error))?;

    if !response.status().is_success() {
        return Ok(String::new());
    }

    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("封面代理读取失败: {}", error))?
        .to_vec();

    let Some(mime) = valid_image_mime(&bytes, content_type.as_deref()) else {
        return Ok(String::new());
    };
    if bytes.len() <= 512 {
        return Ok(String::new());
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
pub async fn get_lyric_proxy(
    song_id: String,
    args: Option<serde_json::Value>,
) -> Result<String, String> {
    let input = args.unwrap_or_default();
    let direct_text = value_str(&input, &["lyric", "lrc", "text", "raw", "originText"]);
    if is_valid_lyric_text(&direct_text) {
        return Ok(direct_text.to_string());
    }

    let mut request = input;
    if request.get("id").is_none() && !song_id.trim().is_empty() {
        if let Some(object) = request.as_object_mut() {
            object.insert("id".to_string(), serde_json::json!(song_id));
        } else {
            request = serde_json::json!({ "id": song_id });
        }
    }

    let result = handle_get_lyric(request)
        .await
        .unwrap_or_else(|_| empty_lyric_response());
    let lyric = first_valid_lyric_text(&result);
    if is_valid_lyric_text(&lyric) {
        Ok(lyric)
    } else {
        Ok(String::new())
    }
}

#[tauri::command]
pub async fn get_play_url_proxy(
    song_id: String,
    prefer_bit: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let input = args.unwrap_or_default();
    let mut last_error = String::new();
    for quality in quality_fallback_order(&prefer_bit) {
        let mut request = input.clone();
        if let Some(object) = request.as_object_mut() {
            object.insert("quality".to_string(), serde_json::json!(quality));
            object.insert("preferBit".to_string(), serde_json::json!(prefer_bit));
            if object.get("id").is_none() && !song_id.trim().is_empty() {
                object.insert("id".to_string(), serde_json::json!(song_id));
            }
        } else {
            request =
                serde_json::json!({ "id": song_id, "quality": quality, "preferBit": prefer_bit });
        }

        let resolved = handle_get_music_url(request).await.unwrap_or_else(|error| {
            last_error = error;
            serde_json::json!({ "url": null })
        });
        let url = proxy_extract_url(&resolved);
        if url.is_empty() {
            continue;
        }
        match validate_audio_url(&url).await {
            Ok(info) => {
                return Ok(serde_json::json!({
                    "url": url,
                    "quality": quality,
                    "actualQuality": quality,
                    "contentType": info.content_type,
                    "contentLength": info.content_length,
                    "streamable": true
                }));
            }
            Err(error) => last_error = error,
        }
    }

    Ok(serde_json::json!({
        "url": "",
        "error": if last_error.is_empty() { "暂无可用播放资源".to_string() } else { last_error }
    }))
}

#[tauri::command]
pub async fn get_download_source_proxy(
    song_id: String,
    prefer_bit: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    resolve_download_source_proxy(song_id, prefer_bit, args).await
}

#[tauri::command]
pub async fn get_download_source(
    song_id: String,
    target_bit: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    resolve_download_source_proxy(song_id, target_bit, args).await
}

async fn resolve_download_source_proxy(
    song_id: String,
    target_bit: String,
    args: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let input = args.unwrap_or_default();
    let mut last_error = String::new();
    for quality in quality_fallback_order(&target_bit) {
        let mut request = input.clone();
        if let Some(object) = request.as_object_mut() {
            object.insert("quality".to_string(), serde_json::json!(quality));
            object.insert("targetBit".to_string(), serde_json::json!(target_bit));
            if object.get("id").is_none() && !song_id.trim().is_empty() {
                object.insert("id".to_string(), serde_json::json!(song_id));
            }
        } else {
            request =
                serde_json::json!({ "id": song_id, "quality": quality, "targetBit": target_bit });
        }

        let resolved = handle_get_music_url(request).await.unwrap_or_else(|error| {
            last_error = error;
            serde_json::json!({ "url": null })
        });
        let url = proxy_extract_url(&resolved);
        if url.is_empty() {
            continue;
        }
        match validate_audio_url(&url).await {
            Ok(info) => {
                return Ok(serde_json::json!({
                    "url": url,
                    "quality": quality,
                    "actualQuality": quality,
                    "contentType": info.content_type,
                    "contentLength": info.content_length,
                    "size": info.content_length,
                    "streamable": true
                }));
            }
            Err(error) => last_error = error,
        }
    }

    Ok(serde_json::json!({
        "url": "",
        "error": if last_error.is_empty() { "暂无下载资源".to_string() } else { last_error }
    }))
}

struct AudioUrlInfo {
    content_type: String,
    content_length: Option<u64>,
}

fn default_media_user_agent() -> &'static str {
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}

fn proxy_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .timeout(std::time::Duration::from_secs(20))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|error| format!("HTTP 客户端创建失败: {}", error))
}

fn valid_image_mime(bytes: &[u8], content_type: Option<&str>) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x89, 0x50]) {
        return Some("image/png");
    }
    if bytes.starts_with(b"RIFF") || bytes.starts_with(&[0x52, 0x49]) {
        return Some("image/webp");
    }
    let content_type = content_type.unwrap_or_default().to_ascii_lowercase();
    if content_type.contains("image/jpeg") || content_type.contains("image/jpg") {
        Some("image/jpeg")
    } else if content_type.contains("image/png") {
        Some("image/png")
    } else if content_type.contains("image/webp") {
        Some("image/webp")
    } else {
        None
    }
}

fn is_valid_lyric_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed
        .split_whitespace()
        .collect::<String>()
        .chars()
        .count()
        <= 20
    {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("<html")
        || lower.contains("<!doctype")
        || lower.contains("<body")
        || lower.contains("404 not found")
        || lower.contains("access denied")
        || lower.contains("forbidden")
    {
        return false;
    }
    let visible = trimmed
        .chars()
        .filter(|ch| !ch.is_control() && !ch.is_whitespace())
        .count();
    if visible == 0 {
        return false;
    }
    let replacement = trimmed.chars().filter(|ch| *ch == '\u{FFFD}').count();
    replacement * 3 < visible
}

fn first_valid_lyric_text(value: &serde_json::Value) -> String {
    for key in ["lyric", "lrc", "crlyric", "tlyric", "rlyric", "text", "raw"] {
        let text = value_str(value, &[key]);
        if is_valid_lyric_text(&text) {
            return text.to_string();
        }
    }
    String::new()
}

fn quality_fallback_order(input: &str) -> Vec<&'static str> {
    let normalized = input.to_ascii_lowercase();
    let all = ["flac", "320k", "128k"];
    if normalized.contains("128") {
        vec!["128k"]
    } else if normalized.contains("320") {
        vec!["320k", "128k"]
    } else if normalized.contains("flac")
        || normalized.contains("lossless")
        || normalized.contains("无损")
        || normalized.contains("wav")
        || normalized.contains("ape")
    {
        all.to_vec()
    } else {
        vec!["320k", "128k"]
    }
}

fn proxy_extract_url(value: &serde_json::Value) -> String {
    if let Some(text) = value.as_str() {
        return text.trim().to_string();
    }
    value_str(
        value,
        &["url", "playUrl", "musicUrl", "src", "location", "body"],
    )
    .to_string()
}

fn is_audio_like_content_type(content_type: &str) -> bool {
    let lower = content_type.to_ascii_lowercase();
    lower.starts_with("audio/")
        || lower.contains("application/octet-stream")
        || lower.contains("application/x-mpegurl")
        || lower.contains("video/mp4")
}

fn looks_like_audio_header(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ID3")
        || bytes.starts_with(b"fLaC")
        || bytes.starts_with(b"OggS")
        || bytes.starts_with(b"RIFF")
        || bytes.starts_with(&[0xFF, 0xFB])
        || bytes.starts_with(&[0xFF, 0xF3])
        || bytes.starts_with(&[0xFF, 0xF2])
        || bytes.windows(8).any(|window| window == b"ftypM4A")
        || bytes.windows(8).any(|window| window == b"ftypmp42")
}

async fn validate_audio_url(url: &str) -> Result<AudioUrlInfo, String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("播放链接不是 HTTP 音频资源".to_string());
    }

    let client = proxy_http_client()?;
    let head = client
        .head(trimmed)
        .header("User-Agent", default_media_user_agent())
        .header("Accept", "*/*")
        .send()
        .await;

    let mut content_type = String::new();
    let mut content_length = None;
    if let Ok(response) = head {
        if !response.status().is_success() {
            return Err(format!(
                "音频链接 HEAD 失败: HTTP {}",
                response.status().as_u16()
            ));
        }
        content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        content_length = response.content_length();
    }

    let response = client
        .get(trimmed)
        .header("User-Agent", default_media_user_agent())
        .header("Accept", "*/*")
        .header("Range", "bytes=0-4095")
        .send()
        .await
        .map_err(|error| format!("音频链接流式读取失败: {}", error))?;
    if !(response.status().is_success() || response.status().as_u16() == 206) {
        return Err(format!(
            "音频链接读取失败: HTTP {}",
            response.status().as_u16()
        ));
    }
    if content_type.is_empty() {
        content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
    }
    if content_length.is_none() {
        content_length = response.content_length();
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("音频链接读取失败: {}", error))?
        .to_vec();
    if bytes.is_empty() {
        return Err("音频链接返回空内容".to_string());
    }
    if !is_audio_like_content_type(&content_type) && !looks_like_audio_header(&bytes) {
        return Err("音频链接不是有效音频资源".to_string());
    }

    Ok(AudioUrlInfo {
        content_type,
        content_length,
    })
}

// ==================== Music SDK: Song URL / Lyric / Detail ====================

async fn handle_get_song_url(args: serde_json::Value) -> Result<serde_json::Value, String> {
    let song_info = args.get("songInfo");
    let empty_song = serde_json::Value::Null;
    let song = song_info.unwrap_or(&empty_song);
    let source = source_alias(
        args.get("source")
            .and_then(|v| v.as_str())
            .or_else(|| song_info.and_then(|si| si.get("source").and_then(|v| v.as_str())))
            .unwrap_or("wy"),
    )
    .to_string();
    let quality = args
        .get("quality")
        .and_then(|v| v.as_str())
        .unwrap_or("128k");
    let id = args
        .get("id")
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let id = value_string(
                song,
                &["id", "songmid", "songId", "mid", "hash", "copyrightId"],
            );
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        })
        .unwrap_or_default();

    if let Some(url) = song_info_direct_url(song_info, quality)
        .or_else(|| args.get("url").and_then(string_url_from_value))
    {
        return Ok(serde_json::json!({ "url": url }));
    }

    if id.is_empty() {
        return Ok(serde_json::json!({ "url": null }));
    }

    let url = resolve_native_music_url(&source, song, &id, quality).await?;
    Ok(serde_json::json!({ "url": url }))
}

fn netease_bitrate(quality: &str) -> &'static str {
    match quality {
        "128k" => "128000",
        "192k" => "192000",
        "320k" => "320000",
        "flac" | "flac24bit" | "hires" | "master" => "999000",
        _ => "320000",
    }
}

async fn netease_get_song_url(song_id: &str, quality: &str) -> Result<serde_json::Value, String> {
    let br = netease_bitrate(quality);
    let url = reqwest::Url::parse_with_params(
        "https://music.163.com/api/song/enhance/player/url",
        &[("id", song_id), ("br", br)],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let resp = netease_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    let first = data.first().cloned().unwrap_or(serde_json::json!({}));
    let song_url = first.get("url").and_then(|u| u.as_str()).unwrap_or("");

    if song_url.is_empty() {
        return Ok(serde_json::json!({ "url": null }));
    }

    Ok(serde_json::json!({
        "url": song_url,
        "id": song_id,
        "name": "",
        "artist": "",
        "pic": "",
    }))
}

fn normalize_http_play_url(raw: &str) -> Option<String> {
    let url = raw.trim();
    if url.is_empty() || url.eq_ignore_ascii_case("null") || url == "-1" {
        return None;
    }
    if url.starts_with("//") {
        return Some(format!("https:{}", url));
    }
    if url.starts_with("http://") || url.starts_with("https://") {
        return Some(url.to_string());
    }
    None
}

fn play_url_from_value(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    if let Some(text) = value.as_str() {
        return normalize_http_play_url(text);
    }
    if let Some(items) = value.as_array() {
        for item in items {
            if let Some(url) = play_url_from_value(item, keys) {
                return Some(url);
            }
        }
        return None;
    }
    let Some(obj) = value.as_object() else {
        return None;
    };
    for key in keys {
        if let Some(child) = obj.get(*key) {
            if let Some(url) = play_url_from_value(child, keys) {
                return Some(url);
            }
        }
    }
    for child in obj.values() {
        if let Some(url) = play_url_from_value(child, keys) {
            return Some(url);
        }
    }
    None
}

fn kg_quality_hash(song: &serde_json::Value, quality: &str) -> String {
    song.get("_types")
        .and_then(|types| types.get(quality))
        .and_then(|item| item.get("hash"))
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| value_string(song, &["hash", "FileHash", "songmid", "id"]))
}

async fn kg_get_music_url(
    song: &serde_json::Value,
    quality: &str,
) -> Result<Option<String>, String> {
    let hash = kg_quality_hash(song, quality);
    if hash.is_empty() {
        return Ok(None);
    }
    let album_id = value_string(song, &["albumId", "AlbumID", "album_id"]);
    let urls = [
        format!(
            "https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash={}&album_id={}",
            url_encode(&hash),
            url_encode(&album_id)
        ),
        format!(
            "https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash={}",
            url_encode(&hash)
        ),
    ];

    for url in urls {
        let Ok(json) = sdk_get_json(&url, &[("Referer", "https://www.kugou.com/")]).await else {
            continue;
        };
        if let Some(url) = play_url_from_value(
            &json,
            &["play_url", "backup_url", "url", "audio_url", "playUrl"],
        ) {
            return Ok(Some(url));
        }
    }
    Ok(None)
}

fn kuwo_quality_format(quality: &str) -> &'static str {
    if quality.contains("flac") || quality == "hires" || quality == "master" {
        "flac"
    } else {
        "mp3"
    }
}

fn kuwo_quality_br(quality: &str) -> &'static str {
    if quality.contains("flac") || quality == "hires" || quality == "master" {
        "2000kflac"
    } else if quality == "128k" {
        "128kmp3"
    } else {
        "320kmp3"
    }
}

fn is_restricted_playback_text(input: &str) -> bool {
    let text = input.to_lowercase();
    [
        "当前歌曲仅在酷我",
        "最新版手机",
        "手机 app",
        "手机app",
        "手机端",
        "app播放",
        "app 播放",
    ]
    .iter()
    .any(|item| text.contains(&item.to_lowercase()))
}

async fn looks_like_audio_url(url: &str, headers: &[(&str, &str)]) -> bool {
    let Some(normalized) = normalize_http_play_url(url) else {
        return false;
    };
    if is_restricted_playback_text(&normalized) {
        return false;
    }

    let Ok(client) = sdk_client() else {
        return true;
    };

    let mut req = client.head(&normalized).header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    for (key, value) in headers {
        req = req.header(*key, *value);
    }

    let Ok(resp) = req.send().await else {
        return true;
    };
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 206 {
        return false;
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    if content_type.is_empty() {
        return true;
    }
    content_type.contains("audio")
        || content_type.contains("mpeg")
        || content_type.contains("mp3")
        || content_type.contains("flac")
        || content_type.contains("octet-stream")
}

async fn kw_accept_play_url(url: &str, headers: &[(&str, &str)]) -> Option<String> {
    let normalized = normalize_http_play_url(url)?;
    if looks_like_audio_url(&normalized, headers).await {
        Some(normalized)
    } else {
        None
    }
}

async fn kw_get_music_url(
    song: &serde_json::Value,
    id: &str,
    quality: &str,
) -> Result<Option<String>, String> {
    let raw_id = value_string(song, &["songmid", "id", "rid"]);
    let song_id = raw_id.trim_start_matches("MUSIC_").trim().to_string();
    let song_id = if song_id.is_empty() {
        id
    } else {
        song_id.as_str()
    };
    if song_id.is_empty() {
        return Ok(None);
    }

    let format = kuwo_quality_format(quality);
    let br = kuwo_quality_br(quality);
    let urls = [
        format!(
            "https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=MUSIC_{}&format={}&response=url",
            url_encode(song_id),
            format
        ),
        format!(
            "http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_{}&format={}&response=url",
            url_encode(song_id),
            format
        ),
        format!(
            "https://mobi.kuwo.cn/mobi.s?f=web&source=kwplayer_ar_5.1.0.0&type=convert_url_with_sign&rid={}&br={}",
            url_encode(song_id),
            br
        ),
    ];

    for url in urls {
        let headers = [("Referer", "http://www.kuwo.cn/")];
        let Ok(text) = sdk_get_text(&url, &headers).await else {
            continue;
        };
        if let Some(url) = kw_accept_play_url(&text, &headers).await {
            return Ok(Some(url));
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(url) = play_url_from_value(&json, &["url", "data", "path"]) {
                if let Some(accepted) = kw_accept_play_url(&url, &headers).await {
                    return Ok(Some(accepted));
                }
            }
        }
    }
    Ok(None)
}

fn mg_tone_flag(quality: &str) -> &'static str {
    match quality {
        "flac24bit" | "hires" | "master" => "ZQ",
        "flac" => "SQ",
        "320k" | "192k" => "HQ",
        _ => "PQ",
    }
}

async fn mg_get_music_url(
    song: &serde_json::Value,
    quality: &str,
) -> Result<Option<String>, String> {
    let tone = mg_tone_flag(quality);
    let mut ids = Vec::new();
    for key in ["copyrightId", "songmid", "id", "songId"] {
        let id = value_string(song, &[key]);
        if !id.is_empty() && !ids.contains(&id) {
            ids.push(id);
        }
    }

    for id in ids {
        let url = format!(
            "https://app.c.nf.migu.cn/MIGUM2.0/v2.0/content/listen-url?netType=00&resourceType=2&songId={}&toneFlag={}",
            url_encode(&id),
            tone
        );
        let Ok(json) = sdk_get_json(
            &url,
            &[
                ("Referer", "https://app.c.nf.migu.cn/"),
                ("channel", "0146921"),
            ],
        )
        .await
        else {
            continue;
        };
        if let Some(url) = play_url_from_value(
            &json,
            &[
                "url",
                "playUrl",
                "listenUrl",
                "resourceUrl",
                "androidUrl",
                "iosUrl",
            ],
        ) {
            return Ok(Some(url));
        }
    }
    Ok(None)
}

fn tx_filenames(media_mid: &str, quality: &str) -> Vec<String> {
    let mut result = Vec::new();
    match quality {
        "flac" | "flac24bit" | "hires" | "master" => {
            result.push(format!("F000{}.flac", media_mid));
            result.push(format!("M800{}.mp3", media_mid));
        }
        "128k" => {
            result.push(format!("M500{}.mp3", media_mid));
            result.push(format!("C400{}.m4a", media_mid));
        }
        _ => {
            result.push(format!("M800{}.mp3", media_mid));
            result.push(format!("M500{}.mp3", media_mid));
        }
    }
    result
}

async fn tx_get_music_url(
    song: &serde_json::Value,
    quality: &str,
) -> Result<Option<String>, String> {
    let song_mid = value_string(song, &["songmid_str", "mid", "songmid"]);
    let media_mid = value_string(
        song,
        &[
            "strMediaMid",
            "mediaMid",
            "media_mid",
            "songmid_str",
            "songmid",
        ],
    );
    if song_mid.is_empty() || media_mid.is_empty() {
        return Ok(None);
    }

    for filename in tx_filenames(&media_mid, quality) {
        let body = serde_json::json!({
            "comm": {
                "cv": 4747474,
                "ct": 24,
                "format": "json",
                "inCharset": "utf-8",
                "outCharset": "utf-8",
                "uin": 0
            },
            "req": {
                "module": "vkey.GetVkeyServer",
                "method": "CgiGetVkey",
                "param": {
                    "guid": "10000",
                    "songmid": [song_mid],
                    "songtype": [0],
                    "uin": "0",
                    "loginflag": 1,
                    "platform": "20",
                    "filename": [filename]
                }
            }
        });
        let Ok(json) = sdk_post_json(
            "https://u.y.qq.com/cgi-bin/musicu.fcg",
            body,
            &[("Referer", "https://y.qq.com/")],
        )
        .await
        else {
            continue;
        };
        let Some(info) = json.pointer("/req/data/midurlinfo/0") else {
            continue;
        };
        let purl = value_str(info, &["purl", "pUrl"]);
        if purl.is_empty() {
            continue;
        }
        if let Some(url) = normalize_http_play_url(purl) {
            return Ok(Some(url));
        }
        let base = json
            .pointer("/req/data/sip/0")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("https://isure.stream.qqmusic.qq.com/");
        return Ok(Some(format!("{}{}", base, purl)));
    }
    Ok(None)
}

async fn resolve_native_music_url(
    source: &str,
    song: &serde_json::Value,
    id: &str,
    quality: &str,
) -> Result<Option<String>, String> {
    match source_alias(source) {
        "wy" => {
            let result = netease_get_song_url(id, quality).await?;
            Ok(result
                .get("url")
                .and_then(|v| v.as_str())
                .map(|v| v.to_string()))
        }
        "kg" => kg_get_music_url(song, quality).await,
        "kw" => kw_get_music_url(song, id, quality).await,
        "mg" => mg_get_music_url(song, quality).await,
        "tx" => tx_get_music_url(song, quality).await,
        _ => Ok(None),
    }
}

/// Frontend-facing `getMusicUrl` handler.
/// Accepts `source`, `songInfo` (full song object), `quality`.
/// Returns URL string on success, or `{ error: "..." }` on failure.
async fn handle_get_music_url(args: serde_json::Value) -> Result<serde_json::Value, String> {
    let song_info = args.get("songInfo");
    let empty_song = serde_json::Value::Null;
    let song = song_info.unwrap_or(&empty_song);
    let source = source_alias(
        args.get("source")
            .and_then(|v| v.as_str())
            .or_else(|| song_info.and_then(|si| si.get("source").and_then(|v| v.as_str())))
            .unwrap_or("wy"),
    )
    .to_string();

    let id = args
        .get("id")
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let id = value_string(
                song,
                &["id", "songmid", "songId", "mid", "hash", "copyrightId"],
            );
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        })
        .unwrap_or_default();

    let quality = args
        .get("quality")
        .and_then(|v| v.as_str())
        .unwrap_or("128k");

    if let Some(url) = song_info_direct_url(song_info, quality)
        .or_else(|| args.get("url").and_then(string_url_from_value))
    {
        return Ok(serde_json::json!(url));
    }

    if id.is_empty() {
        return Ok(serde_json::json!({
            "error": "无法获取歌曲 ID"
        }));
    }

    match resolve_native_music_url(&source, song, &id, quality).await? {
        Some(url) => Ok(serde_json::json!(url)),
        None => Ok(serde_json::json!({
            "error": format!("音源 {} 暂未返回可播放链接", source)
        })),
    }
}

async fn handle_get_lyric(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_lyric_response(&args) {
        return Ok(existing);
    }

    let song_info = args.get("songInfo");
    let empty_song = serde_json::Value::Null;
    let song = song_info.unwrap_or(&empty_song);
    let source = args
        .get("source")
        .and_then(|v| v.as_str())
        .or_else(|| song_info.and_then(|si| si.get("source").and_then(|v| v.as_str())))
        .unwrap_or("wy");

    let id = args
        .get("id")
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .or_else(|| {
            let id = value_string(
                song,
                &["id", "songmid", "songId", "mid", "hash", "copyrightId"],
            );
            if id.is_empty() {
                None
            } else {
                Some(id)
            }
        })
        .unwrap_or_default();

    if id.is_empty() {
        return Ok(empty_lyric_response());
    }

    match source_alias(source) {
        "wy" => netease_get_lyric(&id)
            .await
            .or_else(|_| Ok(empty_lyric_response())),
        "tx" => tx_get_lyric(song, &id)
            .await
            .or_else(|_| Ok(empty_lyric_response())),
        "kw" => kw_get_lyric(song, &id)
            .await
            .or_else(|_| Ok(empty_lyric_response())),
        "kg" => kg_get_lyric(song)
            .await
            .or_else(|_| Ok(empty_lyric_response())),
        "mg" => mg_get_lyric(song, &id)
            .await
            .or_else(|_| Ok(empty_lyric_response())),
        _ => Ok(empty_lyric_response()),
    }
}

fn lyric_response(
    lyric: String,
    tlyric: String,
    rlyric: String,
    crlyric: String,
) -> serde_json::Value {
    serde_json::json!({
        "lyric": lyric,
        "tlyric": tlyric,
        "rlyric": rlyric,
        "crlyric": crlyric
    })
}

fn empty_lyric_response() -> serde_json::Value {
    lyric_response(String::new(), String::new(), String::new(), String::new())
}

fn decode_base64_text(input: &str) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    base64::engine::general_purpose::STANDARD
        .decode(input.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn decode_lyric_text(input: &str) -> String {
    let normalized = decode_basic_html(input)
        .replace("\\r\\n", "\n")
        .replace("\\n", "\n")
        .replace("&#10;", "\n")
        .replace("&#13;", "");

    if normalized.contains('[') || normalized.contains('\n') || normalized.contains('<') {
        return normalized;
    }

    decode_base64_text(input)
        .map(|text| decode_basic_html(&text))
        .unwrap_or(normalized)
}

fn duration_text_to_seconds(text: &str) -> i64 {
    let mut total = 0_i64;
    for part in text.split(':') {
        let seconds = part
            .split('.')
            .next()
            .unwrap_or("0")
            .parse::<i64>()
            .unwrap_or(0);
        total = total.saturating_mul(60).saturating_add(seconds);
    }
    total
}

pub(crate) async fn netease_get_lyric(song_id: &str) -> Result<serde_json::Value, String> {
    let url = reqwest::Url::parse_with_params(
        "https://music.163.com/api/song/lyric",
        &[("id", song_id), ("lv", "1"), ("kv", "1"), ("tv", "-1")],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let resp = netease_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    Ok(lyric_response(
        json.get("lrc")
            .and_then(|v| v.get("lyric"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        json.get("tlyric")
            .and_then(|v| v.get("lyric"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        json.get("romalrc")
            .and_then(|v| v.get("lyric"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        json.get("klyric")
            .and_then(|v| v.get("lyric"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    ))
}

async fn tx_get_lyric(
    song_info: &serde_json::Value,
    id: &str,
) -> Result<serde_json::Value, String> {
    let songmid = value_string(song_info, &["songmid", "mid"]);
    let query_id = if songmid.is_empty() {
        id
    } else {
        songmid.as_str()
    };
    let url = format!(
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?format=json&nobase64=1&songmid={}&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq&needNewCode=0",
        url_encode(query_id)
    );
    let raw = sdk_get_json(&url, &[("Referer", "https://y.qq.com/")]).await?;
    let lyric = decode_lyric_text(value_str(&raw, &["lyric"]));
    let tlyric = decode_lyric_text(value_str(&raw, &["trans"]));
    Ok(lyric_response(lyric, tlyric, String::new(), String::new()))
}

async fn kw_get_lyric(
    song_info: &serde_json::Value,
    id: &str,
) -> Result<serde_json::Value, String> {
    let song_id = value_string(song_info, &["songmid", "id"])
        .trim_start_matches("MUSIC_")
        .to_string();
    let query_id = if song_id.is_empty() {
        id
    } else {
        song_id.as_str()
    };
    let url = format!(
        "http://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId={}",
        url_encode(query_id)
    );
    let raw = sdk_get_json(&url, &[("Referer", "http://m.kuwo.cn/")]).await?;
    let lines = raw
        .pointer("/data/lrclist")
        .or_else(|| raw.get("lrclist"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let time = value_str(item, &["time"]);
                    let text = value_str(item, &["lineLyric", "text"]);
                    if time.is_empty() {
                        None
                    } else {
                        Some(format!("[{}]{}", time, text))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    Ok(lyric_response(
        lines,
        String::new(),
        String::new(),
        String::new(),
    ))
}

async fn kg_get_lyric(song_info: &serde_json::Value) -> Result<serde_json::Value, String> {
    let name = value_str(song_info, &["name"]);
    let hash = value_string(song_info, &["hash", "FileHash", "songmid"]);
    if name.is_empty() || hash.is_empty() {
        return Ok(empty_lyric_response());
    }
    let duration = duration_text_to_seconds(value_str(song_info, &["interval"]));
    let search_url = format!(
        "http://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword={}&hash={}&timelength={}&lrctxt=1",
        url_encode(name),
        url_encode(&hash),
        duration
    );
    let search = sdk_get_json(&search_url, &[]).await?;
    let Some(candidate) = search
        .get("candidates")
        .and_then(|v| v.as_array())
        .and_then(|items| items.first())
    else {
        return Ok(empty_lyric_response());
    };
    let id = value_string(candidate, &["id"]);
    let access_key = value_string(candidate, &["accesskey", "accessKey"]);
    if id.is_empty() || access_key.is_empty() {
        return Ok(empty_lyric_response());
    }
    let lyric_url = format!(
        "http://lyrics.kugou.com/download?ver=1&client=pc&id={}&accesskey={}&fmt=lrc&charset=utf8",
        url_encode(&id),
        url_encode(&access_key)
    );
    let raw = sdk_get_json(&lyric_url, &[]).await?;
    let lyric = decode_base64_text(value_str(&raw, &["content"])).unwrap_or_default();
    Ok(lyric_response(
        lyric,
        String::new(),
        String::new(),
        String::new(),
    ))
}

async fn mg_get_lyric(
    song_info: &serde_json::Value,
    id: &str,
) -> Result<serde_json::Value, String> {
    let lrc_url = value_str(song_info, &["lrcUrl"]);
    if !lrc_url.is_empty() {
        let lyric = sdk_get_text(lrc_url, &[("Referer", "https://app.c.nf.migu.cn/")]).await?;
        return Ok(lyric_response(
            lyric,
            String::new(),
            String::new(),
            String::new(),
        ));
    }

    let copyright_id = value_string(song_info, &["copyrightId", "songmid", "id"]);
    let query_id = if copyright_id.is_empty() {
        id
    } else {
        copyright_id.as_str()
    };
    if query_id.is_empty() {
        return Ok(empty_lyric_response());
    }
    let url = format!(
        "https://music.migu.cn/v3/api/music/audioPlayer/getLyric?copyrightId={}",
        url_encode(query_id)
    );
    let raw = sdk_get_json(
        &url,
        &[(
            "Referer",
            "https://music.migu.cn/v3/music/player/audio?from=migu",
        )],
    )
    .await?;
    Ok(lyric_response(
        value_str(&raw, &["lyric"]).to_string(),
        String::new(),
        String::new(),
        String::new(),
    ))
}

async fn handle_get_song_detail(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_song_detail_response(&args) {
        return Ok(existing);
    }

    let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("wy");
    // Accept both "ids" (array) and "id" (single string) from args
    let ids: Vec<String> = args
        .get("ids")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    v.as_str()
                        .map(|s| s.to_string())
                        .or_else(|| v.as_i64().map(|n| n.to_string()))
                })
                .collect()
        })
        .unwrap_or_else(|| {
            args.get("id")
                .and_then(|v| v.as_str())
                .map(|s| vec![s.to_string()])
                .unwrap_or_default()
        });

    if ids.is_empty() {
        return Ok(serde_json::json!({ "songs": [] }));
    }

    match source {
        "wy" => netease_get_song_detail(&ids)
            .await
            .or_else(|_| Ok(serde_json::json!({ "songs": [], "code": 200 }))),
        _ => Ok(serde_json::json!({ "songs": [], "code": 200 })),
    }
}

async fn netease_get_song_detail(song_ids: &[String]) -> Result<serde_json::Value, String> {
    // NetEase v3 API accepts a JSON-encoded array in the "c" param
    let c_param: Vec<serde_json::Value> = song_ids
        .iter()
        .map(|id| serde_json::json!({ "id": id }))
        .collect();
    let c_str = serde_json::to_string(&c_param).unwrap_or_default();

    let url = reqwest::Url::parse_with_params(
        "https://music.163.com/api/v3/song/detail",
        &[("c", &c_str)],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let resp = netease_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    Ok(json)
}

/// Shared reqwest Client for NetEase API calls.
pub(crate) fn netease_client() -> reqwest::Client {
    let mut builder = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15));
    // Set default headers
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::REFERER,
        reqwest::header::HeaderValue::from_static("https://music.163.com/"),
    );
    headers.insert(
        reqwest::header::USER_AGENT,
        reqwest::header::HeaderValue::from_static(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ),
    );
    builder = builder.default_headers(headers);
    builder.build().unwrap_or_default()
}

// ==================== Music SDK: Provider Content Helpers ====================

fn sdk_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))
}

async fn sdk_get_text(url: &str, headers: &[(&str, &str)]) -> Result<String, String> {
    let client = sdk_client()?;
    let mut req = client.get(url).header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    for (key, value) in headers {
        req = req.header(*key, *value);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    resp.text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))
}

async fn sdk_get_json(url: &str, headers: &[(&str, &str)]) -> Result<serde_json::Value, String> {
    let text = sdk_get_text(url, headers).await?;
    serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))
}

async fn sdk_post_json(
    url: &str,
    body: serde_json::Value,
    headers: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    let client = sdk_client()?;
    let mut req = client.post(url).json(&body).header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );
    for (key, value) in headers {
        req = req.header(*key, *value);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))
}

fn source_alias(source: &str) -> &str {
    match source {
        "qq" => "tx",
        other => other,
    }
}

fn string_url_from_value(value: &serde_json::Value) -> Option<String> {
    let url = value.as_str()?.trim();
    if url.is_empty() {
        return None;
    }
    Some(url.to_string())
}

fn song_info_direct_url(song_info: Option<&serde_json::Value>, quality: &str) -> Option<String> {
    let song = song_info?;
    song.get("typeUrl")
        .and_then(|type_url| type_url.get(quality))
        .and_then(string_url_from_value)
        .or_else(|| {
            song.get("type_url")
                .and_then(|type_url| type_url.get(quality))
                .and_then(string_url_from_value)
        })
        .or_else(|| song.get("url").and_then(string_url_from_value))
        .or_else(|| song.get("musicUrl").and_then(string_url_from_value))
        .or_else(|| song.get("playUrl").and_then(string_url_from_value))
        .or_else(|| song.get("src").and_then(string_url_from_value))
}

fn value_str<'a>(value: &'a serde_json::Value, keys: &[&str]) -> &'a str {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return text;
            }
        }
    }
    ""
}

fn value_i64(value: &serde_json::Value, keys: &[&str]) -> i64 {
    for key in keys {
        if let Some(num) = value.get(*key).and_then(|v| v.as_i64()) {
            return num;
        }
        if let Some(text) = value.get(*key).and_then(|v| v.as_str()) {
            if let Ok(num) = text.parse::<i64>() {
                return num;
            }
        }
    }
    0
}

fn format_duration(seconds: i64) -> String {
    let total = seconds.max(0);
    format!("{:02}:{:02}", total / 60, total % 60)
}

fn format_play_count(count: i64) -> serde_json::Value {
    if count >= 100_000_000 {
        serde_json::json!(format!("{:.1}亿", count as f64 / 100_000_000.0))
    } else if count >= 10_000 {
        serde_json::json!(format!("{:.1}万", count as f64 / 10_000.0))
    } else {
        serde_json::json!(count)
    }
}

fn url_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn singer_names(list: Option<&Vec<serde_json::Value>>, key: &str) -> String {
    list.map(|items| {
        items
            .iter()
            .filter_map(|item| item.get(key).and_then(|v| v.as_str()))
            .filter(|name| !name.is_empty())
            .collect::<Vec<_>>()
            .join("、")
    })
    .unwrap_or_default()
}

fn format_media_size(bytes: i64) -> serde_json::Value {
    if bytes <= 0 {
        return serde_json::Value::Null;
    }
    let value = bytes as f64;
    let kb = 1024.0;
    let mb = kb * 1024.0;
    let gb = mb * 1024.0;
    let text = if value >= gb {
        format!("{:.2}GB", value / gb)
    } else if value >= mb {
        format!("{:.2}MB", value / mb)
    } else if value >= kb {
        format!("{:.2}KB", value / kb)
    } else {
        format!("{}B", bytes)
    };
    serde_json::json!(text)
}

fn push_quality_type(
    types: &mut Vec<serde_json::Value>,
    type_map: &mut serde_json::Map<String, serde_json::Value>,
    quality: &str,
    size: serde_json::Value,
) {
    types.push(serde_json::json!({ "type": quality, "size": size.clone() }));
    type_map.insert(quality.to_string(), serde_json::json!({ "size": size }));
}

fn netease_quality_types(
    item: &serde_json::Value,
    privilege: Option<&serde_json::Value>,
) -> (Vec<serde_json::Value>, serde_json::Value) {
    let mut types = Vec::new();
    let mut type_map = serde_json::Map::new();
    let maxbr = privilege.map(|p| value_i64(p, &["maxbr"])).unwrap_or(0);
    let max_br_level = privilege
        .map(|p| value_str(p, &["maxBrLevel"]))
        .unwrap_or("");

    if max_br_level == "hires" {
        let size = item
            .get("hr")
            .and_then(|v| scalar_i64(v.get("size")))
            .map(format_media_size)
            .unwrap_or(serde_json::Value::Null);
        push_quality_type(&mut types, &mut type_map, "hires", size);
    }
    if maxbr >= 999_000 {
        let size = item
            .get("sq")
            .and_then(|v| scalar_i64(v.get("size")))
            .map(format_media_size)
            .unwrap_or(serde_json::Value::Null);
        push_quality_type(&mut types, &mut type_map, "flac", size);
    }
    if maxbr >= 320_000 {
        let size = item
            .get("h")
            .and_then(|v| scalar_i64(v.get("size")))
            .map(format_media_size)
            .unwrap_or(serde_json::Value::Null);
        push_quality_type(&mut types, &mut type_map, "320k", size);
    }
    if maxbr >= 128_000 {
        let size = item
            .get("l")
            .and_then(|v| scalar_i64(v.get("size")))
            .map(format_media_size)
            .unwrap_or(serde_json::Value::Null);
        push_quality_type(&mut types, &mut type_map, "128k", size);
    }

    types.reverse();
    (types, serde_json::Value::Object(type_map))
}

fn netease_search_song(item: &serde_json::Value) -> serde_json::Value {
    let album = item
        .get("al")
        .or_else(|| item.get("album"))
        .cloned()
        .unwrap_or_default();
    let singer = singer_names(
        item.get("ar")
            .or_else(|| item.get("artists"))
            .and_then(|v| v.as_array()),
        "name",
    );
    let duration_ms = value_i64(item, &["dt", "duration"]);
    let duration = if duration_ms > 1000 {
        duration_ms / 1000
    } else {
        duration_ms
    };
    let pic_url = value_str(&album, &["picUrl", "img1v1Url"]);
    let (types, type_map) = netease_quality_types(item, None);

    serde_json::json!({
        "singer": singer,
        "name": value_str(item, &["name"]),
        "albumName": value_str(&album, &["name"]),
        "albumId": value_i64(&album, &["id"]),
        "source": "wy",
        "interval": format_duration(duration),
        "songmid": value_i64(item, &["id"]),
        "img": pic_url,
        "lrc": null,
        "otherSource": null,
        "types": types,
        "_types": type_map,
        "typeUrl": {}
    })
}

fn netease_playlist_card(item: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "play_count": format_play_count(value_i64(item, &["playCount", "playcount"])),
        "id": value_string(item, &["id"]),
        "author": scalar_str(item.pointer("/creator/nickname")),
        "name": value_str(item, &["name"]),
        "time": item.get("createTime").map(value_to_string).unwrap_or_default(),
        "img": value_str(item, &["coverImgUrl", "coverImgUrlStr"]),
        "grade": value_i64(item, &["grade"]),
        "total": value_i64(item, &["trackCount", "bookCount"]),
        "desc": value_str(item, &["description"]),
        "source": "wy"
    })
}

fn netease_song(
    item: &serde_json::Value,
    privilege: Option<&serde_json::Value>,
) -> serde_json::Value {
    let album = item.get("al").cloned().unwrap_or_default();
    let pc = item.get("pc");
    let singer = pc
        .and_then(|p| p.get("ar"))
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| singer_names(item.get("ar").and_then(|v| v.as_array()), "name"));
    let name = pc
        .and_then(|p| p.get("sn"))
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| value_str(item, &["name"]).to_string());
    let album_name = pc
        .and_then(|p| p.get("alb"))
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| value_str(&album, &["name"]).to_string());
    let (types, type_map) = netease_quality_types(item, privilege);

    serde_json::json!({
        "singer": singer,
        "name": name,
        "albumName": album_name,
        "albumId": value_i64(&album, &["id"]),
        "source": "wy",
        "interval": format_duration(value_i64(item, &["dt"]) / 1000),
        "songmid": value_i64(item, &["id"]),
        "img": value_str(&album, &["picUrl"]),
        "lrc": null,
        "otherSource": null,
        "types": types,
        "_types": type_map,
        "typeUrl": {}
    })
}

fn normalize_netease_playlist_songs(
    tracks: &serde_json::Value,
    privileges: Option<&serde_json::Value>,
) -> Vec<serde_json::Value> {
    let empty_privileges = Vec::new();
    let privilege_list = privileges
        .and_then(|v| v.as_array())
        .unwrap_or(&empty_privileges);

    tracks
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = value_i64(item, &["id"]);
                    let privilege = privilege_list
                        .iter()
                        .find(|p| value_i64(p, &["id"]) == id)
                        .or_else(|| {
                            privilege_list.get(
                                items
                                    .iter()
                                    .position(|current| value_i64(current, &["id"]) == id)
                                    .unwrap_or(usize::MAX),
                            )
                        });
                    if id == 0 || privilege.is_none() {
                        return None;
                    }
                    Some(netease_song(item, privilege))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn tx_song(item: &serde_json::Value) -> serde_json::Value {
    let album = item.get("album").cloned().unwrap_or_default();
    let album_mid = value_str(&album, &["mid"]);
    let album_name = value_str(&album, &["name"]);
    let singer_list = item.get("singer").and_then(|v| v.as_array());
    let singer = singer_names(singer_list, "name");
    let singer_mid = singer_list
        .and_then(|items| items.first())
        .and_then(|item| item.get("mid").and_then(|v| v.as_str()))
        .unwrap_or("");
    let file = item.get("file").cloned().unwrap_or_default();
    let img = if !album_mid.is_empty() && album_name != "空" {
        format!(
            "https://y.gtimg.cn/music/photo_new/T002R500x500M000{}.jpg",
            album_mid
        )
    } else if !singer_mid.is_empty() {
        format!(
            "https://y.gtimg.cn/music/photo_new/T001R500x500M000{}.jpg",
            singer_mid
        )
    } else {
        String::new()
    };

    serde_json::json!({
        "singer": singer,
        "name": value_str(item, &["title", "name"]),
        "albumName": album_name,
        "albumId": value_i64(&album, &["id"]),
        "albumMid": album_mid,
        "source": "tx",
        "interval": format_duration(value_i64(item, &["interval"])),
        "songId": value_i64(item, &["id"]),
        "songmid": value_str(item, &["mid"]),
        "strMediaMid": value_str(&file, &["media_mid"]),
        "img": img,
        "lrc": null,
        "otherSource": null,
        "types": [],
        "_types": {},
        "typeUrl": {}
    })
}

fn parse_kuwo_quality(minfo: &str) -> (Vec<serde_json::Value>, serde_json::Value) {
    let mut types = Vec::new();
    let mut type_map = serde_json::Map::new();
    for part in minfo.split(';') {
        let mut bitrate = "";
        let mut size = "";
        for kv in part.split(',') {
            let mut pair = kv.splitn(2, ':');
            match (pair.next(), pair.next()) {
                (Some("bitrate"), Some(v)) => bitrate = v,
                (Some("size"), Some(v)) => size = v,
                _ => {}
            }
        }
        let type_name = match bitrate {
            "20900" => "master",
            "20501" => "atmos_plus",
            "20201" => "atmos",
            "4000" => "hires",
            "2000" => "flac",
            "320" => "320k",
            "128" => "128k",
            _ => continue,
        };
        let size_text = size.to_uppercase();
        types.push(serde_json::json!({ "type": type_name, "size": size_text }));
        type_map.insert(
            type_name.to_string(),
            serde_json::json!({ "size": size_text }),
        );
    }
    types.reverse();
    (types, serde_json::Value::Object(type_map))
}

fn kw_song(item: &serde_json::Value) -> serde_json::Value {
    let minfo = value_str(item, &["N_MINFO", "n_minfo"]);
    let (types, type_map) = parse_kuwo_quality(minfo);
    serde_json::json!({
        "singer": value_str(item, &["artist", "ARTIST"]),
        "name": value_str(item, &["name", "SONGNAME"]),
        "albumName": value_str(item, &["album", "ALBUM"]),
        "albumId": value_str(item, &["albumid", "albumId", "ALBUMID"]),
        "songmid": value_str(item, &["id", "MUSICRID"]).trim_start_matches("MUSIC_"),
        "source": "kw",
        "interval": format_duration(value_i64(item, &["duration", "DURATION"])),
        "img": value_str(item, &["pic", "albumPic"]),
        "lrc": null,
        "otherSource": null,
        "types": types,
        "_types": type_map,
        "typeUrl": {}
    })
}

fn kg_song(item: &serde_json::Value) -> serde_json::Value {
    let filename = value_str(item, &["filename"]);
    let mut singer = value_str(item, &["singername", "author_name"]).to_string();
    let mut name = value_str(item, &["songname", "ori_audio_name"]).to_string();
    if name.is_empty() && filename.contains(" - ") {
        let mut parts = filename.splitn(2, " - ");
        singer = parts.next().unwrap_or("").to_string();
        name = parts.next().unwrap_or("").to_string();
    }
    let hash = value_str(item, &["hash", "FileHash"]).to_string();
    let songmid = value_str(item, &["audio_id", "audioid", "Audioid"]);
    serde_json::json!({
        "singer": singer,
        "name": name,
        "albumName": value_str(item, &["album_name", "remark"]),
        "albumId": value_i64(item, &["album_id"]),
        "songmid": if songmid.is_empty() { hash.clone() } else { songmid.to_string() },
        "source": "kg",
        "interval": format_duration(value_i64(item, &["duration"])),
        "img": null,
        "lrc": null,
        "hash": hash,
        "otherSource": null,
        "types": [],
        "_types": {},
        "typeUrl": {}
    })
}

fn mg_song(item: &serde_json::Value) -> serde_json::Value {
    let singer = if let Some(text) = item.get("singerList").and_then(|v| v.as_str()) {
        text.to_string()
    } else {
        singer_names(item.get("singerList").and_then(|v| v.as_array()), "name")
    };
    let mut img = value_str(item, &["img3", "img2", "img1"]).to_string();
    if img.starts_with('/') {
        img = format!("https://d.musicapp.migu.cn{}", img);
    }
    serde_json::json!({
        "singer": singer,
        "name": value_str(item, &["songName", "name"]),
        "albumName": value_str(item, &["album"]),
        "albumId": value_str(item, &["albumId"]),
        "songmid": value_str(item, &["songId"]),
        "copyrightId": value_str(item, &["copyrightId"]),
        "source": "mg",
        "interval": format_duration(value_i64(item, &["duration"])),
        "img": img,
        "lrc": null,
        "lrcUrl": value_str(item, &["lrcUrl"]),
        "mrcUrl": value_str(item, &["mrcUrl"]),
        "trcUrl": value_str(item, &["trcUrl"]),
        "otherSource": null,
        "types": [],
        "_types": {},
        "typeUrl": {}
    })
}

fn collect_mg_playlists(contents: &[serde_json::Value], list: &mut Vec<serde_json::Value>) {
    for item in contents {
        if let Some(children) = item.get("contents").and_then(|v| v.as_array()) {
            collect_mg_playlists(children, list);
            continue;
        }
        let is_playlist =
            value_str(item, &["resType"]) == "2021" || value_i64(item, &["resType"]) == 2021;
        if !is_playlist {
            continue;
        }
        list.push(serde_json::json!({
            "id": value_str(item, &["resId"]),
            "author": "",
            "name": value_str(item, &["txt"]),
            "img": value_str(item, &["img"]),
            "desc": value_str(item, &["txt2"]),
            "source": "mg"
        }));
    }
}

// ==================== Music SDK: Playlist / Leaderboard / Comment APIs ====================

fn empty_playlist_detail() -> serde_json::Value {
    serde_json::json!({ "list": [], "total": 0, "limit": 0, "page": 1 })
}

fn empty_playlist_tags() -> serde_json::Value {
    serde_json::json!({ "tags": [], "hotTag": [] })
}

fn empty_comment_response(source: &str, page: i64, limit: i64) -> serde_json::Value {
    serde_json::json!({
        "source": source,
        "comments": [],
        "total": 0,
        "page": page.max(1),
        "limit": limit.max(1),
        "maxPage": 1
    })
}

fn value_at<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    if path.starts_with('/') {
        value.pointer(path)
    } else {
        value.get(path)
    }
}

fn array_at(value: &serde_json::Value, paths: &[&str]) -> Option<Vec<serde_json::Value>> {
    for path in paths {
        if let Some(array) = value_at(value, path).and_then(|v| v.as_array()) {
            if !array.is_empty() {
                return Some(array.clone());
            }
        }
    }

    value.as_array().and_then(|array| {
        if array.is_empty() {
            None
        } else {
            Some(array.clone())
        }
    })
}

fn object_at(value: &serde_json::Value, paths: &[&str]) -> Option<serde_json::Value> {
    for path in paths {
        if let Some(child) = value_at(value, path) {
            if child
                .as_object()
                .map(|map| !map.is_empty())
                .unwrap_or(false)
            {
                return Some(child.clone());
            }
        }
    }
    None
}

fn numeric_at(value: &serde_json::Value, paths: &[&str], fallback: i64) -> i64 {
    for path in paths {
        if let Some(number) = scalar_i64(value_at(value, path)) {
            return number;
        }
    }
    fallback
}

fn existing_song_detail_response(args: &serde_json::Value) -> Option<serde_json::Value> {
    if let Some(songs) = array_at(
        args,
        &[
            "songs",
            "list",
            "tracks",
            "songList",
            "/data/songs",
            "/data/list",
            "/data/tracks",
            "/result/songs",
            "/playlist/tracks",
        ],
    ) {
        return Some(serde_json::json!({ "songs": songs, "code": 200 }));
    }

    object_at(
        args,
        &[
            "songInfo",
            "song",
            "musicInfo",
            "/data/song",
            "/result/song",
        ],
    )
    .map(|song| serde_json::json!({ "songs": [song], "code": 200 }))
}

fn existing_playlist_detail_response(args: &serde_json::Value) -> Option<serde_json::Value> {
    let list = array_at(
        args,
        &[
            "list",
            "songs",
            "tracks",
            "songList",
            "/data/list",
            "/data/songs",
            "/data/tracks",
            "/playlist/tracks",
            "/playlist/list",
            "/result/tracks",
            "/result/songs",
        ],
    )?;
    let len = list.len() as i64;
    let total = numeric_at(
        args,
        &[
            "total",
            "songCount",
            "trackCount",
            "/data/total",
            "/data/songCount",
            "/playlist/trackCount",
            "/result/songCount",
        ],
        len,
    );
    let limit = arg_i64(args, "limit", len);
    let page = arg_i64(args, "page", 1).max(1);
    let info = object_at(
        args,
        &[
            "info",
            "playlist",
            "songListInfo",
            "/data/info",
            "/data/playlist",
            "/result/playlist",
        ],
    )
    .unwrap_or_else(|| serde_json::json!({}));

    Some(serde_json::json!({
        "list": list,
        "total": total,
        "limit": limit,
        "page": page,
        "source": arg_source(args),
        "info": info,
    }))
}

fn existing_playlist_tags_response(args: &serde_json::Value) -> Option<serde_json::Value> {
    let tags = array_at(args, &["tags", "/data/tags", "/result/tags"])?;
    let hot_tag = array_at(
        args,
        &[
            "hotTag",
            "hotTags",
            "/data/hotTag",
            "/data/hotTags",
            "/result/hotTag",
        ],
    )
    .unwrap_or_default();
    Some(serde_json::json!({ "tags": tags, "hotTag": hot_tag, "source": arg_source(args) }))
}

fn existing_category_playlists_response(args: &serde_json::Value) -> Option<serde_json::Value> {
    let list = array_at(
        args,
        &[
            "list",
            "playlists",
            "/data/list",
            "/data/playlists",
            "/result/playlists",
        ],
    )?;
    let len = list.len() as i64;
    let total = numeric_at(
        args,
        &[
            "total",
            "playlistCount",
            "/data/total",
            "/result/playlistCount",
        ],
        len,
    );
    Some(serde_json::json!({
        "list": list,
        "total": total,
        "page": arg_i64(args, "page", 1).max(1),
        "limit": arg_i64(args, "limit", len),
        "source": arg_source(args),
    }))
}

fn existing_leaderboards_response(args: &serde_json::Value) -> Option<serde_json::Value> {
    array_at(
        args,
        &[
            "list",
            "boards",
            "toplist",
            "toplists",
            "/data/list",
            "/data/topList",
            "/result/list",
        ],
    )
    .map(serde_json::Value::Array)
}

fn existing_comment_response(args: &serde_json::Value, hot: bool) -> Option<serde_json::Value> {
    let comments = if hot {
        array_at(
            args,
            &[
                "comments",
                "hotComments",
                "/data/comments",
                "/data/hotComments",
                "/result/comments",
                "/result/hotComments",
            ],
        )?
    } else {
        array_at(args, &["comments", "/data/comments", "/result/comments"])?
    };
    let total = numeric_at(
        args,
        &[
            "total",
            "totalCount",
            "/data/total",
            "/data/totalCount",
            "/result/total",
        ],
        comments.len() as i64,
    );
    let limit = arg_i64(args, "limit", comments.len() as i64).max(1);
    let page = arg_i64(args, "page", 1).max(1);
    Some(serde_json::json!({
        "source": arg_source(args),
        "comments": normalize_comments(&comments),
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": max_page(total, limit),
    }))
}

fn max_page(total: i64, limit: i64) -> i64 {
    if total <= 0 {
        1
    } else {
        (total + limit.max(1) - 1) / limit.max(1)
    }
}

fn format_comment_time(timestamp: i64) -> String {
    if timestamp <= 0 {
        return String::new();
    }
    let seconds = if timestamp > 10_000_000_000 {
        timestamp / 1000
    } else {
        timestamp
    };
    chrono::Local
        .timestamp_opt(seconds, 0)
        .single()
        .map(|time| time.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

fn normalize_comment(item: &serde_json::Value) -> serde_json::Value {
    let id = value_string(item, &["id", "commentId", "comment_id"]);
    let time = value_i64(item, &["time", "timeMs", "createdAt", "time_stamp"]);
    let empty_user = serde_json::Value::Null;
    let user = item.get("user").unwrap_or(&empty_user);
    let images = array_at(item, &["images", "pics", "pictures"])
        .unwrap_or_default()
        .into_iter()
        .filter_map(|image| {
            if image.is_string() {
                return Some(image);
            }
            let url = value_string(&image, &["url", "picUrl", "originUrl"]);
            if url.is_empty() {
                None
            } else {
                Some(serde_json::json!(url))
            }
        })
        .collect::<Vec<_>>();
    let reply = array_at(item, &["reply", "replies", "beReplied"])
        .unwrap_or_default()
        .iter()
        .map(|reply| normalize_comment(reply))
        .collect::<Vec<_>>();
    let text = value_string(item, &["text", "content", "msg"]);
    let time_str = value_string(item, &["timeStr", "timeText"]);
    let time_str = if time_str.is_empty() {
        format_comment_time(time)
    } else {
        time_str
    };
    let location = item
        .pointer("/ipLocation/location")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string())
        .unwrap_or_else(|| value_string(item, &["location", "ipLocation"]));
    let user_name = value_string(user, &["nickname", "name", "userName"]);
    let user_name = if user_name.is_empty() {
        value_string(item, &["userName", "nickname"])
    } else {
        user_name
    };
    let avatar = value_string(user, &["avatarUrl", "avatar", "picUrl"]);
    let avatar = if avatar.is_empty() {
        value_string(item, &["avatar", "avatarUrl"])
    } else {
        avatar
    };
    let user_id = value_string(user, &["userId", "id", "uid"]);
    let user_id = if user_id.is_empty() {
        value_string(item, &["userId", "uid"])
    } else {
        user_id
    };

    serde_json::json!({
        "id": id,
        "text": text,
        "time": time,
        "timeStr": time_str,
        "location": location,
        "userName": user_name,
        "avatar": avatar,
        "userId": user_id,
        "likedCount": value_i64(item, &["likedCount", "likeCount", "liked_count"]),
        "images": images,
        "reply": reply,
    })
}

fn normalize_comments(comments: &[serde_json::Value]) -> Vec<serde_json::Value> {
    comments.iter().map(normalize_comment).collect()
}

fn lyric_text_at(value: &serde_json::Value, paths: &[&str]) -> String {
    for path in paths {
        if let Some(text) = value_at(value, path).and_then(|v| v.as_str()) {
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn existing_lyric_response(args: &serde_json::Value) -> Option<serde_json::Value> {
    let song = args.get("songInfo").unwrap_or(args);
    let lyric = lyric_text_at(
        song,
        &[
            "lyric",
            "lrc",
            "/lrc/lyric",
            "/data/lyric",
            "/data/lrc/lyric",
        ],
    );
    let tlyric = lyric_text_at(
        song,
        &[
            "tlyric",
            "transLyric",
            "/tlyric/lyric",
            "/data/tlyric",
            "/data/tlyric/lyric",
        ],
    );
    let rlyric = lyric_text_at(song, &["rlyric", "romalrc", "/romalrc/lyric"]);
    let crlyric = lyric_text_at(song, &["crlyric", "klyric", "/klyric/lyric"]);

    if lyric.is_empty() && tlyric.is_empty() && rlyric.is_empty() && crlyric.is_empty() {
        None
    } else {
        Some(lyric_response(lyric, tlyric, rlyric, crlyric))
    }
}

fn arg_source(args: &serde_json::Value) -> &str {
    source_alias(args.get("source").and_then(|v| v.as_str()).unwrap_or("wy"))
}

fn arg_string(args: &serde_json::Value, key: &str, default: &str) -> String {
    args.get(key)
        .map(value_to_string)
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_string())
}

fn arg_i64(args: &serde_json::Value, key: &str, default: i64) -> i64 {
    scalar_i64(args.get(key)).unwrap_or(default)
}

fn value_to_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn value_string(value: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(child) = value.get(*key) {
            let text = value_to_string(child);
            if !text.is_empty() {
                return text;
            }
        }
    }
    String::new()
}

fn scalar_i64(value: Option<&serde_json::Value>) -> Option<i64> {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_i64().or_else(|| n.as_u64().map(|v| v as i64)),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn scalar_str<'a>(value: Option<&'a serde_json::Value>) -> &'a str {
    value.and_then(|v| v.as_str()).unwrap_or("")
}

fn decode_basic_html(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
}

fn normalize_image_url(url: &str) -> String {
    if url.contains("{size}") {
        return url.replace("{size}", "512");
    }
    if url.starts_with("//") {
        return format!("https:{}", url);
    }
    if url.starts_with('/') {
        return format!("https://d.musicapp.migu.cn{}", url);
    }
    url.to_string()
}

fn parse_data_id_tags(html: &str, source: &str) -> Vec<serde_json::Value> {
    let mut list = Vec::new();
    for chunk in html.split("data-id=\"").skip(1) {
        let Some(id) = chunk.split('"').next() else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let Some(after_gt) = chunk.split_once('>') else {
            continue;
        };
        let name = after_gt.1.split('<').next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        list.push(serde_json::json!({
            "id": id,
            "name": decode_basic_html(name),
            "source": source,
        }));
    }
    list
}

fn extract_numeric_id(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    if input.chars().all(|c| c.is_ascii_digit()) {
        return input.to_string();
    }
    if let Some(id) = input.split("playlistId=").nth(1) {
        return id.split(&['&', '#'][..]).next().unwrap_or("").to_string();
    }
    if let Some(id) = input.split("id=").nth(1) {
        return id.split(&['&', '#'][..]).next().unwrap_or("").to_string();
    }
    for part in input.split(&['/', '-', '?', '&', '#'][..]).rev() {
        if !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()) {
            return part.to_string();
        }
    }
    input.trim_start_matches("id_").to_string()
}

fn extract_kg_global_data(html: &str) -> Vec<serde_json::Value> {
    let marker = "global.data = ";
    let Some(start) = html.find(marker) else {
        return Vec::new();
    };
    let after = &html[start + marker.len()..];
    let Some(end) = after.find("];") else {
        return Vec::new();
    };
    let data = &after[..end + 1];
    serde_json::from_str::<Vec<serde_json::Value>>(data).unwrap_or_default()
}

fn tx_static_boards() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "id": "tx__4", "name": "流行指数榜", "bangid": "4", "source": "tx" }),
        serde_json::json!({ "id": "tx__26", "name": "热歌榜", "bangid": "26", "source": "tx" }),
        serde_json::json!({ "id": "tx__27", "name": "新歌榜", "bangid": "27", "source": "tx" }),
        serde_json::json!({ "id": "tx__62", "name": "飙升榜", "bangid": "62", "source": "tx" }),
        serde_json::json!({ "id": "tx__28", "name": "网络歌曲榜", "bangid": "28", "source": "tx" }),
        serde_json::json!({ "id": "tx__5", "name": "内地榜", "bangid": "5", "source": "tx" }),
        serde_json::json!({ "id": "tx__3", "name": "欧美榜", "bangid": "3", "source": "tx" }),
        serde_json::json!({ "id": "tx__16", "name": "韩国榜", "bangid": "16", "source": "tx" }),
    ]
}

fn kw_static_boards() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "id": "kw__93", "name": "飙升榜", "bangid": "93", "source": "kw" }),
        serde_json::json!({ "id": "kw__17", "name": "新歌榜", "bangid": "17", "source": "kw" }),
        serde_json::json!({ "id": "kw__16", "name": "热歌榜", "bangid": "16", "source": "kw" }),
        serde_json::json!({ "id": "kw__158", "name": "抖音热歌榜", "bangid": "158", "source": "kw" }),
        serde_json::json!({ "id": "kw__104", "name": "华语榜", "bangid": "104", "source": "kw" }),
        serde_json::json!({ "id": "kw__22", "name": "欧美榜", "bangid": "22", "source": "kw" }),
        serde_json::json!({ "id": "kw__184", "name": "韩语榜", "bangid": "184", "source": "kw" }),
        serde_json::json!({ "id": "kw__183", "name": "日语榜", "bangid": "183", "source": "kw" }),
    ]
}

fn kg_static_boards() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "id": "kg__8888", "name": "TOP500", "bangid": "8888", "source": "kg" }),
        serde_json::json!({ "id": "kg__6666", "name": "飙升榜", "bangid": "6666", "source": "kg" }),
        serde_json::json!({ "id": "kg__59703", "name": "蜂鸟流行音乐榜", "bangid": "59703", "source": "kg" }),
        serde_json::json!({ "id": "kg__52144", "name": "抖音热歌榜", "bangid": "52144", "source": "kg" }),
        serde_json::json!({ "id": "kg__24971", "name": "DJ热歌榜", "bangid": "24971", "source": "kg" }),
        serde_json::json!({ "id": "kg__31308", "name": "内地榜", "bangid": "31308", "source": "kg" }),
        serde_json::json!({ "id": "kg__31310", "name": "欧美榜", "bangid": "31310", "source": "kg" }),
        serde_json::json!({ "id": "kg__31312", "name": "日本榜", "bangid": "31312", "source": "kg" }),
    ]
}

fn mg_static_boards() -> Vec<serde_json::Value> {
    vec![
        serde_json::json!({ "id": "mg__27553319", "name": "新歌榜", "bangid": "27553319", "source": "mg" }),
        serde_json::json!({ "id": "mg__27186466", "name": "热歌榜", "bangid": "27186466", "source": "mg" }),
        serde_json::json!({ "id": "mg__27553408", "name": "原创榜", "bangid": "27553408", "source": "mg" }),
        serde_json::json!({ "id": "mg__75959118", "name": "音乐风向榜", "bangid": "75959118", "source": "mg" }),
        serde_json::json!({ "id": "mg__76557036", "name": "彩铃分贝榜", "bangid": "76557036", "source": "mg" }),
        serde_json::json!({ "id": "mg__23189800", "name": "港台榜", "bangid": "23189800", "source": "mg" }),
        serde_json::json!({ "id": "mg__23189399", "name": "内地榜", "bangid": "23189399", "source": "mg" }),
        serde_json::json!({ "id": "mg__19190036", "name": "欧美榜", "bangid": "19190036", "source": "mg" }),
    ]
}

/// Get playlist detail by ID.
async fn handle_get_playlist_detail(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_playlist_detail_response(&args) {
        return Ok(existing);
    }

    let source = arg_source(&args);
    let id = args
        .get("id")
        .map(value_to_string)
        .or_else(|| {
            args.get("ids")
                .and_then(|v| v.as_array())
                .and_then(|arr| arr.first())
                .map(value_to_string)
        })
        .unwrap_or_default();
    let page = arg_i64(&args, "page", 1).max(1);

    if id.is_empty() {
        return Ok(empty_playlist_detail());
    }

    let result = match source {
        "wy" => {
            let url = format!("https://music.163.com/api/v3/playlist/detail?id={}", id);
            let raw = netease_get_json(&url).await?;
            let playlist = raw.get("playlist");
            let tracks = playlist
                .and_then(|p| p.get("tracks"))
                .cloned()
                .unwrap_or(serde_json::json!([]));
            let privileges = raw.get("privileges");
            let songs = normalize_netease_playlist_songs(&tracks, privileges);
            let track_count = playlist
                .and_then(|p| p.get("trackCount"))
                .cloned()
                .unwrap_or(serde_json::json!(songs.len()));
            let limit = songs.len() as i64;
            let info = serde_json::json!({
                "name": playlist.and_then(|p| p.get("name")).cloned().unwrap_or(serde_json::Value::Null),
                "author": playlist.and_then(|p| p.get("creator")).and_then(|c| c.get("nickname")).cloned().unwrap_or(serde_json::Value::Null),
                "img": playlist.and_then(|p| p.get("coverImgUrl")).cloned().unwrap_or(serde_json::Value::Null),
                "desc": playlist.and_then(|p| p.get("description")).cloned().unwrap_or(serde_json::Value::Null),
                "total": track_count,
            });
            Ok(serde_json::json!({
                "list": songs,
                "total": track_count,
                "limit": limit,
                "page": 1,
                "source": "wy",
                "info": info,
            }))
        }
        "tx" => tx_playlist_detail(&id).await,
        "kw" => kw_playlist_detail(&id, page).await,
        "kg" => kg_playlist_detail(&id, page).await,
        "mg" => mg_playlist_detail(&id, page).await,
        _ => Ok(empty_playlist_detail()),
    };

    result.or_else(|_| Ok(empty_playlist_detail()))
}

async fn tx_playlist_detail(id: &str) -> Result<serde_json::Value, String> {
    let id = extract_numeric_id(id);
    if id.is_empty() {
        return Ok(empty_playlist_detail());
    }
    let url = format!("https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid={}&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0", id);
    let referer = format!("https://y.qq.com/n/yqq/playsquare/{}.html", id);
    let headers = [
        ("Origin", "https://y.qq.com"),
        ("Referer", referer.as_str()),
    ];
    let raw = sdk_get_json(&url, &headers).await?;
    let Some(cdlist) = raw
        .get("cdlist")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
    else {
        return Ok(empty_playlist_detail());
    };
    let songs: Vec<serde_json::Value> = cdlist
        .get("songlist")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(tx_song).collect())
        .unwrap_or_default();
    let total = songs.len() as i64;
    Ok(serde_json::json!({
        "list": songs,
        "page": 1,
        "limit": total,
        "total": total,
        "source": "tx",
        "info": {
            "name": value_str(cdlist, &["dissname"]),
            "img": value_str(cdlist, &["logo"]),
            "desc": decode_basic_html(value_str(cdlist, &["desc"])),
            "author": value_str(cdlist, &["nickname"]),
            "play_count": format_play_count(value_i64(cdlist, &["visitnum"])),
            "meta": { "playlistId": id }
        }
    }))
}

async fn kw_playlist_detail(id: &str, page: i64) -> Result<serde_json::Value, String> {
    let mut digest = "8".to_string();
    let mut list_id = id.to_string();
    if list_id.contains("playlist") {
        list_id = extract_numeric_id(&list_id);
    } else if list_id.starts_with("digest-") {
        let parts: Vec<&str> = list_id.split("__").collect();
        if parts.len() == 2 {
            digest = parts[0].trim_start_matches("digest-").to_string();
            list_id = parts[1].to_string();
        }
    }
    if list_id.is_empty() {
        return Ok(empty_playlist_detail());
    }
    if digest == "5" {
        let info_url = format!("http://qukudata.kuwo.cn/q.k?op=query&cont=ninfo&node={}&pn=0&rn=1&fmt=json&src=mbox&level=2", list_id);
        if let Ok(info) = sdk_get_json(&info_url, &[]).await {
            if let Some(source_id) = info
                .pointer("/child/0/sourceid")
                .map(value_to_string)
                .filter(|v| !v.is_empty())
            {
                list_id = source_id;
            }
        }
    }
    let url = format!("http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid={}&pn={}&rn=1000&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1", list_id, page - 1);
    let raw = sdk_get_json(&url, &[]).await?;
    let songs: Vec<serde_json::Value> = raw
        .get("musiclist")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(kw_song).collect())
        .unwrap_or_default();
    let total = scalar_i64(raw.get("total")).unwrap_or(songs.len() as i64);
    Ok(serde_json::json!({
        "list": songs,
        "page": page,
        "limit": scalar_i64(raw.get("rn")).unwrap_or(1000),
        "total": total,
        "source": "kw",
        "info": {
            "name": value_str(&raw, &["title"]),
            "img": value_str(&raw, &["pic"]),
            "desc": value_str(&raw, &["info"]),
            "author": value_str(&raw, &["uname"]),
            "play_count": format_play_count(value_i64(&raw, &["playnum"])),
            "meta": { "playlistId": list_id }
        }
    }))
}

async fn kg_playlist_detail(id: &str, page: i64) -> Result<serde_json::Value, String> {
    let list_id = extract_numeric_id(id.trim_start_matches("id_"));
    if list_id.is_empty() {
        return Ok(empty_playlist_detail());
    }
    let url = format!(
        "http://www2.kugou.kugou.com/yueku/v9/special/single/{}-5-9999.html",
        list_id
    );
    let html = sdk_get_text(&url, &[]).await?;
    let raw_list = extract_kg_global_data(&html);
    let songs: Vec<serde_json::Value> = raw_list.iter().map(kg_song).collect();
    let total = songs.len() as i64;
    Ok(serde_json::json!({
        "list": songs,
        "page": page,
        "limit": 10000,
        "total": total,
        "source": "kg",
        "info": {
            "name": "",
            "img": "",
            "desc": "",
            "author": "",
            "meta": { "playlistId": list_id }
        }
    }))
}

async fn mg_playlist_detail(id: &str, page: i64) -> Result<serde_json::Value, String> {
    let list_id = extract_numeric_id(id);
    if list_id.is_empty() {
        return Ok(empty_playlist_detail());
    }
    let headers = [
        ("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"),
        ("Referer", "https://m.music.migu.cn/"),
    ];
    let list_url = format!("https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?pageNo={}&pageSize=50&playlistId={}", page, list_id);
    let raw = sdk_get_json(&list_url, &headers).await?;
    let songs: Vec<serde_json::Value> = raw
        .pointer("/data/songList")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(mg_song).collect())
        .unwrap_or_default();
    let total = scalar_i64(raw.pointer("/data/totalCount")).unwrap_or(songs.len() as i64);
    let info_url = format!(
        "https://c.musicapp.migu.cn/MIGUM3.0/resource/playlist/v2.0?playlistId={}",
        list_id
    );
    let info_raw = sdk_get_json(&info_url, &headers).await.unwrap_or_default();
    Ok(serde_json::json!({
        "list": songs,
        "page": page,
        "limit": 50,
        "total": total,
        "source": "mg",
        "info": {
            "name": scalar_str(info_raw.pointer("/data/title")),
            "img": normalize_image_url(scalar_str(info_raw.pointer("/data/imgItem/img"))),
            "desc": scalar_str(info_raw.pointer("/data/summary")),
            "author": scalar_str(info_raw.pointer("/data/ownerName")),
            "play_count": format_play_count(scalar_i64(info_raw.pointer("/data/opNumItem/playNum")).unwrap_or(0)),
            "meta": { "playlistId": list_id }
        }
    }))
}

/// Get playlist tags/catalogue.
async fn handle_get_playlist_tags(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_playlist_tags_response(&args) {
        return Ok(existing);
    }

    let result = match arg_source(&args) {
        "wy" => {
            let url = "https://music.163.com/api/playlist/catalogue";
            let raw = netease_get_json(url).await?;
            let sub = raw.get("sub").cloned().unwrap_or(serde_json::json!([]));
            let hot_tag = raw
                .get("sub")
                .and_then(|s| s.as_array())
                .map(|arr| arr.iter().take(12).cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            Ok(serde_json::json!({ "tags": sub, "hotTag": hot_tag, "source": "wy" }))
        }
        "tx" => tx_playlist_tags().await,
        "kw" => kw_playlist_tags().await,
        "kg" => kg_playlist_tags().await,
        "mg" => mg_playlist_tags().await,
        _ => Ok(empty_playlist_tags()),
    };

    result.or_else(|_| Ok(empty_playlist_tags()))
}

async fn tx_playlist_tags() -> Result<serde_json::Value, String> {
    let tags_url = "https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data=%7B%22tags%22%3A%7B%22method%22%3A%22get_all_categories%22%2C%22param%22%3A%7B%22qq%22%3A%22%22%7D%2C%22module%22%3A%22playlist.PlaylistAllCategoriesServer%22%7D%7D";
    let raw = sdk_get_json(tags_url, &[]).await?;
    let mut tags = Vec::new();
    if let Some(groups) = raw.pointer("/tags/data/v_group").and_then(|v| v.as_array()) {
        for group in groups {
            let mut list = Vec::new();
            if let Some(items) = group.get("v_item").and_then(|v| v.as_array()) {
                for item in items {
                    list.push(serde_json::json!({
                        "parent_id": value_i64(group, &["group_id"]),
                        "parent_name": value_str(group, &["group_name"]),
                        "id": value_i64(item, &["id"]),
                        "name": value_str(item, &["name"]),
                        "source": "tx"
                    }));
                }
            }
            tags.push(
                serde_json::json!({ "name": value_str(group, &["group_name"]), "list": list }),
            );
        }
    }
    let hot_tag = match sdk_get_text(
        "https://c.y.qq.com/node/pc/wk_v15/category_playlist.html",
        &[],
    )
    .await
    {
        Ok(html) => parse_data_id_tags(&html, "tx"),
        Err(_) => Vec::new(),
    };
    Ok(serde_json::json!({ "tags": tags, "hotTag": hot_tag, "source": "tx" }))
}

async fn kw_playlist_tags() -> Result<serde_json::Value, String> {
    let raw = sdk_get_json("http://wapi.kuwo.cn/api/pc/classify/playlist/getTagList?cmd=rcm_keyword_playlist&user=0&prod=kwplayer_pc_9.0.5.0&vipver=9.0.5.0&source=kwplayer_pc_9.0.5.0&loginUid=0&loginSid=0&appUid=76039576", &[]).await?;
    let mut tags = Vec::new();
    if let Some(groups) = raw.get("data").and_then(|v| v.as_array()) {
        for group in groups {
            let mut list = Vec::new();
            if let Some(items) = group.get("data").and_then(|v| v.as_array()) {
                for item in items {
                    list.push(serde_json::json!({
                        "parent_id": value_string(group, &["id"]),
                        "parent_name": value_str(group, &["name"]),
                        "id": format!("{}-{}", value_string(item, &["id"]), value_string(item, &["digest"])),
                        "name": value_str(item, &["name"]),
                        "source": "kw"
                    }));
                }
            }
            tags.push(serde_json::json!({ "name": value_str(group, &["name"]), "list": list }));
        }
    }
    let hot_raw = sdk_get_json("http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmTagList?loginUid=0&loginSid=0&appUid=76039576", &[]).await.unwrap_or_default();
    let hot_tag: Vec<serde_json::Value> = hot_raw
        .pointer("/data/0/data")
        .and_then(|v| v.as_array())
        .map(|items| {
            items.iter().map(|item| serde_json::json!({
                "id": format!("{}-{}", value_string(item, &["id"]), value_string(item, &["digest"])),
                "name": value_str(item, &["name"]),
                "source": "kw"
            })).collect()
        })
        .unwrap_or_default();
    Ok(serde_json::json!({ "tags": tags, "hotTag": hot_tag, "source": "kw" }))
}

async fn kg_playlist_tags() -> Result<serde_json::Value, String> {
    let raw = sdk_get_json(
        "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_smarty=1&",
        &[],
    )
    .await?;
    let mut hot_tag = Vec::new();
    if let Some(tags) = raw.pointer("/data/hotTag/data").and_then(|v| v.as_object()) {
        for tag in tags.values() {
            hot_tag.push(serde_json::json!({
                "id": value_string(tag, &["special_id"]),
                "name": value_str(tag, &["special_name"]),
                "source": "kg"
            }));
        }
    }
    let mut tags = Vec::new();
    if let Some(groups) = raw.pointer("/data/tagids").and_then(|v| v.as_object()) {
        for (name, group) in groups {
            let mut list = Vec::new();
            if let Some(items) = group.get("data").and_then(|v| v.as_array()) {
                for item in items {
                    list.push(serde_json::json!({
                        "parent_id": value_string(item, &["parent_id"]),
                        "parent_name": value_str(item, &["pname"]),
                        "id": value_string(item, &["id"]),
                        "name": value_str(item, &["name"]),
                        "source": "kg"
                    }));
                }
            }
            tags.push(serde_json::json!({ "name": name, "list": list }));
        }
    }
    Ok(serde_json::json!({ "tags": tags, "hotTag": hot_tag, "source": "kg" }))
}

async fn mg_playlist_tags() -> Result<serde_json::Value, String> {
    let headers = [
        ("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"),
        ("Referer", "https://m.music.migu.cn/"),
    ];
    let raw = sdk_get_json(
        "https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-taglist/release",
        &headers,
    )
    .await?;
    let mut hot_tag = Vec::new();
    let mut tags = Vec::new();
    if let Some(groups) = raw.get("data").and_then(|v| v.as_array()) {
        if let Some(first) = groups.first() {
            if let Some(items) = first.get("content").and_then(|v| v.as_array()) {
                for item in items {
                    let texts = item
                        .get("texts")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    hot_tag.push(serde_json::json!({
                        "id": texts.get(1).map(value_to_string).unwrap_or_default(),
                        "name": texts.first().map(value_to_string).unwrap_or_default(),
                        "source": "mg"
                    }));
                }
            }
        }
        for group in groups.iter().skip(1) {
            let mut list = Vec::new();
            if let Some(items) = group.get("content").and_then(|v| v.as_array()) {
                for item in items {
                    let texts = item
                        .get("texts")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    list.push(serde_json::json!({
                        "id": texts.get(1).map(value_to_string).unwrap_or_default(),
                        "name": texts.first().map(value_to_string).unwrap_or_default(),
                        "source": "mg"
                    }));
                }
            }
            tags.push(serde_json::json!({
                "name": scalar_str(group.pointer("/header/title")),
                "list": list,
            }));
        }
    }
    Ok(serde_json::json!({ "tags": tags, "hotTag": hot_tag, "source": "mg" }))
}

async fn aggregate_category_playlists(
    args: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let page = arg_i64(args, "page", 1).max(1);
    let limit = arg_i64(args, "limit", 30).max(1);
    let per_source_limit = ((limit + 4) / 5).max(1);
    let mut list = Vec::new();

    for source in ["wy", "tx", "kw", "kg", "mg"] {
        let mut source_args = args.clone();
        if let Some(obj) = source_args.as_object_mut() {
            obj.insert("source".to_string(), serde_json::json!(source));
            obj.insert("page".to_string(), serde_json::json!(page));
            obj.insert("limit".to_string(), serde_json::json!(per_source_limit));
        }
        let result = Box::pin(handle_get_category_playlists(source_args)).await;
        if let Ok(value) = result {
            if let Some(items) = value.get("list").and_then(|v| v.as_array()) {
                for item in items {
                    let mut mapped = item.clone();
                    if let Some(obj) = mapped.as_object_mut() {
                        obj.entry("source".to_string())
                            .or_insert_with(|| serde_json::json!(source));
                    }
                    list.push(mapped);
                    if list.len() >= limit as usize {
                        break;
                    }
                }
            }
        }
        if list.len() >= limit as usize {
            break;
        }
    }

    let total = list.len() as i64;
    Ok(serde_json::json!({
        "list": list,
        "total": total,
        "page": page,
        "limit": limit,
        "source": "all",
    }))
}

/// Get playlists by category.
async fn handle_get_category_playlists(
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_category_playlists_response(&args) {
        return Ok(existing);
    }

    match arg_source(&args) {
        "all" => aggregate_category_playlists(&args).await,
        "wy" => {
            let cat = args.get("cat").and_then(|v| v.as_str()).unwrap_or("全部");
            let order = args.get("order").and_then(|v| v.as_str()).unwrap_or("hot");
            let limit = arg_i64(&args, "limit", 30);
            let page = arg_i64(&args, "page", 1).max(1);
            let offset = args
                .get("offset")
                .and_then(|v| v.as_i64())
                .unwrap_or((page - 1) * limit);
            let url = reqwest::Url::parse_with_params(
                "https://music.163.com/api/playlist/list",
                &[
                    ("cat", cat),
                    ("order", order),
                    ("limit", &limit.to_string()),
                    ("offset", &offset.to_string()),
                ],
            )
            .map_err(|e| format!("URL 解析失败: {}", e))?;
            let raw = netease_get(url.as_str()).await?;
            let list = raw
                .get("playlists")
                .cloned()
                .unwrap_or(serde_json::json!([]));
            let total = raw.get("total").cloned().unwrap_or(serde_json::json!(0));
            Ok(
                serde_json::json!({ "list": list, "total": total, "page": page, "limit": limit, "source": "wy" }),
            )
        }
        "tx" => tx_category_playlists(&args).await,
        "kw" => kw_category_playlists(&args).await,
        "kg" => kg_category_playlists(&args).await,
        "mg" => mg_category_playlists(&args).await,
        _ => Ok(serde_json::json!({ "list": [], "total": 0 })),
    }
}

async fn tx_category_playlists(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let tag_id = arg_string(args, "tagId", "");
    let page = arg_i64(args, "page", 1).max(1);
    let limit = arg_i64(args, "limit", 36).clamp(1, 100);
    let order = match arg_string(args, "sortId", "hot").as_str() {
        "new" | "2" => 2,
        _ => 5,
    };
    let body = if tag_id.is_empty() {
        serde_json::json!({
            "comm": { "cv": 1602, "ct": 20 },
            "playlist": {
                "method": "get_playlist_by_tag",
                "param": { "id": 10000000, "sin": limit * (page - 1), "size": limit, "order": order, "cur_page": page },
                "module": "playlist.PlayListPlazaServer"
            }
        })
    } else {
        let id = tag_id.parse::<i64>().unwrap_or(0);
        serde_json::json!({
            "comm": { "cv": 1602, "ct": 20 },
            "playlist": {
                "method": "get_category_content",
                "param": { "titleid": id, "caller": "0", "category_id": id, "size": limit, "page": page - 1, "use_page": 1 },
                "module": "playlist.PlayListCategoryServer"
            }
        })
    };
    let data = serde_json::to_string(&body).map_err(|e| format!("JSON 序列化失败: {}", e))?;
    let url = format!("https://u.y.qq.com/cgi-bin/musicu.fcg?loginUin=0&hostUin=0&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=wk_v15.json&needNewCode=0&data={}", url_encode(&data));
    let raw = sdk_get_json(&url, &[]).await?;
    let mut list = Vec::new();
    let total;
    if tag_id.is_empty() {
        let data = raw.pointer("/playlist/data").cloned().unwrap_or_default();
        total = scalar_i64(data.get("total")).unwrap_or(0);
        if let Some(items) = data.get("v_playlist").and_then(|v| v.as_array()) {
            for item in items {
                let id = value_string(item, &["tid"]);
                let name = value_str(item, &["title"]);
                let img = normalize_image_url(value_str(item, &["cover_url_medium"]));
                if id.is_empty() || name.is_empty() || img.is_empty() {
                    continue;
                }
                list.push(serde_json::json!({
                    "play_count": format_play_count(scalar_i64(item.get("access_num")).unwrap_or(0)),
                    "id": id,
                    "author": scalar_str(item.pointer("/creator_info/nick")),
                    "name": name,
                    "img": img,
                    "total": item.get("song_ids").and_then(|v| v.as_array()).map(|v| v.len()).unwrap_or(0),
                    "desc": decode_basic_html(value_str(item, &["desc"])),
                    "source": "tx"
                }));
            }
        }
    } else {
        let content = raw
            .pointer("/playlist/data/content")
            .cloned()
            .unwrap_or_default();
        total = scalar_i64(content.get("total_cnt")).unwrap_or(0);
        if let Some(items) = content.get("v_item").and_then(|v| v.as_array()) {
            for item in items {
                let basic = item.get("basic").unwrap_or(item);
                let id = value_string(basic, &["tid"]);
                let name = value_str(basic, &["title"]);
                let img = normalize_image_url(
                    scalar_str(basic.pointer("/cover/medium_url"))
                        .if_empty(scalar_str(basic.pointer("/cover/default_url"))),
                );
                if id.is_empty() || name.is_empty() || img.is_empty() {
                    continue;
                }
                list.push(serde_json::json!({
                    "play_count": format_play_count(scalar_i64(basic.get("play_cnt")).unwrap_or(0)),
                    "id": id,
                    "author": scalar_str(basic.pointer("/creator/nick")),
                    "name": name,
                    "img": img,
                    "desc": decode_basic_html(value_str(basic, &["desc"])),
                    "source": "tx"
                }));
            }
        }
    }
    Ok(
        serde_json::json!({ "list": list, "total": total, "page": page, "limit": limit, "source": "tx" }),
    )
}

trait EmptyStrExt {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str;
}

impl EmptyStrExt for str {
    fn if_empty<'a>(&'a self, fallback: &'a str) -> &'a str {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

async fn kw_category_playlists(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let tag_id = arg_string(args, "tagId", "");
    let page = arg_i64(args, "page", 1).max(1);
    let limit = arg_i64(args, "limit", 36).clamp(1, 100);
    let sort_id = arg_string(args, "sortId", "hot");
    let (id, digest) = if tag_id.is_empty() {
        (String::new(), String::new())
    } else {
        let mut parts = tag_id.split('-');
        (
            parts.next().unwrap_or("").to_string(),
            parts.next().unwrap_or("").to_string(),
        )
    };
    let url = if id.is_empty() {
        format!("http://wapi.kuwo.cn/api/pc/classify/playlist/getRcmPlayList?loginUid=0&loginSid=0&appUid=76039576&&pn={}&rn={}&order={}", page, limit, sort_id)
    } else if digest == "43" {
        format!(
            "http://mobileinterfaces.kuwo.cn/er.s?type=get_pc_qz_data&f=web&id={}&prod=pc",
            id
        )
    } else {
        format!("http://wapi.kuwo.cn/api/pc/classify/playlist/getTagPlayList?loginUid=0&loginSid=0&appUid=76039576&pn={}&id={}&rn={}", page, id, limit)
    };
    let raw = sdk_get_json(&url, &[]).await?;
    let mut list = Vec::new();
    if digest == "43" {
        if let Some(groups) = raw.as_array() {
            for group in groups {
                if group.get("label").is_none() {
                    continue;
                }
                if let Some(items) = group.get("list").and_then(|v| v.as_array()) {
                    for item in items {
                        list.push(kw_playlist_card(item));
                    }
                }
            }
        }
        return Ok(
            serde_json::json!({ "list": list, "total": 1000, "page": page, "limit": 1000, "source": "kw" }),
        );
    }
    if let Some(items) = raw.pointer("/data/data").and_then(|v| v.as_array()) {
        for item in items {
            list.push(kw_playlist_card(item));
        }
    }
    let total = scalar_i64(raw.pointer("/data/total")).unwrap_or(list.len() as i64);
    Ok(
        serde_json::json!({ "list": list, "total": total, "page": page, "limit": limit, "source": "kw" }),
    )
}

fn kw_playlist_card(item: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "play_count": format_play_count(value_i64(item, &["listencnt", "play_count"])),
        "id": format!("digest-{}__{}", value_string(item, &["digest"]), value_string(item, &["id"])),
        "author": value_str(item, &["uname"]),
        "name": value_str(item, &["name"]),
        "total": value_i64(item, &["total"]),
        "img": normalize_image_url(value_str(item, &["img"])),
        "grade": value_i64(item, &["favorcnt"]) / 10,
        "desc": value_str(item, &["desc"]),
        "source": "kw"
    })
}

async fn kg_category_playlists(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let tag_id = arg_string(args, "tagId", "");
    let page = arg_i64(args, "page", 1).max(1);
    let sort_id = match arg_string(args, "sortId", "5").as_str() {
        "hot" => "5".to_string(),
        other => other.to_string(),
    };
    let url = format!(
        "http://www2.kugou.kugou.com/yueku/v9/special/getSpecial?is_ajax=1&cdn=cdn&t={}&c={}&p={}",
        sort_id, tag_id, page
    );
    let raw = sdk_get_json(&url, &[]).await?;
    let mut list = Vec::new();
    if let Some(items) = raw.get("special_db").and_then(|v| v.as_array()) {
        for item in items {
            list.push(kg_playlist_card(item));
        }
    }
    let total = scalar_i64(raw.pointer("/data/params/total")).unwrap_or(list.len() as i64);
    Ok(
        serde_json::json!({ "list": list, "total": total, "page": page, "limit": list.len(), "source": "kg" }),
    )
}

fn kg_playlist_card(item: &serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "play_count": item.get("total_play_count").cloned().unwrap_or_else(|| format_play_count(value_i64(item, &["play_count"]))),
        "id": format!("id_{}", value_string(item, &["specialid"])),
        "author": value_str(item, &["nickname"]),
        "name": value_str(item, &["specialname"]),
        "img": normalize_image_url(value_str(item, &["img", "imgurl"])),
        "total": value_i64(item, &["songcount"]),
        "grade": value_i64(item, &["grade"]),
        "desc": value_str(item, &["intro"]),
        "source": "kg"
    })
}

async fn mg_category_playlists(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let tag_id = arg_string(args, "tagId", "");
    let page = arg_i64(args, "page", 1).max(1);
    let limit = arg_i64(args, "limit", 30).clamp(1, 100);
    let headers = [
        ("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1"),
        ("Referer", "https://m.music.migu.cn/"),
    ];
    let url = if tag_id.is_empty() {
        format!("https://app.c.nf.migu.cn/pc/bmw/page-data/playlist-square-recommend/v1.0?templateVersion=2&pageNo={}", page)
    } else {
        format!("https://app.c.nf.migu.cn/pc/v1.0/template/musiclistplaza-listbytag/release?pageNumber={}&templateVersion=2&tagId={}", page, tag_id)
    };
    let raw = sdk_get_json(&url, &headers).await?;
    let mut list = Vec::new();
    if let Some(contents) = raw.pointer("/data/contents").and_then(|v| v.as_array()) {
        collect_mg_playlists(contents, &mut list);
    } else if let Some(items) = raw
        .pointer("/data/contentItemList/1/itemList")
        .and_then(|v| v.as_array())
    {
        for item in items {
            list.push(serde_json::json!({
                "play_count": scalar_str(item.pointer("/barList/0/title")),
                "id": value_to_string(item.pointer("/logEvent/contentId").unwrap_or(&serde_json::Value::Null)),
                "author": "",
                "name": value_str(item, &["title"]),
                "img": normalize_image_url(value_str(item, &["imageUrl"])),
                "source": "mg"
            }));
        }
    }
    Ok(
        serde_json::json!({ "list": list, "total": 99999, "page": page, "limit": limit, "source": "mg" }),
    )
}

/// Get leaderboards (toplists).
async fn handle_get_leaderboards(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_leaderboards_response(&args) {
        return Ok(existing);
    }

    match arg_source(&args) {
        "wy" => {
            let url = "https://music.163.com/api/toplist";
            let raw = netease_get_json(url).await?;
            Ok(raw.get("list").cloned().unwrap_or(serde_json::json!([])))
        }
        "tx" => Ok(serde_json::Value::Array(tx_leaderboards().await)),
        "kw" => Ok(serde_json::Value::Array(kw_leaderboards().await)),
        "kg" => Ok(serde_json::Value::Array(kg_leaderboards().await)),
        "mg" => Ok(serde_json::Value::Array(mg_static_boards())),
        _ => Ok(serde_json::json!([])),
    }
}

async fn tx_leaderboards() -> Vec<serde_json::Value> {
    let url = "https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?g_tk=1928093487&inCharset=utf-8&outCharset=utf-8&notice=0&format=json&uin=0&needNewCode=1&platform=h5";
    if let Ok(raw) = sdk_get_json(url, &[]).await {
        if let Some(items) = raw.pointer("/data/topList").and_then(|v| v.as_array()) {
            let list: Vec<serde_json::Value> = items
                .iter()
                .filter_map(|board| {
                    let id = value_string(board, &["id"]);
                    if id == "201" || id.is_empty() {
                        return None;
                    }
                    let mut name = value_str(board, &["topTitle"])
                        .trim_start_matches("巅峰榜·")
                        .to_string();
                    if !name.ends_with('榜') {
                        name.push('榜');
                    }
                    Some(serde_json::json!({
                        "id": format!("tx__{}", id),
                        "name": name,
                        "bangid": id,
                        "pic": normalize_image_url(value_str(board, &["picUrl"])),
                        "listen": format_play_count(value_i64(board, &["listenCount"])),
                        "source": "tx"
                    }))
                })
                .collect();
            if !list.is_empty() {
                return list;
            }
        }
    }
    tx_static_boards()
}

async fn kw_leaderboards() -> Vec<serde_json::Value> {
    let url = "http://qukudata.kuwo.cn/q.k?op=query&cont=tree&node=2&pn=0&rn=1000&fmt=json&level=3";
    if let Ok(raw) = sdk_get_json(url, &[]).await {
        if let Some(items) = raw.get("child").and_then(|v| v.as_array()) {
            let mut list: Vec<serde_json::Value> = items
                .iter()
                .map(|board| {
                    serde_json::json!({
                        "id": format!("kw__{}", value_string(board, &["sourceid"])),
                        "name": value_str(board, &["name"]),
                        "bangid": value_string(board, &["sourceid"]),
                        "pic": normalize_image_url(value_str(board, &["pic"])),
                        "listen": format_play_count(value_i64(board, &["listen"])),
                        "update_frequency": value_str(board, &["info"]),
                        "source": "kw"
                    })
                })
                .collect();
            list.retain(|item| !value_str(item, &["bangid"]).is_empty());
            if !list.is_empty() {
                return list;
            }
        }
    }
    kw_static_boards()
}

async fn kg_leaderboards() -> Vec<serde_json::Value> {
    let url = "http://mobilecdnbj.kugou.com/api/v5/rank/list?version=9108&plat=0&showtype=2&parentid=0&apiver=6&area_code=1&withsong=1";
    if let Ok(raw) = sdk_get_json(url, &[]).await {
        if let Some(items) = raw.pointer("/data/info").and_then(|v| v.as_array()) {
            let list: Vec<serde_json::Value> = items
                .iter()
                .filter_map(|board| {
                    if value_i64(board, &["isvol"]) != 1 {
                        return None;
                    }
                    let id = value_string(board, &["rankid"]);
                    Some(serde_json::json!({
                        "id": format!("kg__{}", id),
                        "name": value_str(board, &["rankname"]),
                        "bangid": id,
                        "pic": normalize_image_url(value_str(board, &["imgurl"])),
                        "listen": format_play_count(value_i64(board, &["play_times"])),
                        "update_frequency": value_str(board, &["update_frequency"]),
                        "source": "kg"
                    }))
                })
                .collect();
            if !list.is_empty() {
                return list;
            }
        }
    }
    kg_static_boards()
}

/// Get leaderboard detail (playlist-style).
async fn handle_get_leaderboard_detail(
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    match arg_source(&args) {
        "wy" => handle_get_playlist_detail(args).await,
        "tx" => tx_leaderboard_detail(&args).await,
        "kw" => kw_leaderboard_detail(&args).await,
        "kg" => kg_leaderboard_detail(&args).await,
        "mg" => mg_leaderboard_detail(&args).await,
        _ => Ok(empty_playlist_detail()),
    }
}

async fn tx_leaderboard_detail(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let id = extract_numeric_id(&arg_string(args, "id", ""));
    let body = serde_json::json!({
        "toplist": {
            "module": "musicToplist.ToplistInfoServer",
            "method": "GetDetail",
            "param": { "topid": id.parse::<i64>().unwrap_or(0), "num": 300 }
        },
        "comm": { "uin": 0, "format": "json", "ct": 20, "cv": 1859 }
    });
    let raw = sdk_post_json(
        "https://u.y.qq.com/cgi-bin/musicu.fcg",
        body,
        &[("Referer", "https://y.qq.com/")],
    )
    .await?;
    let songs: Vec<serde_json::Value> = raw
        .pointer("/toplist/data/songInfoList")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(tx_song).collect())
        .unwrap_or_default();
    let total = songs.len() as i64;
    Ok(
        serde_json::json!({ "list": songs, "total": total, "limit": 300, "page": 1, "source": "tx", "info": { "name": "", "total": total } }),
    )
}

async fn kw_leaderboard_detail(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let id = extract_numeric_id(&arg_string(args, "id", ""));
    let page = arg_i64(args, "page", 1).max(1);
    let url = format!("http://kbangserver.kuwo.cn/ksong.s?from=pc&fmt=json&pn={}&rn=100&type=bang&data=content&id={}&show_copyright_off=0&pcmp4=1&isbang=1", page - 1, id);
    let raw = sdk_get_json(&url, &[]).await?;
    let songs: Vec<serde_json::Value> = raw
        .get("musiclist")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(kw_song).collect())
        .unwrap_or_default();
    let total = scalar_i64(raw.get("total")).unwrap_or(songs.len() as i64);
    Ok(
        serde_json::json!({ "list": songs, "total": total, "limit": 100, "page": page, "source": "kw", "info": { "name": value_str(&raw, &["name"]), "total": total } }),
    )
}

async fn kg_leaderboard_detail(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let id = extract_numeric_id(&arg_string(args, "id", ""));
    let page = arg_i64(args, "page", 1).max(1);
    let url = format!("http://mobilecdnbj.kugou.com/api/v3/rank/song?version=9108&ranktype=1&plat=0&pagesize=100&area_code=1&page={}&rankid={}&with_res_tag=0&show_portrait_mv=1", page, id);
    let raw = sdk_get_json(&url, &[]).await?;
    let songs: Vec<serde_json::Value> = raw
        .pointer("/data/info")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(kg_song).collect())
        .unwrap_or_default();
    let total = scalar_i64(raw.pointer("/data/total")).unwrap_or(songs.len() as i64);
    Ok(
        serde_json::json!({ "list": songs, "total": total, "limit": 100, "page": page, "source": "kg", "info": { "name": "", "total": total } }),
    )
}

async fn mg_leaderboard_detail(args: &serde_json::Value) -> Result<serde_json::Value, String> {
    let id = extract_numeric_id(&arg_string(args, "id", ""));
    let page = arg_i64(args, "page", 1).max(1);
    let url = format!(
        "https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/querycontentbyId.do?columnId={}&needAll=0",
        id
    );
    let raw = sdk_get_json(&url, &[]).await?;
    let songs: Vec<serde_json::Value> = raw
        .pointer("/columnInfo/contents")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("objectInfo"))
                .map(mg_song)
                .collect()
        })
        .unwrap_or_default();
    let total = songs.len() as i64;
    Ok(
        serde_json::json!({ "list": songs, "total": total, "limit": 200, "page": page, "source": "mg", "info": { "name": scalar_str(raw.pointer("/columnInfo/columnTitle")), "total": total } }),
    )
}

/// Get hot comments for a song. Source: "wy" (NetEase).
async fn handle_get_hot_comment(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_comment_response(&args, true) {
        return Ok(existing);
    }

    let source = arg_source(&args);
    let page = arg_i64(&args, "page", 1).max(1);
    let limit = arg_i64(&args, "limit", 100).max(1);

    match source {
        "wy" => netease_get_comments(args, true).await,
        "kw" => kuwo_get_comments(args, true).await,
        _ => Ok(empty_comment_response(source, page, limit)),
    }
}

/// Get latest comments for a song. Source: "wy" (NetEase).
async fn handle_get_comment(args: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(existing) = existing_comment_response(&args, false) {
        return Ok(existing);
    }

    let source = arg_source(&args);
    let page = arg_i64(&args, "page", 1).max(1);
    let limit = arg_i64(&args, "limit", 20).max(1);

    match source {
        "wy" => netease_get_comments(args, false).await,
        "kw" => kuwo_get_comments(args, false).await,
        _ => Ok(empty_comment_response(source, page, limit)),
    }
}

fn normalize_comment_response(
    source: &str,
    raw: serde_json::Value,
    hot: bool,
    page: i64,
    limit: i64,
) -> serde_json::Value {
    let comments = if hot {
        array_at(
            &raw,
            &[
                "comments",
                "hotComments",
                "/data/comments",
                "/data/hotComments",
                "/result/comments",
                "/result/hotComments",
            ],
        )
    } else {
        array_at(&raw, &["comments", "/data/comments", "/result/comments"])
    }
    .unwrap_or_default();
    let total = numeric_at(
        &raw,
        &[
            "total",
            "totalCount",
            "/data/total",
            "/data/totalCount",
            "/result/total",
        ],
        comments.len() as i64,
    );

    serde_json::json!({
        "source": source,
        "comments": normalize_comments(&comments),
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": max_page(total, limit),
    })
}

/// NetEase comments API helper.
async fn netease_get_comments(
    args: serde_json::Value,
    hot: bool,
) -> Result<serde_json::Value, String> {
    let song_info = args.get("songInfo");
    let song_id = args
        .get("id")
        .map(value_to_string)
        .filter(|id| !id.is_empty())
        .or_else(|| {
            song_info.and_then(|si| {
                let id = value_string(si, &["id", "songmid", "songId", "mid"]);
                if id.is_empty() {
                    None
                } else {
                    Some(id)
                }
            })
        })
        .unwrap_or_default();

    let page = arg_i64(&args, "page", 1).max(1);
    let limit = arg_i64(&args, "limit", if hot { 100 } else { 20 }).max(1);
    let offset = args
        .get("offset")
        .and_then(|v| v.as_i64())
        .unwrap_or((page - 1) * limit);

    if song_id.is_empty() {
        return Ok(empty_comment_response("wy", page, limit));
    }

    let rid = format!("R_SO_4_{}", song_id);
    let endpoint = if hot { "hot" } else { "new" };

    let url = reqwest::Url::parse_with_params(
        &format!(
            "https://music.163.com/api/v1/resource/comments/{}/{}",
            rid, endpoint
        ),
        &[
            ("rid", &rid),
            ("limit", &limit.to_string()),
            ("offset", &offset.to_string()),
        ],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let raw = match netease_get(url.as_str()).await {
        Ok(raw) => raw,
        Err(_) => return Ok(empty_comment_response("wy", page, limit)),
    };
    Ok(normalize_comment_response("wy", raw, hot, page, limit))
}

async fn kuwo_get_comments(
    args: serde_json::Value,
    hot: bool,
) -> Result<serde_json::Value, String> {
    let song_info = args.get("songInfo");
    let song_id = args
        .get("id")
        .map(value_to_string)
        .filter(|id| !id.is_empty())
        .or_else(|| {
            song_info.and_then(|si| {
                let id = value_string(si, &["id", "songmid", "songId", "mid"]);
                if id.is_empty() {
                    None
                } else {
                    Some(id)
                }
            })
        })
        .unwrap_or_default();

    let page = arg_i64(&args, "page", 1).max(1);
    let limit = arg_i64(&args, "limit", if hot { 100 } else { 20 }).max(1);

    if song_id.is_empty() {
        return Ok(empty_comment_response("kw", page, limit));
    }

    let comment_type = if hot {
        "get_rec_comment"
    } else {
        "get_comment"
    };
    let start = limit * (page - 1);
    let url = format!(
        "http://ncomment.kuwo.cn/com.s?f=web&type={}&aapiver=1&prod=kwplayer_ar_10.5.2.0&digest=15&sid={}&start={}&msgflag=1&count={}&newver=3&uid=0",
        comment_type,
        url_encode(&song_id),
        start,
        limit
    );
    let raw = match sdk_get_json(
        &url,
        &[("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 9;)")],
    )
    .await
    {
        Ok(raw) => raw,
        Err(_) => return Ok(empty_comment_response("kw", page, limit)),
    };

    let code = value_to_string(raw.get("code").unwrap_or(&serde_json::Value::Null));
    if code != "200" {
        return Ok(empty_comment_response("kw", page, limit));
    }

    let list_key = if hot { "hot_comments" } else { "comments" };
    let total_key = if hot {
        "hot_comments_counts"
    } else {
        "comments_counts"
    };
    let comments: Vec<serde_json::Value> = raw
        .get(list_key)
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(kuwo_comment_item).collect())
        .unwrap_or_default();
    let total = scalar_i64(raw.get(total_key)).unwrap_or(comments.len() as i64);

    Ok(serde_json::json!({
        "source": "kw",
        "comments": comments,
        "total": total,
        "page": page,
        "limit": limit,
        "maxPage": max_page(total, limit),
    }))
}

fn kuwo_comment_item(item: &serde_json::Value) -> serde_json::Value {
    let time = value_i64(item, &["time"]);
    let image = value_str(item, &["mpic"]);
    let images = if image.is_empty() {
        serde_json::json!([])
    } else {
        serde_json::json!([image])
    };
    let replies: Vec<serde_json::Value> = item
        .get("child_comments")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().map(kuwo_comment_item).collect())
        .unwrap_or_default();

    serde_json::json!({
        "id": value_string(item, &["id"]),
        "text": value_str(item, &["msg"]),
        "time": time,
        "timeStr": if time > 0 { chrono::Local.timestamp_opt(time, 0).single().map(|dt| dt.format("%Y-%m-%d").to_string()).unwrap_or_default() } else { String::new() },
        "userName": value_str(item, &["u_name"]),
        "avatar": value_str(item, &["u_pic"]),
        "userId": value_string(item, &["u_id"]),
        "likedCount": value_i64(item, &["like_num"]),
        "images": images,
        "reply": replies,
    })
}

/// Parse playlist ID from URL or text.
fn handle_parse_playlist_id(args: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");

    if url.is_empty() {
        return Ok(serde_json::json!(""));
    }

    let id = if url.contains("id=") {
        url.split("id=").nth(1).and_then(|s| {
            let s = s.split('&').next().unwrap_or(s);
            Some(s.to_string())
        })
    } else if url.contains("playlist/") {
        url.split("playlist/").nth(1).and_then(|s| {
            let s = s.split(&['?', '#'][..]).next().unwrap_or(s);
            Some(s.to_string())
        })
    } else if url.chars().all(|c| c.is_ascii_digit()) {
        Some(url.to_string())
    } else {
        None
    };

    Ok(serde_json::json!(id.unwrap_or_default()))
}

/// Helper: GET a URL and parse JSON response (NetEase headers).
async fn netease_get(url: &str) -> Result<serde_json::Value, String> {
    let resp = netease_client()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))
}

/// Helper: GET a URL string and parse JSON.
async fn netease_get_json(url: &str) -> Result<serde_json::Value, String> {
    netease_get(url).await
}

// ==================== Music SDK: Download Helpers ====================

use crate::commands::download_engine::DownloadEngine;
use crate::models::DownloadTask;

/// Determine file extension from quality string.
fn quality_ext(quality: &str) -> &str {
    match quality {
        q if q.contains("flac") || q == "flac" => "flac",
        q if q.contains("ape") => "ape",
        q if q.contains("wav") => "wav",
        q if q.contains("ogg") => "ogg",
        q if q.contains("wma") => "wma",
        q if q.contains("dsd") || q.contains("dsf") => "dsf",
        _ => "mp3",
    }
}

/// Sanitise filename – keep safe chars only.
fn sanitise(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' || c == ' ' || c == '~' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Build the output file path using configured storage directories.
fn build_file_path(
    app: &tauri::AppHandle,
    db: &crate::db::Database,
    song_info: &serde_json::Value,
    name: &str,
    singer: &str,
    quality: &str,
    is_cache: bool,
) -> Result<String, String> {
    let dir = if is_cache {
        db.get_setting("cache_dir")
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| {
                app.path()
                    .app_data_dir()
                    .map(|path| path.join("music-cache").to_string_lossy().to_string())
                    .unwrap_or_else(|_| "music-cache".to_string())
            })
    } else {
        db.get_setting("download_dir")
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| {
                app.path()
                    .download_dir()
                    .map(|path| path.to_string_lossy().to_string())
                    .or_else(|_| {
                        app.path()
                            .app_data_dir()
                            .map(|path| path.join("downloads").to_string_lossy().to_string())
                    })
                    .unwrap_or_else(|_| "downloads".to_string())
            })
    };

    let dir_path = Path::new(&dir);
    if !dir_path.exists() {
        std::fs::create_dir_all(dir_path).map_err(|e| {
            if is_cache {
                format!("创建缓存目录失败: {}", e)
            } else {
                format!("创建下载目录失败: {}", e)
            }
        })?;
    }
    if !dir_path.is_dir() {
        return Err(if is_cache {
            "缓存目录不是有效文件夹，请重新选择缓存目录".into()
        } else {
            "下载目录不是有效文件夹，请重新选择下载目录".into()
        });
    }

    let ext = quality_ext(quality);
    let template = song_info
        .get("template")
        .and_then(|v| v.as_str())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("%t - %s");
    let album = song_info
        .get("albumName")
        .or_else(|| song_info.get("album_name"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let source = song_info
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let date = song_info.get("date").and_then(|v| v.as_str()).unwrap_or("");
    let filename_base = template
        .replace("%t", name)
        .replace("%s", singer)
        .replace("%a", album)
        .replace("%u", source)
        .replace("%d", date)
        .replace("%q", quality);
    let filename_base = if filename_base.trim().is_empty() {
        format!("{} - {}", name, singer)
    } else {
        filename_base
    };
    let filename = format!("{}.{}", sanitise(&filename_base), ext);
    Ok(format!("{}/{}", dir.trim_end_matches('/'), filename))
}

/// Create a download task, persist it, emit event, and wake the engine.
fn create_download_task(
    app: &tauri::AppHandle,
    url: String,
    file_path: String,
    song_info: &serde_json::Value,
    tag_write_options: serde_json::Value,
    plugin_id: Option<String>,
    quality: Option<String>,
) -> Result<DownloadTask, String> {
    let task_id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let name = song_info
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown");
    let singer = song_info
        .get("singer")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown");
    let cover = value_string(
        song_info,
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
    );
    let songmid = value_string(song_info, &["songmid", "id", "songId", "mid"]);

    let task = DownloadTask {
        task_id,
        songmid,
        url,
        file_path,
        status: "pending".into(),
        progress: 0.0,
        total_bytes: 0,
        downloaded_bytes: 0,
        name: name.to_string(),
        singer: singer.to_string(),
        cover: cover.to_string(),
        error_message: None,
        retries: 0,
        created_at: now.clone(),
        updated_at: now,
        song_info: song_info.clone(),
        tag_write_options,
        plugin_id,
        quality,
        metadata_error: None,
    };

    let db = app
        .try_state::<crate::db::Database>()
        .ok_or_else(|| "下载数据库未初始化".to_string())?;
    let existing = db.get_download_tasks();
    for t in &existing {
        let file_exists = !t.file_path.is_empty() && Path::new(&t.file_path).exists();
        if t.file_path == task.file_path
            && t.status != "error"
            && t.status != "cancelled"
            && (t.status != "completed" || file_exists)
        {
            return Ok(t.clone());
        }
        if !task.songmid.is_empty()
            && t.songmid == task.songmid
            && t.status == "completed"
            && file_exists
        {
            return Ok(t.clone());
        }
    }
    db.upsert_download_task(&task)?;
    let persisted = db
        .get_download_task(&task.task_id)
        .ok_or_else(|| "下载任务未写入数据库".to_string())?;

    let _ = app.emit("download:task-added", &persisted);

    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.wake();
    }

    Ok(persisted)
}

fn usable_download_url(input: &str) -> Option<String> {
    let url = input.trim();
    if url.is_empty() || url.contains("error") || is_restricted_playback_text(url) {
        return None;
    }
    if url.starts_with("http://")
        || url.starts_with("https://")
        || url.starts_with("file://")
        || url.starts_with("data:audio/")
    {
        Some(url.to_string())
    } else {
        None
    }
}

/// Resolve download URL from songInfo.
/// First checks `typeUrl[quality]`, then `url` field, then SDK fallback.
async fn resolve_download_url(
    song_info: &serde_json::Value,
    source: &str,
    quality: &str,
) -> Result<String, String> {
    // Try typeUrl[quality] first
    if let Some(type_url) = song_info.get("typeUrl") {
        if let Some(url) = type_url.get(quality).and_then(|v| v.as_str()) {
            if let Some(url) = usable_download_url(url) {
                return Ok(url);
            }
        }
    }
    // Try direct url field
    if let Some(url) = song_info.get("url").and_then(|v| v.as_str()) {
        if let Some(url) = usable_download_url(url) {
            return Ok(url);
        }
    }
    // SDK fallback: call getMusicUrl
    let sdk_args = serde_json::json!({
        "source": source,
        "songInfo": song_info,
        "quality": quality,
    });
    let result = handle_get_music_url(sdk_args).await?;
    if let Some(url) = result.as_str() {
        if let Some(url) = usable_download_url(url) {
            return Ok(url);
        }
    }
    if let Some(err) = result.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    Err("无法获取歌曲下载链接".into())
}

/// Download a single song: resolve URL, create task, return file path.
async fn handle_download_single_song(
    app: &tauri::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let source = args.get("source").and_then(|v| v.as_str()).unwrap_or("wy");
    let quality = args
        .get("quality")
        .and_then(|v| v.as_str())
        .unwrap_or("320k");
    let song_info = args.get("songInfo").ok_or("缺少 songInfo")?;
    let is_cache = args
        .get("isCache")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let name = song_info
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown");
    let singer = song_info
        .get("singer")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown");

    // 1. Resolve download URL
    let url = if let Some(url) = args
        .get("url")
        .and_then(string_url_from_value)
        .or_else(|| {
            song_info
                .get("__nativeMedia")
                .and_then(|media| media.get("url"))
                .and_then(string_url_from_value)
        })
        .and_then(|url| usable_download_url(&url))
    {
        url
    } else {
        resolve_download_url(song_info, source, quality).await?
    };

    // 2. Determine file path
    let db = app.state::<crate::db::Database>();
    let file_path = build_file_path(&app, &db, song_info, name, singer, quality, is_cache)?;

    let tag_write_options = args
        .get("tagWriteOptions")
        .or_else(|| args.get("tag_write_options"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let plugin_id = args
        .get("pluginId")
        .or_else(|| args.get("plugin_id"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());

    // 3. Create download task
    let task = create_download_task(
        app,
        url,
        file_path,
        song_info,
        tag_write_options,
        plugin_id,
        Some(quality.to_string()),
    )?;

    Ok(serde_json::json!({
        "message": "歌曲已添加到下载队列",
        "filePath": task.file_path,
        "path": task.file_path,
        "task": task,
    }))
}

/// Download multiple songs in batch.
async fn handle_download_batch_songs(
    app: &tauri::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let default_source = args.get("source").and_then(|v| v.as_str()).unwrap_or("wy");
    let tasks = args
        .get("tasks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut succeeded = 0i64;
    let mut errors: Vec<String> = Vec::new();

    for task_args in &tasks {
        let quality = task_args
            .get("quality")
            .and_then(|v| v.as_str())
            .unwrap_or("320k");
        let song_info = task_args.get("songInfo").cloned().unwrap_or_default();
        let source = task_args
            .get("source")
            .and_then(|v| v.as_str())
            .or_else(|| song_info.get("source").and_then(|v| v.as_str()))
            .unwrap_or(default_source);
        let name = song_info
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let singer = song_info
            .get("singer")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let is_cache = task_args
            .get("isCache")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let resolved_url = if let Some(url) = task_args
            .get("url")
            .and_then(string_url_from_value)
            .or_else(|| {
                song_info
                    .get("__nativeMedia")
                    .and_then(|media| media.get("url"))
                    .and_then(string_url_from_value)
            })
            .and_then(|url| usable_download_url(&url))
        {
            Ok(url)
        } else {
            resolve_download_url(&song_info, source, quality).await
        };

        match resolved_url {
            Ok(url) => {
                let db = app.state::<crate::db::Database>();
                match build_file_path(&app, &db, &song_info, name, singer, quality, is_cache) {
                    Ok(file_path) => {
                        let tag_write_options = task_args
                            .get("tagWriteOptions")
                            .or_else(|| task_args.get("tag_write_options"))
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({}));
                        let plugin_id = task_args
                            .get("pluginId")
                            .or_else(|| task_args.get("plugin_id"))
                            .and_then(|v| v.as_str())
                            .map(|v| v.to_string());
                        match create_download_task(
                            app,
                            url,
                            file_path,
                            &song_info,
                            tag_write_options,
                            plugin_id,
                            Some(quality.to_string()),
                        ) {
                            Ok(_) => succeeded += 1,
                            Err(e) => errors.push(format!("{}: {}", name, e)),
                        }
                    }
                    Err(e) => errors.push(format!("{}: {}", name, e)),
                }
            }
            Err(e) => errors.push(format!("{}: {}", name, e)),
        }
    }

    let mut result = serde_json::json!({
        "message": format!("已添加 {} 首歌曲到下载队列", succeeded),
        "success": true,
        "added": succeeded,
    });
    if !errors.is_empty() {
        result["errors"] = serde_json::json!(errors);
        result["success"] = serde_json::json!(false);
    }
    Ok(result)
}

#[tauri::command]
pub async fn music_enqueue_download(
    app: tauri::AppHandle,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    handle_download_single_song(&app, unwrap_invoke_args(args)).await
}

// ==================== Music Cache ====================

fn cache_storage_dir(app: &tauri::AppHandle, db: &Database) -> String {
    db.get_setting("cache_dir")
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| {
            app.path()
                .app_data_dir()
                .map(|path| path.join("music-cache").to_string_lossy().to_string())
                .unwrap_or_else(|_| "music-cache".to_string())
        })
}

fn is_audio_cache_file(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_lowercase().as_str(),
                "mp3" | "flac" | "wav" | "aac" | "ogg" | "m4a" | "wma" | "ape" | "dsf"
            )
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn music_cache_clear(app: tauri::AppHandle, db: State<'_, Database>) -> Result<(), String> {
    let cache_dir = cache_storage_dir(&app, &db);
    let Ok(entries) = std::fs::read_dir(&cache_dir) else {
        return Ok(());
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && is_audio_cache_file(&path) {
            let _ = std::fs::remove_file(path);
        }
    }

    Ok(())
}

// ==================== File System ====================

/// Read file content as base64.
#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    let content = std::fs::read(&path).map_err(|e| format!("读取文件失败: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&content))
}

// ==================== Clipboard ====================

#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    // Fallback: frontend already has navigator.clipboard.readText() as backup
    Err("剪贴板读取请使用 Web API navigator.clipboard.readText()".into())
}

// ==================== Power Save Blocker ====================

/// Static handle to the power save child process (caffeinate/systemd-inhibit).
static POWER_SAVE_CHILD: Mutex<Option<Child>> = Mutex::new(None);

/// Start preventing the system from sleeping while music is playing.
///
/// - macOS: spawns `caffeinate -dimsu` (prevents display, idle, sleep, disk)
/// - Linux: spawns `systemd-inhibit`
/// - Windows: uses `SetThreadExecutionState` via winapi
/// - Other: logs warning, no-op
#[tauri::command]
pub fn power_save_blocker_start() -> Result<(), String> {
    let mut guard = POWER_SAVE_CHILD.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(_)) => {}
            Err(_) => process_util::kill_and_wait(child),
        }
    }

    #[cfg(target_os = "macos")]
    {
        match std::process::Command::new("caffeinate")
            .args(["-dimsu"])
            .spawn()
        {
            Ok(child) => {
                eprintln!("[power-save] caffeinate started (pid={})", child.id());
                *guard = Some(child);
            }
            Err(e) => {
                eprintln!("[power-save] failed to start caffeinate: {}", e);
                // Non-fatal: continue without blocker
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        match std::process::Command::new("systemd-inhibit")
            .args([
                "--what=idle:sleep:handle-lid-switch",
                "--who=CeruMusic",
                "--why=Playing music",
                "--mode=block",
                "--no-pager",
            ])
            .spawn()
        {
            Ok(child) => {
                eprintln!("[power-save] systemd-inhibit started (pid={})", child.id());
                *guard = Some(child);
            }
            Err(e) => {
                eprintln!("[power-save] failed to start systemd-inhibit: {}", e);
                // Non-fatal
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        // Fallback: just log
        eprintln!("[power-save] Windows power save blocker requested");
    }

    Ok(())
}

/// Stop the power save blocker, kill the child process if any.
#[tauri::command]
pub fn power_save_blocker_stop() -> Result<(), String> {
    let mut guard = POWER_SAVE_CHILD.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        eprintln!("[power-save] blocker process {} stopping", child.id());
        process_util::kill_and_wait(&mut child);
    }
    Ok(())
}

// ==================== Directory Settings Extras ====================

#[tauri::command]
pub async fn directory_settings_select_cache_dir(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let path = rx
        .await
        .map_err(|_| "选择目录失败".to_string())?
        .ok_or_else(|| "用户取消选择".to_string())?;
    Ok(serde_json::json!({
        "success": true,
        "path": path.to_string()
    }))
}

#[tauri::command]
pub async fn directory_settings_select_download_dir(
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let path = rx
        .await
        .map_err(|_| "选择目录失败".to_string())?
        .ok_or_else(|| "用户取消选择".to_string())?;
    Ok(serde_json::json!({
        "success": true,
        "path": path.to_string()
    }))
}

// ==================== File Dialog ====================

/// Open a file selection dialog. Accepts Electron-compatible options:
/// `{ properties: ["openFile"], filters: [{ name, extensions: ["jpg",...] }] }`.
/// Returns list of selected file paths (empty if cancelled).
#[tauri::command]
pub fn dialog_open_file(
    app: tauri::AppHandle,
    args: Option<Vec<serde_json::Value>>,
) -> Result<Vec<String>, String> {
    let mut dialog = app.dialog().file();

    if let Some(args_list) = args {
        if let Some(opts) = args_list.into_iter().next() {
            if let Some(filters) = opts.get("filters").and_then(|f| f.as_array()) {
                for filter in filters {
                    let name = filter.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if let Some(exts) = filter.get("extensions").and_then(|e| e.as_array()) {
                        let extensions: Vec<&str> = exts
                            .iter()
                            .filter_map(|e| e.as_str())
                            .filter(|e| *e != "*")
                            .collect();
                        if !extensions.is_empty() {
                            dialog = dialog.add_filter(name, &extensions);
                        }
                    }
                }
            }
        }
    }

    let paths = dialog.blocking_pick_files();
    Ok(paths
        .unwrap_or_default()
        .into_iter()
        .map(|p| p.to_string())
        .collect())
}

#[tauri::command]
pub fn directory_settings_open_directory(dir_path: String) -> Result<serde_json::Value, String> {
    let p = Path::new(&dir_path);
    if !p.exists() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "目录不存在"
        }));
    }
    let result = {
        #[cfg(target_os = "macos")]
        {
            process_util::spawn_detached(std::process::Command::new("open").arg(&dir_path))
                .map_err(|e| format!("打开目录失败: {}", e))
        }
        #[cfg(target_os = "windows")]
        {
            process_util::spawn_detached(std::process::Command::new("explorer").arg(&dir_path))
                .map_err(|e| format!("打开目录失败: {}", e))
        }
        #[cfg(target_os = "linux")]
        {
            process_util::spawn_detached(std::process::Command::new("xdg-open").arg(&dir_path))
                .map_err(|e| format!("打开目录失败: {}", e))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            Err("不支持的操作系统".into())
        }
    };
    match result {
        Ok(()) => Ok(serde_json::json!({ "success": true })),
        Err(msg) => Ok(serde_json::json!({ "success": false, "message": msg })),
    }
}

#[tauri::command]
pub async fn directory_settings_get_directory_size(dir_path: String) -> Result<i64, String> {
    tokio::task::spawn_blocking(move || {
        let p = Path::new(&dir_path);
        if !p.exists() {
            return Err("目录不存在".into());
        }
        Ok(dir_size_recursive(p))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn dir_size_recursive(path: &Path) -> i64 {
    let mut total = 0i64;
    if let Ok(entries) = path.read_dir() {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    total += meta.len() as i64;
                } else if meta.is_dir() {
                    total += dir_size_recursive(&entry.path());
                }
            }
        }
    }
    total
}

// ==================== System Audio (stubs → helpful defaults) ====================

/// Prepare audio capture. In Tauri, frontend uses `navigator.mediaDevices.getUserMedia()`
/// directly. This stub exists for Electron compatibility.
#[tauri::command]
pub fn system_audio_prepare_capture() -> Result<(), String> {
    // In Tauri, the WebView supports getUserMedia directly.
    // Return success so frontend proceeds to use WebRTC.
    eprintln!(
        "[system-audio] prepare_capture: frontend will use navigator.mediaDevices.getUserMedia()"
    );
    Ok(())
}

/// Get default audio capture source ID.
/// Frontend uses `navigator.mediaDevices.enumerateDevices()` instead.
#[tauri::command]
pub fn system_audio_get_default_source_id() -> Result<String, String> {
    // Return empty; frontend falls back to WebRTC enumeration
    Ok(String::new())
}

/// Get all audio capture source IDs.
/// Frontend uses `navigator.mediaDevices.enumerateDevices()` instead.
#[tauri::command]
pub fn system_audio_get_all_source_ids() -> Result<Vec<String>, String> {
    // Return empty; frontend falls back to WebRTC enumeration
    Ok(Vec::new())
}

// ==================== Pending Deep-Link Queues ====================
// Static queues that accumulate IDs/codes from deep-link URLs before
// the frontend is ready to process them. Commands drain on each call.

static PENDING_SHARE_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING_PLAYLIST_SHARE_IDS: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING_LT_CODES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING_OPEN_PLAYLIST_FILES: Mutex<Vec<String>> = Mutex::new(Vec::new());
static PENDING_OAUTH_CALLBACKS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Push a song-share id to the pending queue (called from deep-link handler).
pub fn push_pending_share_id(id: String) {
    if let Ok(mut q) = PENDING_SHARE_IDS.lock() {
        if !q.contains(&id) {
            q.push(id);
        }
    }
}

/// Push a playlist-share id to the pending queue.
pub fn push_pending_playlist_share_id(id: String) {
    if let Ok(mut q) = PENDING_PLAYLIST_SHARE_IDS.lock() {
        if !q.contains(&id) {
            q.push(id);
        }
    }
}

/// Push an LT code to the pending queue.
pub fn push_pending_lt_code(code: String) {
    if let Ok(mut q) = PENDING_LT_CODES.lock() {
        if !q.contains(&code) {
            q.push(code);
        }
    }
}

/// Push an open-playlist file path to the pending queue.
pub fn push_pending_open_playlist_file(path: String) {
    if let Ok(mut q) = PENDING_OPEN_PLAYLIST_FILES.lock() {
        if !q.contains(&path) {
            q.push(path);
        }
    }
}

/// Push an OAuth callback URL to the pending queue.
pub fn push_pending_oauth_callback(url: String) {
    if let Ok(mut q) = PENDING_OAUTH_CALLBACKS.lock() {
        if !q.contains(&url) {
            q.push(url);
        }
    }
}

#[tauri::command]
pub fn get_pending_share_ids() -> Result<Vec<String>, String> {
    match PENDING_SHARE_IDS.lock() {
        Ok(mut q) => Ok(q.drain(..).collect()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn get_pending_playlist_share_ids() -> Result<Vec<String>, String> {
    match PENDING_PLAYLIST_SHARE_IDS.lock() {
        Ok(mut q) => Ok(q.drain(..).collect()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn get_pending_lt_codes() -> Result<Vec<String>, String> {
    match PENDING_LT_CODES.lock() {
        Ok(mut q) => Ok(q.drain(..).collect()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn get_pending_open_playlist_files() -> Result<Vec<String>, String> {
    match PENDING_OPEN_PLAYLIST_FILES.lock() {
        Ok(mut q) => Ok(q.drain(..).collect()),
        Err(_) => Ok(Vec::new()),
    }
}

#[tauri::command]
pub fn get_pending_oauth_callbacks() -> Result<Vec<String>, String> {
    match PENDING_OAUTH_CALLBACKS.lock() {
        Ok(mut q) => Ok(q.drain(..).collect()),
        Err(_) => Ok(Vec::new()),
    }
}

// ==================== Plugin Stubs ====================

#[tauri::command]
pub fn service_plugin_get_plugin_by_id(_id: String) -> Result<Option<serde_json::Value>, String> {
    Ok(None)
}

#[tauri::command]
pub fn service_plugin_load_all_plugins() -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub fn service_plugin_uninstall_plugin(_plugin_id: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn service_plugin_get_plugin_log(_plugin_id: String) -> Result<String, String> {
    Ok(String::new())
}

#[tauri::command]
pub fn service_plugin_get_plugin_type(_plugin_id: String) -> Result<String, String> {
    Ok("unknown".into())
}

#[tauri::command]
pub fn service_plugin_get_config_schema(_plugin_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub fn service_plugin_get_config(_plugin_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({}))
}

#[tauri::command]
pub fn service_plugin_save_config(
    _plugin_id: String,
    _config: serde_json::Value,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn service_plugin_test_connection(_plugin_id: String) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "success": false }))
}

#[tauri::command]
pub fn service_plugin_get_playlists(_plugin_id: String) -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub fn service_plugin_get_playlist_songs(
    _plugin_id: String,
    _playlist_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub fn service_plugin_import_to_local(
    _plugin_id: String,
    _playlist_id: String,
    _playlist_name: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "success": false,
        "message": "插件系统在 Tauri 版本中暂不可用"
    }))
}

#[tauri::command]
pub fn service_plugin_get_service_lyric(
    _plugin_id: String,
    _song_info: serde_json::Value,
) -> Result<Option<serde_json::Value>, String> {
    Ok(None)
}

// ==================== AI Commands ====================

/// OpenAI-compatible chat completion.
/// Expects args: { prompt, config: { apiKey, baseURL, model } }
#[tauri::command]
pub async fn ai_ask(
    prompt: String,
    config: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let cfg = config.unwrap_or_default();

    let api_key = cfg
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = cfg
        .get("baseURL")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("deepseek-chat")
        .to_string();

    if api_key.is_empty() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "请先在设置中配置 AI API Key"
        }));
    }

    let url = format!("{}/v1/chat/completions", base_url);

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.7,
        "max_tokens": 2048
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Ok(serde_json::json!({
            "success": false,
            "message": format!("AI 服务返回错误 ({}): {}", status.as_u16(), text)
        }));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    // Extract content from OpenAI-compatible response
    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(serde_json::json!({
        "success": true,
        "data": content,
        "raw": json
    }))
}

/// AI streaming chat completion.
/// Emits `ai-stream-chunk`, `ai-stream-end`, `ai-stream-error` events.
#[tauri::command]
pub async fn ai_ask_stream(
    app: tauri::AppHandle,
    prompt: String,
    stream_id: String,
    config: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let cfg = config.unwrap_or_default();

    let api_key = cfg
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = cfg
        .get("baseURL")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("deepseek-chat")
        .to_string();

    if api_key.is_empty() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "请先在设置中配置 AI API Key"
        }));
    }

    let url = format!("{}/v1/chat/completions", base_url);

    let body = serde_json::json!({
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": 0.7,
        "max_tokens": 2048,
        "stream": true
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    match client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
    {
        Ok(resp) => {
            let status = resp.status();
            if !status.is_success() {
                let text = resp.text().await.unwrap_or_default();
                let _ = app.emit(
                    "ai-stream-error",
                    serde_json::json!({
                        "streamId": stream_id,
                        "error": format!("AI 服务返回错误 ({}): {}", status.as_u16(), text)
                    }),
                );
                let _ = app.emit(
                    "ai-stream-end",
                    serde_json::json!({ "streamId": stream_id }),
                );
                return Ok(serde_json::json!({ "success": false }));
            }

            use futures_util::StreamExt;
            let mut stream = resp.bytes_stream();

            while let Some(chunk_result) = stream.next().await {
                match chunk_result {
                    Ok(chunk) => {
                        let text = String::from_utf8_lossy(&chunk);
                        // SSE format: "data: {...}\n\n"
                        for line in text.lines() {
                            let line = line.trim();
                            if line.is_empty() || line == "data: [DONE]" {
                                continue;
                            }
                            if let Some(json_str) = line.strip_prefix("data: ") {
                                if let Ok(sse_data) =
                                    serde_json::from_str::<serde_json::Value>(json_str)
                                {
                                    if let Some(content) = sse_data
                                        .pointer("/choices/0/delta/content")
                                        .and_then(|v| v.as_str())
                                    {
                                        let _ = app.emit(
                                            "ai-stream-chunk",
                                            serde_json::json!({
                                                "streamId": stream_id,
                                                "content": content
                                            }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let _ = app.emit(
                            "ai-stream-error",
                            serde_json::json!({
                                "streamId": stream_id,
                                "error": format!("流式读取错误: {}", e)
                            }),
                        );
                        break;
                    }
                }
            }

            let _ = app.emit(
                "ai-stream-end",
                serde_json::json!({ "streamId": stream_id }),
            );

            Ok(serde_json::json!({ "success": true }))
        }
        Err(e) => {
            let _ = app.emit(
                "ai-stream-error",
                serde_json::json!({
                    "streamId": stream_id,
                    "error": format!("AI 请求失败: {}", e)
                }),
            );
            let _ = app.emit(
                "ai-stream-end",
                serde_json::json!({ "streamId": stream_id }),
            );
            Ok(serde_json::json!({ "success": false }))
        }
    }
}

/// AI song recommendation.
/// Calls AI to recommend similar songs based on the current song.
#[tauri::command]
pub async fn ai_recommend_songs(
    song_name: String,
    artist: String,
    context: Option<serde_json::Value>,
    config: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let cfg = config.unwrap_or_default();

    let api_key = cfg
        .get("apiKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let base_url = cfg
        .get("baseURL")
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| "https://api.deepseek.com".to_string());
    let model = cfg
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("deepseek-chat")
        .to_string();

    if api_key.is_empty() {
        return Ok(serde_json::json!({
            "success": false,
            "message": "请先在设置中配置 AI API Key"
        }));
    }

    // Build the prompt for song recommendation
    let system_prompt =
        "你是一位专业的音乐推荐AI。根据用户提供的歌曲信息，推荐10首风格相似的音乐。\
        请以JSON数组格式返回，每首歌曲包含：name（歌曲名）, artist（歌手）, reason（推荐理由）。\
        请确保推荐的歌曲风格、节奏、氛围与原曲相似。\
        只返回JSON数组，不要用markdown代码块包裹。";

    let user_prompt = format!(
        "歌曲名称：{}\n歌手：{}\n{}",
        song_name,
        artist,
        context
            .as_ref()
            .map(|c| format!(
                "额外上下文：{}",
                serde_json::to_string(c).unwrap_or_default()
            ))
            .unwrap_or_default()
    );

    let url = format!("{}/v1/chat/completions", base_url);

    let body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ],
        "temperature": 0.8,
        "max_tokens": 4096
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("AI 请求失败: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if !status.is_success() {
        return Ok(serde_json::json!({
            "success": false,
            "message": format!("AI 服务返回错误 ({}): {}", status.as_u16(), text)
        }));
    }

    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    let content = json
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .unwrap_or("[]");

    // Try to parse the content as JSON array
    let recommendations: Vec<serde_json::Value> =
        serde_json::from_str(content).unwrap_or_else(|_| {
            // If parsing fails, try to extract JSON from markdown code blocks
            if let Some(json_start) = content.find('[') {
                if let Some(json_end) = content.rfind(']') {
                    serde_json::from_str(&content[json_start..=json_end]).unwrap_or_default()
                } else {
                    Vec::new()
                }
            } else {
                Vec::new()
            }
        });

    Ok(serde_json::json!({
        "success": true,
        "data": {
            "songs": recommendations,
            "total": recommendations.len()
        }
    }))
}

// ==================== Share Stubs ====================

/// 返回应用版本号。
///
/// 唯一来源是根目录 `package.json` 的 `version` 字段：`tauri.conf.json` 的
/// `version` 指向 `../package.json`，Tauri 在编译期把它解析进 `package_info`。
/// 因此只需在 `package.json` 改一处，关于页、安装包版本会一起更新。
#[tauri::command]
pub fn get_app_version(app: tauri::AppHandle) -> Result<String, String> {
    Ok(app.package_info().version.to_string())
}

/// Return a list of available system fonts.
///
/// 关键：必须 async + `spawn_blocking`。字体枚举在 macOS 上可能非常慢
/// （实测本机 `system_profiler SPFontsDataType` 约 24 秒），而同步命令跑在
/// 主线程上，会把整个界面冻住 —— 进入设置（默认"外观"分类挂载
/// `LyricFontSettings`）时表现为长时间转圈、点不动。
#[tauri::command]
pub async fn get_font_list() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(get_system_fonts)
        .await
        .map_err(|e| format!("字体枚举失败: {e}"))
}

/// Best-effort system font enumeration.
fn get_system_fonts() -> Vec<String> {
    // Try platform-specific font enumeration
    #[cfg(target_os = "macos")]
    {
        // 首选 CoreText：毫秒级返回真实字族名，不启动子进程。
        let families = macos_font_families();
        if !families.is_empty() {
            return families;
        }
        let result = try_fc_list();
        if !result.is_empty() {
            return result;
        }
        // 最后兜底：system_profiler 极慢（实测约 24 秒，且可能返回空），
        // 只在 CoreText / fc-list 都拿不到时才用。
        let result = try_macos_system_profiler();
        if !result.is_empty() {
            return result;
        }
    }

    #[cfg(target_os = "linux")]
    {
        let result = try_fc_list();
        if !result.is_empty() {
            return result;
        }
    }

    // Universal fallback: common fonts
    get_fallback_font_list()
}

/// macOS: enumerate real font family names through CoreText.
///
/// `CTFontManagerCopyAvailableFontFamilyNames` 是单次 C 调用，返回 CFArray，
/// 中文/英文字族名都完整，耗时远低于解析字体目录或调用 system_profiler。
#[cfg(target_os = "macos")]
fn macos_font_families() -> Vec<String> {
    use std::ffi::{c_void, CStr};
    use std::os::raw::c_char;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerCopyAvailableFontFamilyNames() -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> bool;
        fn CFStringGetLength(string: *const c_void) -> isize;
        fn CFRelease(cf: *const c_void);
    }

    // kCFStringEncodingUTF8
    const CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    let mut families: Vec<String> = Vec::new();
    unsafe {
        let array = CTFontManagerCopyAvailableFontFamilyNames();
        if array.is_null() {
            return families;
        }
        let count = CFArrayGetCount(array);
        for index in 0..count {
            let value = CFArrayGetValueAtIndex(array, index);
            if value.is_null() {
                continue;
            }
            let length = CFStringGetLength(value);
            if length <= 0 {
                continue;
            }
            // UTF-8 最多 4 字节/字符，额外留 1 字节给 NUL。
            let capacity = (length as usize).saturating_mul(4) + 1;
            let mut buffer: Vec<c_char> = vec![0; capacity];
            let converted = CFStringGetCString(
                value,
                buffer.as_mut_ptr(),
                capacity as isize,
                CF_STRING_ENCODING_UTF8,
            );
            if !converted {
                continue;
            }
            let name = CStr::from_ptr(buffer.as_ptr())
                .to_string_lossy()
                .trim()
                .to_string();
            if !name.is_empty() {
                families.push(name);
            }
        }
        CFRelease(array);
    }

    families.sort();
    families.dedup();
    families
}

/// Execute `fc-list --format=%{family}\\n` and parse results.
fn try_fc_list() -> Vec<String> {
    let output = match std::process::Command::new("fc-list")
        .args(["--format=%{family}\n"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut fonts: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .flat_map(|l| {
            // fc-list returns comma-separated families
            l.split(',')
                .map(|s| s.trim().to_string())
                .collect::<Vec<_>>()
        })
        .filter(|f| !f.is_empty())
        .collect();

    fonts.sort();
    fonts.dedup();
    fonts
}

/// macOS-specific: parse `system_profiler SPFontsDataType` output.
#[cfg(target_os = "macos")]
fn try_macos_system_profiler() -> Vec<String> {
    let output = match std::process::Command::new("system_profiler")
        .args(["SPFontsDataType", "-json"])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };

    if !output.status.success() {
        return Vec::new();
    }

    let text = String::from_utf8_lossy(&output.stdout);
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(items) = json.get("SPFontsDataType").and_then(|v| v.as_array()) {
            let mut fonts: Vec<String> = items
                .iter()
                .filter_map(|item| item.get("family").and_then(|v| v.as_str()))
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .collect();
            fonts.sort();
            fonts.dedup();
            return fonts;
        }
    }

    Vec::new()
}

/// Hardcoded fallback font list (common Chinese + English fonts).
fn get_fallback_font_list() -> Vec<String> {
    vec![
        // Common Chinese fonts
        "PingFangSC-Regular".into(),
        "PingFangSC-Medium".into(),
        "PingFangSC-Semibold".into(),
        "PingFangSC-Light".into(),
        "PingFangSC-Thin".into(),
        "PingFangSC-Ultralight".into(),
        "STHeiti".into(),
        "STKaiti".into(),
        "STSong".into(),
        "STFangsong".into(),
        "Microsoft YaHei".into(),
        "Microsoft YaHei UI".into(),
        "SimHei".into(),
        "SimSun".into(),
        "FangSong".into(),
        "KaiTi".into(),
        "Source Han Sans SC".into(),
        "Noto Sans SC".into(),
        "Noto Sans CJK SC".into(),
        "Noto Serif SC".into(),
        // Common English fonts
        "Arial".into(),
        "Helvetica".into(),
        "Helvetica Neue".into(),
        "San Francisco".into(),
        "SF Pro".into(),
        "SF Pro Display".into(),
        "SF Pro Text".into(),
        "Times New Roman".into(),
        "Georgia".into(),
        "Verdana".into(),
        "Tahoma".into(),
        "Trebuchet MS".into(),
        "Courier New".into(),
        "Impact".into(),
        "Comic Sans MS".into(),
        "Segoe UI".into(),
        "Roboto".into(),
        "Open Sans".into(),
        "Lato".into(),
        "Montserrat".into(),
        "Merriweather".into(),
        "Playfair Display".into(),
        // Latex-like font
        "lyricfont".into(),
        // Chinese handwriting / decorative
        "ZCOOL QingKe HuangYou".into(),
        "Ma Shan Zheng".into(),
        "Liu Jian Mao Cao".into(),
        "ZCOOL KuaiLe".into(),
        "Dancing Script".into(),
    ]
}

#[tauri::command]
pub fn service_share_get_plugin_code_and_md5(
    _plugin_id: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "code": "", "md5": "" }))
}

// ==================== App Flags (key-value storage, persisted via settings table) ====================

/// Set an app-level flag.
#[tauri::command]
pub fn app_flag_set(
    db: tauri::State<'_, Database>,
    key: String,
    value: String,
) -> Result<(), String> {
    db.set_setting(&key, &value);
    Ok(())
}

/// Get an app-level flag.
#[tauri::command]
pub fn app_flag_get(db: tauri::State<'_, Database>, key: String) -> Result<Option<String>, String> {
    Ok(db.get_setting(&key))
}

// ==================== Mac Status Bar Lyric ====================

/// Enable or disable the macOS status bar lyric display.
/// Persists to DB and updates the tray icon behavior.
#[tauri::command]
pub fn set_mac_status_bar_lyric(
    app: tauri::AppHandle,
    db: tauri::State<'_, Database>,
    enabled: bool,
) -> Result<(), String> {
    db.set_setting(
        "mac_status_bar_lyric",
        if enabled { "true" } else { "false" },
    );
    let _ = app.emit("mac-status-bar-lyric-changed", enabled);
    eprintln!(
        "[mac-status-bar] lyric display {}",
        if enabled { "enabled" } else { "disabled" }
    );
    Ok(())
}

/// Get the current mac status bar lyric setting.
#[tauri::command]
pub fn get_mac_status_bar_lyric(db: tauri::State<'_, Database>) -> Result<bool, String> {
    let val = db.get_setting("mac_status_bar_lyric");
    Ok(val.as_deref() == Some("true"))
}
