use crate::process_util;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Serialize, Deserialize)]
struct SidecarRequest {
    id: String,
    method: String,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct SidecarMessage {
    #[serde(rename = "type")]
    message_type: String,
    id: Option<String>,
    ok: Option<bool>,
    result: Option<Value>,
    error: Option<String>,
    event: Option<String>,
    payload: Option<Value>,
}

struct NodeSidecarState {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    seq: AtomicU64,
}

impl NodeSidecarState {
    fn new() -> Self {
        Self {
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> String {
        format!("sidecar-{}", self.seq.fetch_add(1, Ordering::Relaxed))
    }
}

fn sidecar_state() -> &'static Arc<NodeSidecarState> {
    static STATE: OnceLock<Arc<NodeSidecarState>> = OnceLock::new();
    STATE.get_or_init(|| Arc::new(NodeSidecarState::new()))
}

fn push_unique_path(candidates: &mut Vec<std::path::PathBuf>, path: std::path::PathBuf) {
    if !candidates.iter().any(|existing| existing == &path) {
        candidates.push(path);
    }
}

fn resolve_sidecar_entry(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("读取当前进程路径失败: {e}"))?;
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique_path(
            &mut candidates,
            resource_dir.join("sidecar").join("index.mjs"),
        );
        push_unique_path(
            &mut candidates,
            resource_dir.join("_up_").join("sidecar").join("index.mjs"),
        );
    }
    if let Some(parent) = exe.parent() {
        push_unique_path(&mut candidates, parent.join("sidecar").join("index.mjs"));
        push_unique_path(
            &mut candidates,
            parent.join("resources").join("sidecar").join("index.mjs"),
        );
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_unique_path(&mut candidates, cwd.join("sidecar").join("index.mjs"));
        push_unique_path(
            &mut candidates,
            cwd.join("..").join("sidecar").join("index.mjs"),
        );
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "未找到 Node sidecar 入口 sidecar/index.mjs".to_string())
}

fn resolve_sidecar_runtime_roots(app: &AppHandle) -> Vec<std::path::PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        push_unique_path(&mut roots, resource_dir.join("sidecar-runtime"));
        push_unique_path(
            &mut roots,
            resource_dir.join("_up_").join("sidecar-runtime"),
        );
        push_unique_path(
            &mut roots,
            resource_dir.join("packaging").join("sidecar-runtime"),
        );
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            push_unique_path(&mut roots, parent.join("sidecar-runtime"));
            push_unique_path(&mut roots, parent.join("resources").join("sidecar-runtime"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_unique_path(&mut roots, cwd.join("packaging").join("sidecar-runtime"));
        push_unique_path(
            &mut roots,
            cwd.join("..").join("packaging").join("sidecar-runtime"),
        );
    }
    roots
}

fn resolve_bundled_node(app: &AppHandle) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let binary_name = "node.exe";
    #[cfg(not(windows))]
    let binary_name = "node";

    for root in resolve_sidecar_runtime_roots(app) {
        let candidate = root.join(binary_name);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_node_module_paths(app: &AppHandle, entry: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut module_paths = Vec::new();
    for root in resolve_sidecar_runtime_roots(app) {
        push_unique_path(&mut module_paths, root.join("node_modules"));
    }
    if let Some(sidecar_dir) = entry.parent() {
        // Packaged resources keep sidecar/ next to the project root in map mode.
        push_unique_path(
            &mut module_paths,
            sidecar_dir.join("..").join("node_modules"),
        );
        push_unique_path(
            &mut module_paths,
            sidecar_dir
                .join("..")
                .join("packaging")
                .join("sidecar-runtime")
                .join("node_modules"),
        );
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_unique_path(&mut module_paths, cwd.join("node_modules"));
    }
    module_paths
        .into_iter()
        .filter(|path| path.exists())
        .collect()
}

fn join_node_path(paths: &[std::path::PathBuf]) -> String {
    let separator = if cfg!(windows) { ";" } else { ":" };
    paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(separator)
}

fn spawn_sidecar(app: AppHandle, state: Arc<NodeSidecarState>) -> Result<(), String> {
    let mut child_guard = state
        .child
        .lock()
        .map_err(|_| "sidecar child lock poisoned".to_string())?;
    if let Some(child) = child_guard.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok(()),
            Ok(Some(_)) => {}
            Err(e) => {
                process_util::kill_and_wait(child);
                return Err(format!("检查 sidecar 状态失败: {e}"));
            }
        }
    }

    let entry = resolve_sidecar_entry(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // 把数据库里配置的下载/缓存目录作为 env 传给 sidecar，让 sidecar 一启动就用用户
    // 设置的路径（不再依赖"打开过设置页才同步"，根治下载落到默认/缓存目录的问题）。
    let (cfg_download_dir, cfg_cache_dir) = app
        .try_state::<crate::db::Database>()
        .map(|db| {
            (
                db.get_setting("download_dir")
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
                db.get_setting("cache_dir")
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty()),
            )
        })
        .unwrap_or_default();
    let node_bin = resolve_bundled_node(&app).unwrap_or_else(|| std::path::PathBuf::from("node"));
    let module_paths = resolve_node_module_paths(&app, &entry);
    let mut command = Command::new(&node_bin);
    let sidecar_dir = entry.parent().map(|path| path.to_path_buf());
    if let Some(hook) = sidecar_dir
        .as_ref()
        .map(|dir| dir.join("register-node-path.mjs"))
        .filter(|path| path.exists())
    {
        // ESM ignores NODE_PATH. Register a resolver so packaged axios/iconv-lite load.
        command.arg("--import").arg(hook);
    }
    command
        .arg(&entry)
        .env("CERU_APP_DATA_DIR", &app_data_dir)
        .env("CERU_TAURI_APP_DATA_DIR", &app_data_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(dir) = &cfg_download_dir {
        command.env("CERU_DOWNLOAD_DIR", dir);
    }
    if let Some(dir) = &cfg_cache_dir {
        command.env("CERU_CACHE_DIR", dir);
    }
    if let Some(dir) = sidecar_dir.as_ref() {
        command.current_dir(dir);
    }
    if !module_paths.is_empty() {
        let joined = join_node_path(&module_paths);
        let existing = std::env::var_os("NODE_PATH");
        let merged = match existing {
            Some(value) if !value.is_empty() => {
                let separator = if cfg!(windows) { ";" } else { ":" };
                format!("{joined}{separator}{}", value.to_string_lossy())
            }
            _ => joined,
        };
        command.env("NODE_PATH", merged);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Avoid flashing a console window for the packaged sidecar.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 Node sidecar 失败 (bin={}): {e}", node_bin.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开 sidecar stdin".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法打开 sidecar stdout".to_string())?;
    let stderr = child.stderr.take();

    *state
        .stdin
        .lock()
        .map_err(|_| "sidecar stdin lock poisoned".to_string())? = Some(stdin);

    let stdout_state = state.clone();
    let stdout_app = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<SidecarMessage>(&line) {
                Ok(message) => handle_sidecar_message(&stdout_app, &stdout_state, message),
                Err(error) => {
                    let _ = stdout_app.emit(
                        "node-sidecar:error",
                        serde_json::json!({
                            "message": format!("解析 sidecar 输出失败: {error}"),
                            "raw": line,
                        }),
                    );
                }
            }
        }
        if let Ok(mut child_guard) = stdout_state.child.lock() {
            if let Some(child) = child_guard.as_mut() {
                let _ = child.try_wait();
            }
        }
    });

    if let Some(stderr) = stderr {
        let stderr_app = app.clone();
        let stderr_log_path = app_data_dir.join("sidecar-stderr.log");
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            let mut log_file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&stderr_log_path)
                .ok();
            for line in reader.lines().flatten() {
                if let Some(file) = log_file.as_mut() {
                    let _ = writeln!(file, "{line}");
                }
                let _ = stderr_app.emit("node-sidecar:stderr", line);
            }
        });
    }

    *child_guard = Some(child);
    Ok(())
}

fn handle_sidecar_message(app: &AppHandle, state: &Arc<NodeSidecarState>, message: SidecarMessage) {
    match message.message_type.as_str() {
        "response" => {
            if let Some(id) = message.id {
                if let Ok(mut pending) = state.pending.lock() {
                    if let Some(tx) = pending.remove(&id) {
                        let result = if message.ok.unwrap_or(false) {
                            Ok(message.result.unwrap_or(Value::Null))
                        } else {
                            Err(message
                                .error
                                .unwrap_or_else(|| "sidecar request failed".to_string()))
                        };
                        let _ = tx.send(result);
                    }
                }
            }
        }
        "event" => {
            if let Some(event) = message.event {
                let payload = message.payload.unwrap_or(Value::Null);
                let _ = app.emit(event.as_str(), payload.clone());
                let _ = app.emit(
                    "node-sidecar:event",
                    serde_json::json!({
                        "event": event,
                        "payload": payload,
                    }),
                );
            }
        }
        _ => {
            let _ = app.emit(
                "node-sidecar:error",
                serde_json::json!({
                    "message": "未知 sidecar 消息类型",
                    "messageType": message.message_type,
                }),
            );
        }
    }
}

pub fn shutdown() {
    let state = sidecar_state();
    if let Ok(mut stdin) = state.stdin.lock() {
        *stdin = None;
    }
    if let Ok(mut child_guard) = state.child.lock() {
        if let Some(mut child) = child_guard.take() {
            process_util::kill_and_wait(&mut child);
        }
    }
    if let Ok(mut pending) = state.pending.lock() {
        pending.clear();
    }
}

pub fn init(app: &AppHandle) {
    let app = app.clone();
    let state = sidecar_state().clone();
    if let Err(error) = spawn_sidecar(app.clone(), state) {
        let _ = app.emit(
            "node-sidecar:error",
            serde_json::json!({ "message": error }),
        );
    }
}

pub(crate) fn node_sidecar_request_blocking(
    app: AppHandle,
    method: String,
    payload: Value,
) -> Result<Value, String> {
    let state = sidecar_state().clone();
    spawn_sidecar(app, state.clone())?;

    let id = state.next_id();
    let request = SidecarRequest {
        id: id.clone(),
        method,
        payload,
    };
    let line =
        serde_json::to_string(&request).map_err(|e| format!("序列化 sidecar 请求失败: {e}"))?;
    let (tx, rx) = mpsc::channel();
    state
        .pending
        .lock()
        .map_err(|_| "sidecar pending lock poisoned".to_string())?
        .insert(id.clone(), tx);

    let write_result = state
        .stdin
        .lock()
        .map_err(|_| "sidecar stdin lock poisoned".to_string())?
        .as_mut()
        .ok_or_else(|| "sidecar stdin 未就绪".to_string())
        .and_then(|stdin| {
            stdin
                .write_all(format!("{line}\n").as_bytes())
                .and_then(|_| stdin.flush())
                .map_err(|e| format!("写入 sidecar 请求失败: {e}"))
        });

    if let Err(error) = write_result {
        if let Ok(mut pending) = state.pending.lock() {
            pending.remove(&id);
        }
        return Err(error);
    }

    rx.recv_timeout(Duration::from_secs(30))
        .map_err(|_| "sidecar 请求超时".to_string())?
}

#[tauri::command]
pub async fn node_sidecar_request(
    app: AppHandle,
    method: String,
    payload: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        node_sidecar_request_blocking(app, method, payload)
    })
    .await
    .map_err(|e| format!("sidecar 请求任务失败: {e}"))?
}

#[tauri::command]
pub async fn node_sidecar_health(app: AppHandle) -> Result<Value, String> {
    node_sidecar_request(app, "health".to_string(), Value::Null).await
}
