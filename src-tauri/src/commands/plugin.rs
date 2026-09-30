//! Plugin proxy commands for frontend-based plugin sandbox.
//!
//! The sandbox itself runs in the WebView (frontend) since we cannot
//! embed a JS runtime in Rust without network access to fetch crate
//! dependencies. These Rust commands act as:
//!
//! - HTTP proxy: `cerumusic.request()` → invoke("plugin_http_request", ...)
//! - Crypto proxy: `cerumusic.utils.crypto.*` → invoke("plugin_crypto_*", ...)
//! - File reader: load plugin JS content from disk

use base64::Engine;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

fn content_type_to_image_mime(content_type: Option<&str>, url: &str) -> &'static str {
    let content_type = content_type.unwrap_or("").to_ascii_lowercase();
    if content_type.contains("image/png") || url.to_ascii_lowercase().contains(".png") {
        "image/png"
    } else if content_type.contains("image/webp") || url.to_ascii_lowercase().contains(".webp") {
        "image/webp"
    } else if content_type.contains("image/gif") || url.to_ascii_lowercase().contains(".gif") {
        "image/gif"
    } else {
        "image/jpeg"
    }
}

#[tauri::command]
pub async fn image_url_to_data_url(
    url: String,
    headers: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.starts_with("data:") || trimmed.starts_with("blob:") || trimmed.starts_with("file:")
    {
        return Ok(trimmed.to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let mut request = client
        .get(trimmed)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Referer", "https://y.qq.com/");

    if let Some(headers) = headers {
        for (name, value) in headers {
            request = request.header(name, value);
        }
    }

    let resp = request
        .send()
        .await
        .map_err(|e| format!("请求图片失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("请求图片失败: HTTP {}", resp.status().as_u16()));
    }

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    if let Some(content_type) = content_type.as_deref() {
        let lowered = content_type.to_ascii_lowercase();
        if lowered.contains("application/json")
            || lowered.contains("text/html")
            || lowered.contains("text/plain")
        {
            return Err(format!("请求图片失败: 响应不是图片 ({})", content_type));
        }
    }
    let mime = content_type_to_image_mime(content_type.as_deref(), trimmed);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取图片失败: {}", e))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

// ---------------------------------------------------------------------------
// HTTP Proxy
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct HttpRequestOptions {
    pub method: Option<String>,
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub body: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct HttpResponse {
    pub body: String,
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
}

/// Proxy HTTP request for plugin sandbox (cerumusic.request).
#[tauri::command]
pub async fn plugin_http_request(
    url: String,
    options: Option<HttpRequestOptions>,
) -> Result<HttpResponse, String> {
    let opts = options.unwrap_or(HttpRequestOptions {
        method: None,
        headers: None,
        body: None,
        timeout: None,
    });

    let method = opts.method.as_deref().unwrap_or("GET");
    let timeout_secs = opts.timeout.unwrap_or(15);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let mut req = match method.to_uppercase().as_str() {
        "POST" => {
            let body_bytes = opts.body.unwrap_or_default().into_bytes();
            client.post(&url).body(body_bytes)
        }
        "PUT" => {
            let body_bytes = opts.body.unwrap_or_default().into_bytes();
            client.put(&url).body(body_bytes)
        }
        "DELETE" => client.delete(&url),
        _ => client.get(&url),
    };

    req = req.header(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    );

    if let Some(headers) = &opts.headers {
        for (k, v) in headers {
            req = req.header(k.as_str(), v.as_str());
        }
    }

    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status().as_u16();
    let resp_headers: std::collections::HashMap<String, String> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let body = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    Ok(HttpResponse {
        body,
        status,
        headers: resp_headers,
    })
}

// ---------------------------------------------------------------------------
// Crypto Proxy
// ---------------------------------------------------------------------------

/// MD5 hash (hex string)
#[tauri::command]
pub fn plugin_crypto_md5(data: String) -> String {
    let hash = Md5::digest(data.as_bytes());
    format!("{:x}", hash)
}

/// Generate random bytes, base64-encoded.
/// Uses uuid::Uuid v4 (backed by getrandom) to fill the buffer.
#[tauri::command]
pub fn plugin_crypto_random_bytes(size: u32) -> String {
    let mut buf = vec![0u8; size as usize];
    for chunk in buf.chunks_mut(16) {
        let uuid = uuid::Uuid::new_v4();
        let len = chunk.len().min(16);
        chunk.copy_from_slice(&uuid.as_bytes()[..len]);
    }
    base64::engine::general_purpose::STANDARD.encode(&buf)
}

/// AES-128-CBC / AES-128-ECB encrypt.
/// NOTE: requires `aes` and `cbc` crates which are not yet fetched.
/// Stub returns an error until network is available.
#[tauri::command]
pub fn plugin_crypto_aes_encrypt(
    _data: String,
    _key: String,
    _mode: Option<String>,
    _iv: Option<String>,
) -> Result<String, String> {
    Err(
        "AES 加密依赖 (aes, cbc) 未安装。请在有网络时运行: cd src-tauri && cargo add aes cbc"
            .into(),
    )
}

/// Base64 encode
#[tauri::command]
pub fn plugin_crypto_base64_encode(data: String) -> String {
    base64::engine::general_purpose::STANDARD.encode(data.as_bytes())
}

/// Base64 decode
#[tauri::command]
pub fn plugin_crypto_base64_decode(data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    String::from_utf8(bytes).map_err(|e| format!("Base64 解码结果不是有效 UTF-8: {}", e))
}

// ---------------------------------------------------------------------------
// Plugin File Loader
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
pub struct PluginFileEntry {
    pub path: String,
    pub name: String,
    pub content: String,
}

/// Scan a directory for `.js` plugin files and read their contents.
#[tauri::command]
pub fn plugin_scan_dir(dir: String) -> Result<Vec<PluginFileEntry>, String> {
    let dir_path = PathBuf::from(&dir);
    if !dir_path.is_dir() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let walker = walkdir::WalkDir::new(&dir_path)
        .max_depth(1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file());

    for entry in walker {
        let path = entry.path();
        if path.extension().map(|e| e == "js").unwrap_or(false) {
            let content = fs::read_to_string(path).map_err(|e| format!("读取插件失败: {}", e))?;
            entries.push(PluginFileEntry {
                path: path.to_string_lossy().to_string(),
                name: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                content,
            });
        }
    }

    Ok(entries)
}

/// Read a single plugin file by path.
#[tauri::command]
pub fn plugin_read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// Write a plugin JS file to the plugins directory (creates dir if needed).
/// This bypasses the JS-side FS permission scope, ensuring plugins can always be persisted.
#[tauri::command]
pub fn plugin_write_file(
    app: tauri::AppHandle,
    plugin_id: String,
    code: String,
) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {}", e))?;
    let plugins_dir = app_data.join("plugins");
    std::fs::create_dir_all(&plugins_dir).map_err(|e| format!("创建插件目录失败: {}", e))?;
    let file_path = plugins_dir.join(format!("{}.js", plugin_id));
    std::fs::write(&file_path, code).map_err(|e| format!("写入插件文件失败: {}", e))?;
    Ok(())
}

/// Get the app data directory path (where plugins/ folder lives).
#[tauri::command]
pub fn plugin_get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取数据目录失败: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Plugin Persistence — 通过 DB 持久化插件注册信息和配置
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn plugin_save_registry(
    db: tauri::State<'_, crate::db::Database>,
    id: String,
    name: String,
    plugin_type: String,
    version: String,
    author: String,
    description: String,
    enabled: bool,
) -> Result<(), String> {
    let info = crate::models::PluginInfo {
        id,
        name,
        plugin_type,
        version,
        author,
        description,
        enabled,
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    db.insert_plugin(&info)
}

#[tauri::command]
pub fn plugin_load_registry(
    db: tauri::State<'_, crate::db::Database>,
) -> Result<Vec<crate::models::PluginInfo>, String> {
    Ok(db.list_plugins())
}

#[tauri::command]
pub fn plugin_remove_registry(
    db: tauri::State<'_, crate::db::Database>,
    id: String,
) -> Result<(), String> {
    db.delete_plugin(&id)
}

#[tauri::command]
pub fn plugin_reorder_registry(
    db: tauri::State<'_, crate::db::Database>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    db.reorder_plugins(&ordered_ids)
}

#[tauri::command]
pub fn plugin_save_config(
    db: tauri::State<'_, crate::db::Database>,
    plugin_id: String,
    config: String,
) -> Result<(), String> {
    db.set_plugin_config(&plugin_id, &config)
}

#[tauri::command]
pub fn plugin_load_config(
    db: tauri::State<'_, crate::db::Database>,
    plugin_id: String,
) -> Result<Option<String>, String> {
    Ok(db.get_plugin_config(&plugin_id))
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn service_plugin_select_and_add_plugin(r#type: String) -> Result<serde_json::Value, String> {
    let _ = r#type;
    Ok(serde_json::json!({
        "success": false,
        "message": "请使用前端插件管理页面添加插件"
    }))
}

#[tauri::command]
pub fn service_plugin_download_and_add_plugin(
    url: String,
    r#type: String,
    target_plugin_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = (url, r#type, target_plugin_id);
    Ok(serde_json::json!({
        "success": false,
        "message": "请使用前端插件管理页面添加插件"
    }))
}

#[tauri::command]
pub fn service_plugin_add_plugin(
    plugin_code: String,
    plugin_name: String,
    target_plugin_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let _ = (plugin_code, plugin_name, target_plugin_id);
    Ok(serde_json::json!({
        "success": false,
        "message": "请使用前端插件管理页面添加插件"
    }))
}

#[tauri::command]
pub fn service_plugin_initialize_system() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "initialized": true,
        "mode": "frontend-sandbox",
        "message": "插件系统通过前端沙箱运行"
    }))
}

// Re-export remaining stubs from misc.rs or just keep them there.
// The commands that return static data (getPluginById, loadAllPlugins, etc.)
// can remain in misc.rs since they just return empty/safe values.
