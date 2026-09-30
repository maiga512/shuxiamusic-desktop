//! Local cover proxy for header-authenticated artwork.
//!
//! Electron injects `Cookie: music-token` via `session.webRequest` so a normal
//! `<img src="https://.../music/api/v1/...">` works. Tauri WebView cannot attach
//! those headers, so the previous adapter converted every Feiniu cover into a
//! data URL. That bypasses HTTP cache: virtual-list rows reload the same cover
//! on every scroll, and the dock `<img>` never goes through `sImage`.
//!
//! This adapter keeps the Electron product flow (`<img src>` + browser cache)
//! and only replaces the missing session-header layer with a stable local URL:
//! `http://127.0.0.1:<port>/cover/<url-safe-base64>`.
//!
//! WKWebView's HTTP cache for loopback is unreliable, so the proxy also keeps a
//! small in-memory LRU of image bytes. Scroll-back and the dock can reuse the
//! same cover without waiting on Feiniu again.

use base64::Engine;
use serde_json::Value;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const FEINIU_API_PATH: &str = "/music/api/v1/";
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const MAX_CACHE_ITEMS: usize = 48;
const MAX_CACHE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CACHED_COVER_BYTES: usize = 4 * 1024 * 1024;
const DISK_CACHE_DIR: &str = "cover-cache";
// 磁盘封面缓存容量上限（约 200MB），超出后按最久未用清理，另删除超期文件。
const MAX_DISK_CACHE_BYTES: u64 = 200 * 1024 * 1024;
const DISK_CACHE_TARGET_BYTES: u64 = 180 * 1024 * 1024;
const DISK_CACHE_MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;
const DISK_PRUNE_INTERVAL_SECS: u64 = 60;

static LAST_DISK_PRUNE_AT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct CachedCover {
    bytes: Arc<[u8]>,
    content_type: String,
    etag: String,
}

struct CoverCache {
    map: HashMap<String, CachedCover>,
    lru: VecDeque<String>,
    total_bytes: usize,
}

impl CoverCache {
    fn new() -> Self {
        Self {
            map: HashMap::new(),
            lru: VecDeque::new(),
            total_bytes: 0,
        }
    }

    fn touch(&mut self, key: &str) {
        if let Some(pos) = self.lru.iter().position(|item| item == key) {
            if let Some(item) = self.lru.remove(pos) {
                self.lru.push_back(item);
            }
        }
    }

    fn get(&mut self, key: &str) -> Option<CachedCover> {
        if !self.map.contains_key(key) {
            return None;
        }
        self.touch(key);
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: String, cover: CachedCover) {
        if cover.bytes.is_empty() || cover.bytes.len() > MAX_CACHED_COVER_BYTES {
            return;
        }
        if let Some(old) = self.map.remove(&key) {
            self.total_bytes = self.total_bytes.saturating_sub(old.bytes.len());
            if let Some(pos) = self.lru.iter().position(|item| item == &key) {
                self.lru.remove(pos);
            }
        }
        while !self.lru.is_empty()
            && (self.map.len() >= MAX_CACHE_ITEMS
                || self.total_bytes + cover.bytes.len() > MAX_CACHE_BYTES)
        {
            if let Some(evict) = self.lru.pop_front() {
                if let Some(old) = self.map.remove(&evict) {
                    self.total_bytes = self.total_bytes.saturating_sub(old.bytes.len());
                }
            }
        }
        self.total_bytes = self.total_bytes.saturating_add(cover.bytes.len());
        self.lru.push_back(key.clone());
        self.map.insert(key, cover);
    }
}

fn sha1_hex(input: &str) -> String {
    Sha1::digest(input.as_bytes())
        .iter()
        .map(|byte| format!("{:02x}", byte))
        .collect()
}

fn cover_disk_paths(app_data_dir: &Path, key: &str) -> (PathBuf, PathBuf) {
    let dir = app_data_dir.join(DISK_CACHE_DIR);
    let name = sha1_hex(key);
    (
        dir.join(format!("{name}.bin")),
        dir.join(format!("{name}.meta")),
    )
}

fn read_disk_cover(app_data_dir: &Path, key: &str) -> Option<CachedCover> {
    let (bin_path, meta_path) = cover_disk_paths(app_data_dir, key);
    let meta_text = fs::read_to_string(meta_path).ok()?;
    let meta: Value = serde_json::from_str(&meta_text).ok()?;
    let content_type = meta.get("content_type")?.as_str()?.to_string();
    let etag = meta.get("etag")?.as_str()?.to_string();
    let bytes = fs::read(&bin_path).ok()?;
    if bytes.is_empty() || bytes.len() > MAX_CACHED_COVER_BYTES {
        return None;
    }
    // 命中即刷新 mtime，让容量清理把最近使用的封面视为最新，实现近似 LRU。
    touch_disk_cover(&bin_path);
    Some(CachedCover {
        bytes: Arc::from(bytes.into_boxed_slice()),
        content_type,
        etag,
    })
}

fn write_disk_cover(app_data_dir: &Path, key: &str, cover: &CachedCover) {
    let dir = app_data_dir.join(DISK_CACHE_DIR);
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (bin_path, meta_path) = cover_disk_paths(app_data_dir, key);
    let meta = serde_json::json!({
        "content_type": cover.content_type,
        "etag": cover.etag,
        "size": cover.bytes.len(),
    });
    let _ = fs::write(bin_path, cover.bytes.as_ref());
    let _ = fs::write(meta_path, meta.to_string());
    maybe_prune_disk_cache(&dir);
}

fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn touch_disk_cover(bin_path: &Path) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(bin_path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

fn maybe_prune_disk_cache(dir: &Path) {
    let now = now_unix_secs();
    let last = LAST_DISK_PRUNE_AT.load(Ordering::Relaxed);
    if now.saturating_sub(last) < DISK_PRUNE_INTERVAL_SECS {
        return;
    }
    if LAST_DISK_PRUNE_AT
        .compare_exchange(last, now, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return;
    }
    prune_disk_cache(dir);
}

fn prune_disk_cache(dir: &Path) {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    struct DiskEntry {
        bin: PathBuf,
        meta: PathBuf,
        size: u64,
        modified: SystemTime,
    }
    let now = SystemTime::now();
    let mut items: Vec<DiskEntry> = Vec::new();
    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let bin = entry.path();
        if bin.extension().and_then(|value| value.to_str()) != Some("bin") {
            continue;
        }
        let Ok(meta_data) = fs::metadata(&bin) else {
            continue;
        };
        let modified = meta_data.modified().unwrap_or(now);
        let meta = bin.with_extension("meta");
        if let Ok(age) = now.duration_since(modified) {
            if age.as_secs() > DISK_CACHE_MAX_AGE_SECS {
                let _ = fs::remove_file(&bin);
                let _ = fs::remove_file(&meta);
                continue;
            }
        }
        total = total.saturating_add(meta_data.len());
        items.push(DiskEntry {
            bin,
            meta,
            size: meta_data.len(),
            modified,
        });
    }
    if total <= MAX_DISK_CACHE_BYTES {
        return;
    }
    items.sort_by_key(|item| item.modified);
    for item in items {
        if total <= DISK_CACHE_TARGET_BYTES {
            break;
        }
        let _ = fs::remove_file(&item.bin);
        let _ = fs::remove_file(&item.meta);
        total = total.saturating_sub(item.size);
    }
}

struct CoverProxyServer {
    addr: SocketAddr,
    app_data_dir: PathBuf,
    client: reqwest::Client,
    runtime: tokio::runtime::Runtime,
    cache: Mutex<CoverCache>,
}

struct FeiniuAuth {
    origin: String,
    token: String,
    access_code: String,
}

static COVER_PROXY: OnceLock<CoverProxyServer> = OnceLock::new();

fn encode_cover_token(url: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url.as_bytes())
}

fn decode_cover_token(token: &str) -> Option<String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.as_bytes())
        .ok()?;
    String::from_utf8(bytes).ok()
}

fn etag_for_bytes(bytes: &[u8]) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    format!("\"{:x}-{}\"", hasher.finish(), bytes.len())
}

fn cover_cache_key(url: &str, edge: Option<u32>) -> String {
    match edge {
        Some(edge) => format!("{url}|e{edge}"),
        None => url.to_string(),
    }
}

fn parse_cover_edge(path: &str) -> Option<u32> {
    let query = path.split_once('?')?.1;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if key != "edge" {
            continue;
        }
        let edge = value.parse::<u32>().ok()?;
        if (32..=512).contains(&edge) {
            return Some(edge);
        }
    }
    None
}

fn downscale_cover_bytes(bytes: &[u8], edge: u32) -> Option<(Vec<u8>, String)> {
    let image = image::load_from_memory(bytes).ok()?;
    if image.width() <= edge && image.height() <= edge {
        return None;
    }
    let resized = image.thumbnail(edge, edge);
    let mut out = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut out);
        resized
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .ok()?;
    }
    Some((out, "image/jpeg".to_string()))
}

fn build_feiniu_origin(config: &Value) -> Option<String> {
    let raw_host = config.get("host")?.as_str()?.trim();
    if raw_host.is_empty() {
        return None;
    }
    let use_https = config
        .get("useHttps")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let protocol = if use_https { "https" } else { "http" };
    let url_text = if raw_host.starts_with("http://") || raw_host.starts_with("https://") {
        raw_host.to_string()
    } else {
        format!("{}://{}", protocol, raw_host)
    };
    let mut parsed = reqwest::Url::parse(&url_text).ok()?;
    if parsed.port().is_none() {
        let port = config.get("port").and_then(Value::as_u64).or_else(|| {
            config
                .get("port")
                .and_then(Value::as_i64)
                .map(|value| value as u64)
        });
        if let Some(port) = port.filter(|value| *value > 0 && *value <= u16::MAX as u64) {
            let _ = parsed.set_port(Some(port as u16));
        }
    }
    Some(parsed.origin().ascii_serialization())
}

fn load_feiniu_auths(app_data_dir: &Path) -> Vec<FeiniuAuth> {
    let config_dir = app_data_dir.join("plugins").join("config");
    let entries = match fs::read_dir(&config_dir) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut auths = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(config) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let Some(origin) = build_feiniu_origin(&config) else {
            continue;
        };
        let token = config
            .get("token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if token.is_empty() {
            continue;
        }
        auths.push(FeiniuAuth {
            origin,
            token,
            access_code: config
                .get("accessCode")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
    }
    auths
}

fn feiniu_headers_for(app_data_dir: &Path, target: &reqwest::Url) -> Option<Vec<(String, String)>> {
    if !target.path().contains(FEINIU_API_PATH) && !target.as_str().contains(FEINIU_API_PATH) {
        return None;
    }
    let origin = target.origin().ascii_serialization();
    let auth = load_feiniu_auths(app_data_dir)
        .into_iter()
        .find(|item| item.origin == origin)?;
    let mut headers = vec![
        ("Cookie".to_string(), format!("music-token={}", auth.token)),
        (
            "Accept".to_string(),
            "image/avif,image/webp,image/apng,image/*,*/*;q=0.8".to_string(),
        ),
        ("Referer".to_string(), format!("{}/", origin)),
    ];
    let access_code = auth.access_code.trim();
    if !access_code.is_empty() {
        headers.push((
            "x-access-code".to_string(),
            base64::engine::general_purpose::STANDARD.encode(access_code.as_bytes()),
        ));
        headers.push(("x-access-source".to_string(), "app".to_string()));
    }
    Some(headers)
}

fn server(app_data_dir: PathBuf) -> Result<&'static CoverProxyServer, String> {
    if let Some(server) = COVER_PROXY.get() {
        return Ok(server);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("启动本地封面代理失败: {}", error))?;
    listener
        .set_nonblocking(false)
        .map_err(|error| format!("配置本地封面代理失败: {}", error))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("读取本地封面代理地址失败: {}", error))?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|error| format!("创建本地封面代理运行时失败: {}", error))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(20))
        .danger_accept_invalid_certs(true)
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|error| format!("创建本地封面代理 HTTP 客户端失败: {}", error))?;

    let server = CoverProxyServer {
        addr,
        app_data_dir,
        client,
        runtime,
        cache: Mutex::new(CoverCache::new()),
    };
    let _ = COVER_PROXY.set(server);
    let server_ref = COVER_PROXY
        .get()
        .ok_or_else(|| "本地封面代理初始化失败".to_string())?;

    {
        let prune_dir = server_ref.app_data_dir.join(DISK_CACHE_DIR);
        thread::spawn(move || {
            LAST_DISK_PRUNE_AT.store(now_unix_secs(), Ordering::Relaxed);
            prune_disk_cache(&prune_dir);
        });
    }

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    thread::spawn(move || {
                        let _ = handle_client(stream);
                    });
                }
                Err(error) => {
                    eprintln!("[cover-proxy] accept failed: {}", error);
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });

    Ok(server_ref)
}

fn is_local_cover_proxy_url(url: &str) -> bool {
    (url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:"))
        && url.contains("/cover/")
}

pub fn ensure_cover_proxy(app: tauri::AppHandle) -> Result<SocketAddr, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("获取数据目录失败: {}", error))?;
    Ok(server(app_data_dir)?.addr)
}

#[tauri::command]
pub fn cover_proxy_base(app: tauri::AppHandle) -> Result<String, String> {
    let addr = ensure_cover_proxy(app)?;
    Ok(format!("http://{}", addr))
}

#[tauri::command]
pub fn cover_proxy_url(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.starts_with("data:")
        || trimmed.starts_with("blob:")
        || trimmed.starts_with("file:")
        || is_local_cover_proxy_url(trimmed)
    {
        return Ok(trimmed.to_string());
    }
    if !trimmed.contains(FEINIU_API_PATH) {
        // 私有飞牛封面永远走代理（需要鉴权头）；其余公共封面也统一走代理，
        // 以复用内存 + 磁盘缓存，避免每次进页面都从 CDN 重新下载。
        let is_cleartext_http = trimmed.starts_with("http://")
            && !trimmed.starts_with("http://127.0.0.1:")
            && !trimmed.starts_with("http://localhost:");
        let is_public_https = trimmed.starts_with("https://");
        if !is_cleartext_http && !is_public_https {
            return Ok(trimmed.to_string());
        }
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Ok(trimmed.to_string());
    }

    let addr = ensure_cover_proxy(app)?;
    Ok(format!(
        "http://{}/cover/{}",
        addr,
        encode_cover_token(trimmed)
    ))
}

fn handle_client(mut stream: TcpStream) -> Result<(), String> {
    let request_text = read_http_request(&mut stream)?;
    let (method, path) = parse_http_request(&request_text)?;
    if method == "OPTIONS" {
        return write_cors_preflight(&mut stream);
    }
    if method != "GET" && method != "HEAD" {
        return write_simple_response(&mut stream, 405, "Method Not Allowed", "");
    }

    let token = path
        .strip_prefix("/cover/")
        .and_then(|value| value.split('?').next())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "无效封面代理路径".to_string())?;
    let Some(original_url) = decode_cover_token(token) else {
        return write_simple_response(&mut stream, 400, "Bad Request", "invalid cover token");
    };
    if !(original_url.starts_with("http://") || original_url.starts_with("https://")) {
        return write_simple_response(&mut stream, 400, "Bad Request", "invalid cover url");
    }

    let server = COVER_PROXY
        .get()
        .ok_or_else(|| "本地封面代理未启动".to_string())?;
    let if_none_match = header_value(&request_text, "If-None-Match");
    let head_only = method == "HEAD";

    let edge = parse_cover_edge(&path);
    let cache_key = cover_cache_key(&original_url, edge);

    if let Ok(mut cache) = server.cache.lock() {
        if let Some(cached) = cache.get(&cache_key) {
            if if_none_match
                .as_deref()
                .is_some_and(|value| etag_matches(value, &cached.etag))
            {
                return write_image_response(
                    &mut stream,
                    304,
                    "Not Modified",
                    &cached.content_type,
                    &cached.etag,
                    &[],
                    true,
                );
            }
            return write_image_response(
                &mut stream,
                200,
                "OK",
                &cached.content_type,
                &cached.etag,
                &*cached.bytes,
                head_only,
            );
        }
    }

    if let Some(cached) = read_disk_cover(&server.app_data_dir, &cache_key) {
        if let Ok(mut cache) = server.cache.lock() {
            cache.insert(cache_key.clone(), cached.clone());
        }
        if if_none_match
            .as_deref()
            .is_some_and(|value| etag_matches(value, &cached.etag))
        {
            return write_image_response(
                &mut stream,
                304,
                "Not Modified",
                &cached.content_type,
                &cached.etag,
                &[],
                true,
            );
        }
        return write_image_response(
            &mut stream,
            200,
            "OK",
            &cached.content_type,
            &cached.etag,
            &*cached.bytes,
            head_only,
        );
    }

    let client = server.client.clone();
    let app_data_dir = server.app_data_dir.clone();

    let edge = edge;
    let cache_key = cache_key;

    server.runtime.block_on(async move {
        let Ok(target) = reqwest::Url::parse(&original_url) else {
            let _ = write_simple_response(&mut stream, 400, "Bad Request", "invalid cover url");
            return Ok(());
        };

        let mut request = client.get(target.clone()).header("User-Agent", USER_AGENT);
        if let Some(headers) = feiniu_headers_for(&app_data_dir, &target) {
            for (name, value) in headers {
                request = request.header(name, value);
            }
        } else {
            // 公共 CDN 封面：补上常见的 Accept 与同源 Referer，尽量让服务端抓取成功。
            request = request
                .header(
                    "Accept",
                    "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
                )
                .header(
                    "Referer",
                    format!("{}/", target.origin().ascii_serialization()),
                );
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                eprintln!(
                    "[cover-proxy] upstream failed url={} error={}",
                    original_url, error
                );
                let _ = write_simple_response(
                    &mut stream,
                    502,
                    "Bad Gateway",
                    "upstream cover request failed",
                );
                return Ok(());
            }
        };

        let status = response.status();
        let headers = response.headers().clone();
        let content_type = headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let lowered = content_type.to_ascii_lowercase();
        if !status.is_success()
            || lowered.contains("application/json")
            || lowered.contains("text/html")
            || lowered.contains("text/plain")
        {
            let _ = write_simple_response(
                &mut stream,
                if status.is_success() {
                    502
                } else {
                    status.as_u16()
                },
                "Bad Gateway",
                "upstream cover response is not an image",
            );
            return Ok(());
        }

        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) => {
                eprintln!(
                    "[cover-proxy] body failed url={} error={}",
                    original_url, error
                );
                let _ = write_simple_response(
                    &mut stream,
                    502,
                    "Bad Gateway",
                    "upstream cover body failed",
                );
                return Ok(());
            }
        };
        let content_type = if content_type.trim().is_empty() {
            "image/jpeg".to_string()
        } else {
            content_type
        };
        let mut body = bytes.to_vec();
        let mut content_type = content_type;
        if let Some(edge) = edge {
            if let Some((resized, resized_type)) = downscale_cover_bytes(&body, edge) {
                body = resized;
                content_type = resized_type;
            }
        }
        let etag = etag_for_bytes(&body);
        let cached = CachedCover {
            bytes: Arc::from(body),
            content_type: content_type.clone(),
            etag: etag.clone(),
        };
        if let Ok(mut cache) = server.cache.lock() {
            cache.insert(cache_key.clone(), cached.clone());
        }
        write_disk_cover(&app_data_dir, &cache_key, &cached);
        if if_none_match
            .as_deref()
            .is_some_and(|value| etag_matches(value, &etag))
        {
            let _ = write_image_response(
                &mut stream,
                304,
                "Not Modified",
                &content_type,
                &etag,
                &[],
                true,
            );
            return Ok(());
        }
        let _ = write_image_response(
            &mut stream,
            200,
            "OK",
            &content_type,
            &etag,
            &*cached.bytes,
            head_only,
        );
        Ok(())
    })
}

fn header_value(request_text: &str, name: &str) -> Option<String> {
    for line in request_text.lines().skip(1) {
        if line.trim().is_empty() {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case(name) {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn etag_matches(if_none_match: &str, etag: &str) -> bool {
    if_none_match
        .split(',')
        .map(|item| item.trim())
        .any(|item| item == "*" || item == etag)
}

fn write_image_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    content_type: &str,
    etag: &str,
    bytes: &[u8],
    head_only: bool,
) -> Result<(), String> {
    let mut response_head = format!("HTTP/1.1 {} {}\r\n", status, reason);
    response_head.push_str("Content-Type: ");
    response_head.push_str(if content_type.trim().is_empty() {
        "image/jpeg"
    } else {
        content_type
    });
    response_head.push_str("\r\n");
    if status != 304 {
        response_head.push_str("Content-Length: ");
        response_head.push_str(&bytes.len().to_string());
        response_head.push_str("\r\n");
    }
    response_head.push_str("ETag: ");
    response_head.push_str(etag);
    response_head.push_str("\r\n");
    response_head
        .push_str("Cache-Control: public, max-age=604800, stale-while-revalidate=86400\r\n");
    response_head.push_str("Access-Control-Allow-Origin: *\r\n");
    response_head.push_str("Access-Control-Allow-Headers: *\r\n");
    response_head.push_str("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
    response_head.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(response_head.as_bytes())
        .map_err(|error| format!("写入本地封面代理响应头失败: {}", error))?;
    if !head_only && status != 304 {
        stream
            .write_all(bytes)
            .map_err(|error| format!("写入本地封面代理响应体失败: {}", error))?;
    }
    stream
        .flush()
        .map_err(|error| format!("刷新本地封面代理响应失败: {}", error))?;
    Ok(())
}

fn write_cors_preflight(stream: &mut TcpStream) -> Result<(), String> {
    let response = "HTTP/1.1 204 No Content\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Headers: *\r\n\
Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
Access-Control-Max-Age: 86400\r\n\
Connection: close\r\n\r\n";
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|error| format!("写入本地封面代理 CORS 响应失败: {}", error))
}

fn read_http_request(stream: &mut TcpStream) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|error| format!("配置本地封面代理读取超时失败: {}", error))?;
    let mut buffer = Vec::with_capacity(2048);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("读取本地封面代理请求失败: {}", error))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > 8192 {
            break;
        }
    }
    String::from_utf8(buffer).map_err(|error| format!("解析本地封面代理请求失败: {}", error))
}

fn parse_http_request(request: &str) -> Result<(String, String), String> {
    let first = request
        .lines()
        .next()
        .ok_or_else(|| "本地封面代理请求为空".to_string())?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || path.is_empty() {
        return Err("本地封面代理请求行无效".to_string());
    }
    Ok((method, path))
}

fn write_simple_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    let bytes = body.as_bytes();
    let response_head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        status,
        reason,
        bytes.len()
    );
    stream
        .write_all(response_head.as_bytes())
        .and_then(|_| stream.write_all(bytes))
        .map_err(|error| format!("写入本地封面代理错误响应失败: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_token_roundtrip() {
        let url =
            "https://fn.11111888.xyz:11443/music/api/v1/static/cover?coverId=track_abc&size=320";
        let encoded = encode_cover_token(url);
        assert_eq!(decode_cover_token(&encoded).as_deref(), Some(url));
        assert_eq!(
            encoded,
            "aHR0cHM6Ly9mbi4xMTExMTg4OC54eXo6MTE0NDMvbXVzaWMvYXBpL3YxL3N0YXRpYy9jb3Zlcj9jb3ZlcklkPXRyYWNrX2FiYyZzaXplPTMyMA"
        );
    }

    #[test]
    fn feiniu_origin_keeps_custom_port() {
        let config = serde_json::json!({
            "host": "fn.11111888.xyz",
            "port": 11443,
            "useHttps": true,
            "token": "abc"
        });
        assert_eq!(
            build_feiniu_origin(&config).as_deref(),
            Some("https://fn.11111888.xyz:11443")
        );
    }

    #[test]
    fn cover_cache_returns_same_bytes() {
        let mut cache = CoverCache::new();
        let cover = CachedCover {
            bytes: Arc::from(b"jpeg-bytes".as_slice()),
            content_type: "image/jpeg".to_string(),
            etag: "\"abc\"".to_string(),
        };
        cache.insert("https://example/cover".to_string(), cover);
        let cached = cache.get("https://example/cover").expect("cached cover");
        assert_eq!(&*cached.bytes, b"jpeg-bytes");
        assert_eq!(cached.content_type, "image/jpeg");
    }

    #[test]
    fn etag_match_accepts_quoted_value() {
        assert!(etag_matches("\"abc-1\"", "\"abc-1\""));
        assert!(etag_matches("W/\"abc-1\", \"abc-1\"", "\"abc-1\""));
        assert!(!etag_matches("\"other\"", "\"abc-1\""));
    }

    #[test]
    fn cover_edge_query_accepts_list_size() {
        assert_eq!(parse_cover_edge("/cover/abc?edge=128"), Some(128));
        assert_eq!(parse_cover_edge("/cover/abc?edge=256"), Some(256));
        assert_eq!(parse_cover_edge("/cover/abc?edge=16"), None);
        assert_eq!(
            cover_cache_key("https://example/cover", Some(128)),
            "https://example/cover|e128"
        );
    }

    #[test]
    fn cover_disk_cache_roundtrip() {
        let dir = std::env::temp_dir().join(format!("ceru-cover-cache-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let cover = CachedCover {
            bytes: Arc::from(b"jpeg-bytes".as_slice()),
            content_type: "image/jpeg".to_string(),
            etag: "\"abc\"".to_string(),
        };
        write_disk_cover(&dir, "https://example/cover|e128", &cover);
        let cached = read_disk_cover(&dir, "https://example/cover|e128").expect("disk cover");
        assert_eq!(&*cached.bytes, b"jpeg-bytes");
        assert_eq!(cached.content_type, "image/jpeg");
        let _ = fs::remove_dir_all(&dir);
    }
}
