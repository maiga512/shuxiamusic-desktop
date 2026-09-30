use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MediaStreamRequest {
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default, alias = "userAgent")]
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug)]
struct MediaStreamEntry {
    url: String,
    headers: HashMap<String, String>,
    referrer: Option<String>,
    user_agent: Option<String>,
}

#[derive(Debug)]
struct MediaStreamServer {
    addr: SocketAddr,
    entries: Mutex<HashMap<String, MediaStreamEntry>>,
    client: reqwest::Client,
    runtime: tokio::runtime::Runtime,
}

static MEDIA_STREAM_SERVER: OnceLock<MediaStreamServer> = OnceLock::new();

fn server() -> Result<&'static MediaStreamServer, String> {
    if let Some(server) = MEDIA_STREAM_SERVER.get() {
        return Ok(server);
    }

    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("启动本地音频流代理失败: {}", error))?;
    listener
        .set_nonblocking(false)
        .map_err(|error| format!("配置本地音频流代理失败: {}", error))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("读取本地音频流代理地址失败: {}", error))?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|error| format!("创建本地音频流代理运行时失败: {}", error))?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(60))
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(8)
        .tcp_keepalive(Duration::from_secs(60))
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .build()
        .map_err(|error| format!("创建本地音频流代理 HTTP 客户端失败: {}", error))?;

    let server = MediaStreamServer {
        addr,
        entries: Mutex::new(HashMap::new()),
        client,
        runtime,
    };
    let _ = MEDIA_STREAM_SERVER.set(server);
    let server_ref = MEDIA_STREAM_SERVER
        .get()
        .ok_or_else(|| "本地音频流代理初始化失败".to_string())?;

    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    thread::spawn(move || {
                        let _ = handle_client(stream);
                    });
                }
                Err(error) => {
                    eprintln!("[media-stream-proxy] accept failed: {}", error);
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    });

    Ok(server_ref)
}

pub fn proxied_stream_url(request: MediaStreamRequest) -> Result<String, String> {
    let url = request.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Ok(url.to_string());
    }
    if url.starts_with("http://127.0.0.1:") || url.starts_with("http://localhost:") {
        return Ok(url.to_string());
    }

    let server = server()?;
    let token = uuid::Uuid::new_v4().to_string();
    let entry = MediaStreamEntry {
        url: url.to_string(),
        headers: request.headers,
        referrer: request.referrer,
        user_agent: request.user_agent,
    };
    server
        .entries
        .lock()
        .map_err(|error| format!("写入本地音频流代理状态失败: {}", error))?
        .insert(token.clone(), entry);

    Ok(format!("http://{}/stream/{}", server.addr, token))
}

#[tauri::command]
pub fn media_stream_proxy_url(request: MediaStreamRequest) -> Result<String, String> {
    proxied_stream_url(request)
}

fn handle_client(mut stream: TcpStream) -> Result<(), String> {
    let request_text = read_http_request(&mut stream)?;
    let (method, path, range) = parse_http_request(&request_text)?;
    if method != "GET" && method != "HEAD" {
        return write_simple_response(&mut stream, 405, "Method Not Allowed", "");
    }

    let token = path
        .strip_prefix("/stream/")
        .and_then(|value| value.split('?').next())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "无效代理路径".to_string())?;

    let entry = server()?
        .entries
        .lock()
        .map_err(|error| format!("读取本地音频流代理状态失败: {}", error))?
        .get(token)
        .cloned();

    let Some(entry) = entry else {
        return write_simple_response(&mut stream, 404, "Not Found", "stream token not found");
    };

    forward_upstream(stream, token.to_string(), method == "HEAD", entry, range)
}

fn read_http_request(stream: &mut TcpStream) -> Result<String, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| format!("配置本地代理读取超时失败: {}", error))?;
    let mut buffer = Vec::with_capacity(4096);
    let mut chunk = [0u8; 1024];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("读取本地代理请求失败: {}", error))?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") || buffer.len() > 16384 {
            break;
        }
    }
    String::from_utf8(buffer).map_err(|error| format!("解析本地代理请求失败: {}", error))
}

fn parse_http_request(request: &str) -> Result<(String, String, Option<String>), String> {
    let mut lines = request.lines();
    let first = lines.next().ok_or_else(|| "本地代理请求为空".to_string())?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut range = None;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("range") {
            let text = value.trim();
            if !text.is_empty() {
                range = Some(text.to_string());
            }
        }
    }
    if method.is_empty() || path.is_empty() {
        return Err("本地代理请求行无效".to_string());
    }
    Ok((method, path, range))
}

fn normalized_headers(entry: &MediaStreamEntry, range: Option<String>) -> Vec<(String, String)> {
    let mut headers = Vec::new();
    for (key, value) in &entry.headers {
        let name = key.trim();
        let text = value.trim();
        if name.is_empty() || text.is_empty() {
            continue;
        }
        if name.eq_ignore_ascii_case("host") || name.eq_ignore_ascii_case("connection") {
            continue;
        }
        headers.push((name.to_string(), text.to_string()));
    }

    if let Some(referrer) = entry
        .referrer
        .as_deref()
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
    if let Some(user_agent) = entry
        .user_agent
        .as_deref()
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
        headers.push(("Accept".to_string(), "audio/*,*/*;q=0.9".to_string()));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("accept-language"))
    {
        headers.push((
            "Accept-Language".to_string(),
            "zh-CN,zh;q=0.9,en;q=0.8".to_string(),
        ));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("accept-encoding"))
    {
        headers.push(("Accept-Encoding".to_string(), "identity".to_string()));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("sec-fetch-dest"))
    {
        headers.push(("Sec-Fetch-Dest".to_string(), "audio".to_string()));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("sec-fetch-mode"))
    {
        headers.push(("Sec-Fetch-Mode".to_string(), "no-cors".to_string()));
    }
    if !headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case("sec-fetch-site"))
    {
        headers.push(("Sec-Fetch-Site".to_string(), "cross-site".to_string()));
    }
    if let Some(range) = range {
        if !headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("range"))
        {
            headers.push(("Range".to_string(), range));
        }
    }
    headers
}

fn forward_upstream(
    mut stream: TcpStream,
    token: String,
    head_only: bool,
    entry: MediaStreamEntry,
    range: Option<String>,
) -> Result<(), String> {
    let started_at = Instant::now();
    let method = if head_only { "HEAD" } else { "GET" };
    let upstream_label = upstream_log_label(&entry.url);
    let request_range = range.clone().unwrap_or_else(|| "none".to_string());
    let server = server()?;
    let client = server.client.clone();

    server.runtime.block_on(async move {
        let mut request = client.get(&entry.url);
        for (key, value) in normalized_headers(&entry, range) {
            request = request.header(key, value);
        }

        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                eprintln!(
                    "[media-stream-proxy] upstream request failed token={} method={} range={} upstream={} elapsed_ms={} error={}",
                    short_token(&token),
                    method,
                    request_range,
                    upstream_label,
                    started_at.elapsed().as_millis(),
                    error
                );
                let _ = write_simple_response(
                    &mut stream,
                    502,
                    "Bad Gateway",
                    "upstream audio request failed",
                );
                return Err(format!("上游音频请求失败: {}", error));
            }
        };
        let status = response.status();
        let headers = response.headers().clone();
        let content_type = header_text(&headers, reqwest::header::CONTENT_TYPE).unwrap_or_default();
        let content_length = header_text(&headers, reqwest::header::CONTENT_LENGTH).unwrap_or_default();
        let content_range = header_text(&headers, reqwest::header::CONTENT_RANGE).unwrap_or_default();
        let accept_ranges = header_text(&headers, reqwest::header::ACCEPT_RANGES).unwrap_or_default();
        let looks_like_html = content_type.to_ascii_lowercase().contains("text/html");

        eprintln!(
            "[media-stream-proxy] upstream response token={} method={} range={} status={} type={} length={} content_range={} accept_ranges={} html={} upstream={} elapsed_ms={}",
            short_token(&token),
            method,
            request_range,
            status.as_u16(),
            empty_dash(&content_type),
            empty_dash(&content_length),
            empty_dash(&content_range),
            empty_dash(&accept_ranges),
            looks_like_html,
            upstream_label,
            started_at.elapsed().as_millis()
        );

        let reason = status.canonical_reason().unwrap_or("OK");
        let mut response_head = format!("HTTP/1.1 {} {}\r\n", status.as_u16(), reason);
        for key in [
            reqwest::header::CONTENT_TYPE,
            reqwest::header::CONTENT_LENGTH,
            reqwest::header::CONTENT_RANGE,
            reqwest::header::ACCEPT_RANGES,
            reqwest::header::ETAG,
            reqwest::header::LAST_MODIFIED,
            reqwest::header::CACHE_CONTROL,
        ] {
            if let Some(value) = headers.get(&key).and_then(|value| value.to_str().ok()) {
                response_head.push_str(key.as_str());
                response_head.push_str(": ");
                response_head.push_str(value);
                response_head.push_str("\r\n");
            }
        }
        if !headers.contains_key(reqwest::header::ACCEPT_RANGES) {
            response_head.push_str("Accept-Ranges: bytes\r\n");
        }
        response_head.push_str("Access-Control-Allow-Origin: *\r\n");
        response_head.push_str("Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n");
        response_head.push_str("Connection: close\r\n\r\n");
        stream
            .write_all(response_head.as_bytes())
            .map_err(|error| format!("写入本地代理响应头失败: {}", error))?;

        if head_only {
            return Ok(());
        }

        let mut streamed_bytes: u64 = 0;
        let mut body = response.bytes_stream();
        while let Some(chunk) = body.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    eprintln!(
                        "[media-stream-proxy] upstream body failed token={} method={} streamed_bytes={} upstream={} error={}",
                        short_token(&token),
                        method,
                        streamed_bytes,
                        upstream_label,
                        error
                    );
                    return Err(format!("读取上游音频数据失败: {}", error));
                }
            };
            streamed_bytes += chunk.len() as u64;
            stream
                .write_all(&chunk)
                .map_err(|error| format!("写入本地代理响应体失败: {}", error))?;
        }
        let _ = stream.flush();
        Ok::<(), String>(())
    })
}

fn header_text(
    headers: &reqwest::header::HeaderMap,
    key: reqwest::header::HeaderName,
) -> Option<String> {
    headers
        .get(key)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string())
}

fn empty_dash(value: &str) -> &str {
    if value.trim().is_empty() {
        "-"
    } else {
        value
    }
}

fn short_token(token: &str) -> String {
    token.chars().take(8).collect()
}

fn upstream_log_label(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(parsed) => {
            let host = parsed.host_str().unwrap_or("unknown");
            let path = parsed.path();
            format!("{}://{}{}", parsed.scheme(), host, path)
        }
        Err(_) => "invalid-url".to_string(),
    }
}

fn write_simple_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> Result<(), String> {
    let bytes = body.as_bytes();
    let response_head = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
        status,
        reason,
        bytes.len()
    );
    stream
        .write_all(response_head.as_bytes())
        .and_then(|_| stream.write_all(bytes))
        .map_err(|error| format!("写入本地代理错误响应失败: {}", error))
}
