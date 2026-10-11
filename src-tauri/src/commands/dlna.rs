use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

// ==================== Types ====================

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct DlnaDevice {
    pub usn: String,
    pub location: String,
    pub address: String,
    pub name: String,
}

#[derive(Clone, Default)]
struct DeviceServices {
    av_transport_url: Option<String>,
    rendering_control_url: Option<String>,
}

pub struct DlnaState {
    devices: Mutex<Vec<DlnaDevice>>,
    searching: AtomicBool,
    ssdp_socket: Mutex<Option<Arc<UdpSocket>>>,
    services: Mutex<Option<DeviceServices>>,
    device_base_url: Mutex<Option<String>>,
    local_server_port: Mutex<u16>,
    server_started: AtomicBool,
    current_local_file: Mutex<String>,
    current_proxy_url: Mutex<String>,
}

impl DlnaState {
    fn new() -> Self {
        Self {
            devices: Mutex::new(Vec::new()),
            searching: AtomicBool::new(false),
            ssdp_socket: Mutex::new(None),
            services: Mutex::new(None),
            device_base_url: Mutex::new(None),
            local_server_port: Mutex::new(0),
            server_started: AtomicBool::new(false),
            current_local_file: Mutex::new(String::new()),
            current_proxy_url: Mutex::new(String::new()),
        }
    }
}

// ==================== Init ====================

pub fn init(app: &AppHandle) {
    app.manage(DlnaState::new());
    // 本地 HTTP 服务器改为按需启动（仅投屏本地文件 / 本地代理时才绑定 0.0.0.0），
    // 空闲时不监听，减少局域网端口暴露。见 ensure_local_server()。
}

// ==================== Local HTTP Server ====================

/// 按需启动本地 HTTP 服务器，返回监听端口。幂等：已启动则直接返回端口。
/// 仅在投屏需要本地取文件 / 本地代理时调用，避免空闲时常开 0.0.0.0 监听。
fn ensure_local_server(app: &AppHandle) -> Result<u16, String> {
    let state = app.state::<DlnaState>();

    // 已启动：直接返回端口
    {
        let port = *state.local_server_port.lock().unwrap();
        if port != 0 {
            return Ok(port);
        }
    }

    // 抢占启动权；拿不到说明另一线程正在启动，等端口就绪
    if state
        .server_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        for _ in 0..100 {
            let port = *state.local_server_port.lock().unwrap();
            if port != 0 {
                return Ok(port);
            }
            thread::sleep(Duration::from_millis(20));
        }
        return Err("本地 HTTP 服务器启动超时".into());
    }

    let listener = match TcpListener::bind("0.0.0.0:0") {
        Ok(l) => l,
        Err(e) => {
            state.server_started.store(false, Ordering::SeqCst);
            return Err(format!("本地 HTTP 服务器绑定失败: {}", e));
        }
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(e) => {
            state.server_started.store(false, Ordering::SeqCst);
            return Err(format!("读取本地服务器端口失败: {}", e));
        }
    };
    *state.local_server_port.lock().unwrap() = port;
    println!("[DLNA] Local HTTP server started on port {}", port);

    let handle = app.clone();
    thread::spawn(move || run_local_server(listener, handle));
    Ok(port)
}

fn run_local_server(listener: TcpListener, app: AppHandle) {
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let app = app.clone();
                thread::spawn(move || handle_connection(stream, &app));
            }
            Err(e) => eprintln!("[DLNA] Local server accept error: {}", e),
        }
    }
}

fn handle_connection(stream: TcpStream, app: &AppHandle) {
    let mut reader = BufReader::new(&stream);
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() {
        return;
    }
    let parts: Vec<&str> = request_line.split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];

    let mut headers = Vec::new();
    let mut content_length: u64 = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
            break;
        }
        if line.to_lowercase().starts_with("content-length:") {
            if let Some(len_str) = line.split(':').nth(1) {
                content_length = len_str.trim().parse().unwrap_or(0);
            }
        }
        headers.push(line.trim().to_string());
    }

    let mut body = Vec::new();
    if content_length > 0 {
        let _ = reader.take(content_length).read_to_end(&mut body);
    }

    let state = app.state::<DlnaState>();
    let proxy_url = state.current_proxy_url.lock().unwrap().clone();
    let local_file = state.current_local_file.lock().unwrap().clone();

    if !proxy_url.is_empty() {
        proxy_request(stream, method, &proxy_url, &headers, &body);
    } else if !local_file.is_empty() {
        serve_file(stream, method, &local_file);
    } else {
        let _ = send_response(stream, 404, "Not Found", "");
    }
}

fn proxy_request(
    mut stream: TcpStream,
    method: &str,
    target_url: &str,
    _headers: &[String],
    body: &[u8],
) {
    let url = match reqwest::Url::parse(target_url) {
        Ok(u) => u,
        Err(_) => {
            let _ = send_response(stream, 400, "Bad Request", "Invalid URL");
            return;
        }
    };

    let host = url.host_str().unwrap_or("localhost");
    let port = url.port_or_known_default().unwrap_or(80);
    let path = url.path();

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .unwrap_or_else(|_| SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port));

    let mut target = match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
        Ok(s) => s,
        Err(_) => {
            let _ = send_response(stream, 502, "Bad Gateway", "Cannot connect to target");
            return;
        }
    };

    let proxy_req = format!(
        "{} {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        method, path, host
    );
    let _ = target.write_all(proxy_req.as_bytes());
    if !body.is_empty() {
        let _ = target.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes());
        let _ = target.write_all(body);
    }
    let _ = std::io::copy(&mut target, &mut stream);
}

fn serve_file(stream: TcpStream, method: &str, file_path: &str) {
    let path = std::path::Path::new(file_path);
    if !path.exists() {
        let _ = send_response(stream, 404, "Not Found", "File not found");
        return;
    }
    let metadata = match path.metadata() {
        Ok(m) => m,
        Err(_) => {
            let _ = send_response(stream, 500, "Internal Server Error", "");
            return;
        }
    };
    let total_size = metadata.len();

    let content_type = file_path
        .rsplit('.')
        .next()
        .map(|ext| match ext.to_lowercase().as_str() {
            "mp3" => "audio/mpeg",
            "flac" => "audio/flac",
            "wav" => "audio/wav",
            "ogg" => "audio/ogg",
            "aac" => "audio/aac",
            "wma" => "audio/x-ms-wma",
            "ape" => "audio/x-ape",
            "dsf" => "audio/x-dsf",
            "m4a" => "audio/mp4",
            _ => "audio/mpeg",
        })
        .unwrap_or("audio/mpeg");

    _ = send_file_response(stream, method, &path, total_size, content_type);
}

fn send_file_response(
    mut stream: TcpStream,
    method: &str,
    path: &std::path::Path,
    total_size: u64,
    content_type: &str,
) -> std::io::Result<()> {
    if method == "HEAD" {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            total_size, content_type
        )
    } else if method == "GET" {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
            total_size, content_type
        )?;
        let mut file = std::fs::File::open(path)?;
        std::io::copy(&mut file, &mut stream)?;
        Ok(())
    } else {
        send_response(stream, 405, "Method Not Allowed", "")
    }
}

fn send_response(
    mut stream: TcpStream,
    status: u16,
    reason: &str,
    body: &str,
) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{}",
        status,
        reason,
        body.len(),
        body
    )
}

// ==================== SSDP Discovery ====================

fn get_local_ip() -> String {
    let socket = match UdpSocket::bind("0.0.0.0:0") {
        Ok(s) => s,
        Err(_) => return "127.0.0.1".into(),
    };
    match socket.connect("8.8.8.8:80") {
        Ok(()) => match socket.local_addr() {
            Ok(addr) => addr.ip().to_string(),
            Err(_) => "127.0.0.1".into(),
        },
        Err(_) => "127.0.0.1".into(),
    }
}

const SSDP_MULTICAST: &str = "239.255.255.250:1900";
const SSDP_MSEARCH: &[u8] = b"M-SEARCH * HTTP/1.1\r\n\
    HOST: 239.255.255.250:1900\r\n\
    MAN: \"ssdp:discover\"\r\n\
    MX: 3\r\n\
    ST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\
    USER-AGENT: CeruMusic/1.0 DLNA/1.0\r\n\r\n";

#[tauri::command]
pub async fn dlna_start_search(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<DlnaState>();

    if state.searching.load(Ordering::SeqCst) {
        if let Ok(mut socket_guard) = state.ssdp_socket.lock() {
            *socket_guard = None;
        }
    }

    *state.devices.lock().unwrap() = Vec::new();
    state.searching.store(true, Ordering::SeqCst);

    let socket =
        UdpSocket::bind("0.0.0.0:0").map_err(|e| format!("无法创建 SSDP 套接字: {}", e))?;
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| format!("设置超时失败: {}", e))?;

    {
        let mut guard = state.ssdp_socket.lock().unwrap();
        *guard = Some(Arc::new(
            socket
                .try_clone()
                .map_err(|e| format!("克隆套接字失败: {}", e))?,
        ));
    }

    let app_clone = app.clone();
    thread::spawn(move || -> () {
        if socket.send_to(SSDP_MSEARCH, SSDP_MULTICAST).is_err() {
            eprintln!("[DLNA] Failed to send SSDP M-SEARCH");
            return;
        }

        let mut buf = [0u8; 4096];
        let start = std::time::Instant::now();

        loop {
            if start.elapsed() > Duration::from_secs(3) {
                break;
            }

            match socket.recv_from(&mut buf) {
                Ok((len, src)) => {
                    let response = String::from_utf8_lossy(&buf[..len]);
                    if let Some(device) = parse_ssdp_response(&response, src) {
                        let state = app_clone.state::<DlnaState>();
                        let mut devices = state.devices.lock().unwrap();
                        if !devices.iter().any(|d| d.usn == device.usn) {
                            let name = http_get_friendly_name(&device.location)
                                .unwrap_or_else(|| device.name.clone());
                            let mut named_device = device;
                            named_device.name = name;
                            println!(
                                "[DLNA] Found device: {} at {}",
                                named_device.name, named_device.location
                            );
                            devices.push(named_device);
                        }
                    }
                }
                Err(_) => {
                    if !app_clone
                        .state::<DlnaState>()
                        .searching
                        .load(Ordering::SeqCst)
                    {
                        break;
                    }
                }
            }
        }

        app_clone
            .state::<DlnaState>()
            .searching
            .store(false, Ordering::SeqCst);
        let _ = app_clone.emit("dlna:search-complete", ());
    });

    Ok(true)
}

#[tauri::command]
pub async fn dlna_stop_search(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<DlnaState>();
    state.searching.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = state.ssdp_socket.lock() {
        *guard = None;
    }
    Ok(true)
}

#[tauri::command]
pub async fn dlna_get_devices(app: AppHandle) -> Result<Vec<DlnaDevice>, String> {
    let state = app.state::<DlnaState>();
    let devices = state.devices.lock().unwrap().clone();
    Ok(devices)
}

fn parse_ssdp_response(response: &str, src: SocketAddr) -> Option<DlnaDevice> {
    if !response.contains("200 OK") {
        return None;
    }
    let mut location = None;
    let mut usn = None;
    let mut server = None;
    for line in response.lines() {
        let line = line.trim();
        if let Some(val) = line
            .strip_prefix("LOCATION:")
            .or_else(|| line.strip_prefix("location:"))
        {
            location = Some(val.trim().to_string());
        } else if let Some(val) = line
            .strip_prefix("USN:")
            .or_else(|| line.strip_prefix("usn:"))
        {
            usn = Some(val.trim().to_string());
        } else if let Some(val) = line
            .strip_prefix("SERVER:")
            .or_else(|| line.strip_prefix("server:"))
        {
            server = Some(val.trim().to_string());
        }
    }
    Some(DlnaDevice {
        usn: usn?,
        location: location?,
        address: src.ip().to_string(),
        name: server.unwrap_or_else(|| src.ip().to_string()),
    })
}

/// Fetch friendlyName from device description XML using raw TCP (no reqwest::blocking).
fn http_get_friendly_name(location: &str) -> Option<String> {
    let url = reqwest::Url::parse(location).ok()?;
    let host = url.host_str()?;
    let port = url.port_or_known_default().unwrap_or(80);
    let path = url.path();

    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .unwrap_or_else(|_| SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), port));

    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).ok()?;

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        path, host
    );
    stream.write_all(request.as_bytes()).ok()?;

    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;

    let body = response.split("\r\n\r\n").nth(1)?;

    if let Some(start) = body.find("<friendlyName>") {
        let start = start + "<friendlyName>".len();
        if let Some(end) = body[start..].find("</friendlyName>") {
            return Some(body[start..start + end].trim().to_string());
        }
    }
    None
}

// ==================== UPnP Control ====================

fn resolve_service_url(base_url: &str, control_url: &str) -> String {
    if control_url.starts_with("http://") || control_url.starts_with("https://") {
        return control_url.to_string();
    }
    let base = base_url.trim_end_matches('/');
    let ctrl = control_url.trim_start_matches('/');
    format!("{}/{}", base, ctrl)
}

fn parse_device_services(device_xml: &str, base_url: &str) -> DeviceServices {
    let mut services = DeviceServices::default();
    if let Some(list_start) = device_xml.find("<serviceList>") {
        let list_end = device_xml[list_start..]
            .find("</serviceList>")
            .map(|e| list_start + e + "</serviceList>".len())
            .unwrap_or(device_xml.len());
        let list = &device_xml[list_start..list_end];

        for block in list.split("<service>").skip(1) {
            let block = if let Some(end) = block.find("</service>") {
                &block[..end]
            } else {
                continue;
            };
            let st = extract_xml_tag(block, "serviceType");
            let cu = extract_xml_tag(block, "controlURL");
            if let (Some(st), Some(cu)) = (st, cu) {
                if st.contains("AVTransport") {
                    services.av_transport_url = Some(resolve_service_url(base_url, &cu));
                } else if st.contains("RenderingControl") {
                    services.rendering_control_url = Some(resolve_service_url(base_url, &cu));
                }
            }
        }
    }
    services
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    if let Some(start) = xml.find(&open) {
        let start = start + open.len();
        if let Some(end) = xml[start..].find(&close) {
            return Some(xml[start..start + end].to_string());
        }
    }
    None
}

/// Async SOAP action sender using reqwest::Client (non-blocking).
async fn send_soap_action(
    control_url: &str,
    service_type: &str,
    action: &str,
    body_xml: &str,
) -> Result<String, String> {
    let soap_body = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
            s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="{service_type}">
      {body}
    </u:{action}>
  </s:Body>
</s:Envelope>"#,
        action = action,
        service_type = service_type,
        body = body_xml
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .post(control_url)
        .header("Content-Type", r#"text/xml; charset="utf-8""#)
        .header("SOAPAction", format!("\"{}#{}\"", service_type, action))
        .body(soap_body)
        .send()
        .await
        .map_err(|e| format!("SOAP 请求失败: {}", e))?;

    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    if status.is_success() {
        Ok(text)
    } else {
        eprintln!(
            "[DLNA] SOAP {} returned status {}: {}",
            action, status, text
        );
        Ok(text)
    }
}

// ==================== Tauri Commands ====================

async fn ensure_device_services(app: &AppHandle, location: &str) -> Result<(), String> {
    let state = app.state::<DlnaState>();
    {
        let base = state.device_base_url.lock().unwrap();
        if let Some(b) = base.as_ref() {
            if b == location && state.services.lock().unwrap().is_some() {
                return Ok(());
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let text = client
        .get(location)
        .send()
        .await
        .map_err(|e| format!("获取设备描述失败: {}", e))?
        .text()
        .await
        .map_err(|e| format!("读取设备描述失败: {}", e))?;

    let url = reqwest::Url::parse(location).map_err(|_| "解析设备 URL 失败".to_string())?;
    let base_url = format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or("localhost"),
        url.port_or_known_default().unwrap_or(80)
    );

    let services = parse_device_services(&text, &base_url);

    if services.av_transport_url.is_none() && services.rendering_control_url.is_none() {
        return Err("设备描述中未找到 AVTransport 或 RenderingControl 服务".into());
    }

    let state = app.state::<DlnaState>();
    *state.services.lock().unwrap() = Some(services);
    *state.device_base_url.lock().unwrap() = Some(location.to_string());
    Ok(())
}

#[tauri::command]
pub async fn dlna_play(
    app: AppHandle,
    url: String,
    location: String,
    title: Option<String>,
) -> Result<bool, String> {
    let _ = title;
    ensure_device_services(&app, &location).await?;

    let av_url = {
        let state = app.state::<DlnaState>();
        let services = state.services.lock().unwrap().clone();
        services
            .and_then(|s| s.av_transport_url)
            .ok_or("未找到 AVTransport 服务 URL")?
    };

    let state = app.state::<DlnaState>();

    let play_url = if url.starts_with("file://") {
        let file_path = url
            .strip_prefix("file://")
            .map(simple_url_decode)
            .unwrap_or(url);
        *state.current_local_file.lock().unwrap() = file_path;
        *state.current_proxy_url.lock().unwrap() = String::new();
        let port = ensure_local_server(&app)?;
        format!("http://{}:{}/audio.mp3", get_local_ip(), port)
    } else if !url.starts_with("http://") && !url.starts_with("https://") {
        *state.current_local_file.lock().unwrap() = url;
        *state.current_proxy_url.lock().unwrap() = String::new();
        let port = ensure_local_server(&app)?;
        format!("http://{}:{}/audio.mp3", get_local_ip(), port)
    } else if url.contains("127.0.0.1") || url.contains("localhost") {
        *state.current_local_file.lock().unwrap() = String::new();
        *state.current_proxy_url.lock().unwrap() = url;
        let port = ensure_local_server(&app)?;
        format!("http://{}:{}/audio.mp3", get_local_ip(), port)
    } else {
        *state.current_local_file.lock().unwrap() = String::new();
        *state.current_proxy_url.lock().unwrap() = String::new();
        url
    };

    send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "SetAVTransportURI",
        &format!(
            "<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>",
            play_url
        ),
    )
    .await?;

    tokio::time::sleep(Duration::from_millis(500)).await;

    send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "Play",
        "<InstanceID>0</InstanceID><Speed>1</Speed>",
    )
    .await?;

    Ok(true)
}

fn simple_url_decode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '%' {
            let hex: String = chars.by_ref().take(2).collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                result.push(byte as char);
            } else {
                result.push('%');
                result.push_str(&hex);
            }
        } else {
            result.push(c);
        }
    }
    result
}

#[tauri::command]
pub async fn dlna_pause(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<DlnaState>();
    let av_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.av_transport_url)
            .ok_or("未找到 AVTransport 服务 URL")?
    };
    send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "Pause",
        "<InstanceID>0</InstanceID>",
    )
    .await?;
    Ok(true)
}

#[tauri::command]
pub async fn dlna_resume(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<DlnaState>();
    let av_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.av_transport_url)
            .ok_or("未找到 AVTransport 服务 URL")?
    };
    send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "Play",
        "<InstanceID>0</InstanceID><Speed>1</Speed>",
    )
    .await?;
    Ok(true)
}

#[tauri::command]
pub async fn dlna_stop(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<DlnaState>();
    let av_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.av_transport_url)
            .ok_or("未找到 AVTransport 服务 URL")?
    };
    send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "Stop",
        "<InstanceID>0</InstanceID>",
    )
    .await?;
    Ok(true)
}

#[tauri::command]
pub async fn dlna_seek(app: AppHandle, seconds: f64) -> Result<bool, String> {
    let state = app.state::<DlnaState>();
    let av_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.av_transport_url)
            .ok_or("未找到 AVTransport 服务 URL")?
    };

    let hours = (seconds / 3600.0) as i32;
    let minutes = ((seconds % 3600.0) / 60.0) as i32;
    let secs = (seconds % 60.0) as i32;
    let target = format!("{:02}:{:02}:{:02}", hours, minutes, secs);

    let body = format!(
        "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>",
        target
    );

    match send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "Seek",
        &body,
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(e) => {
            eprintln!("[DLNA] Seek error (non-fatal): {}", e);
            Ok(true)
        }
    }
}

#[tauri::command]
pub async fn dlna_get_position(app: AppHandle) -> Result<f64, String> {
    let state = app.state::<DlnaState>();
    let av_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.av_transport_url)
            .ok_or("未找到 AVTransport 服务 URL")?
    };

    let result = send_soap_action(
        &av_url,
        "urn:schemas-upnp-org:service:AVTransport:1",
        "GetPositionInfo",
        "<InstanceID>0</InstanceID>",
    )
    .await?;

    if let Some(time_str) =
        extract_xml_tag(&result, "RelTime").or_else(|| extract_xml_tag(&result, "AbsTime"))
    {
        let parts: Vec<&str> = time_str.split(':').collect();
        if parts.len() == 3 {
            let h: f64 = parts[0].parse().unwrap_or(0.0);
            let m: f64 = parts[1].parse().unwrap_or(0.0);
            let s: f64 = parts[2].parse().unwrap_or(0.0);
            return Ok(h * 3600.0 + m * 60.0 + s);
        }
    }
    Ok(0.0)
}

#[tauri::command]
pub async fn dlna_get_volume(app: AppHandle) -> Result<i32, String> {
    let state = app.state::<DlnaState>();
    let rc_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.rendering_control_url)
            .ok_or("未找到 RenderingControl 服务 URL")?
    };

    let result = send_soap_action(
        &rc_url,
        "urn:schemas-upnp-org:service:RenderingControl:1",
        "GetVolume",
        "<InstanceID>0</InstanceID><Channel>Master</Channel>",
    )
    .await?;

    if let Some(vol_str) = extract_xml_tag(&result, "CurrentVolume") {
        if let Ok(vol) = vol_str.parse::<i32>() {
            return Ok(vol);
        }
    }
    Ok(100)
}

#[tauri::command]
pub async fn dlna_set_volume(app: AppHandle, volume: i32) -> Result<bool, String> {
    let state = app.state::<DlnaState>();
    let rc_url = {
        let s = state.services.lock().unwrap().clone();
        s.and_then(|s| s.rendering_control_url)
            .ok_or("未找到 RenderingControl 服务 URL")?
    };

    let body = format!(
        "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{}</DesiredVolume>",
        volume
    );

    send_soap_action(
        &rc_url,
        "urn:schemas-upnp-org:service:RenderingControl:1",
        "SetVolume",
        &body,
    )
    .await?;

    Ok(true)
}
