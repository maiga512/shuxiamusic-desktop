use crate::commands::download_engine::DownloadEngine;
use crate::db::Database;
use crate::models::*;
use crate::process_util;
use tauri::{Emitter, Manager, State};

// ==================== Song List Commands ====================

#[tauri::command]
pub fn songlist_get_all(db: State<'_, Database>) -> Result<Vec<SongList>, String> {
    Ok(db.list_playlists())
}

#[tauri::command]
pub fn songlist_get_by_id(
    db: State<'_, Database>,
    hash_id: String,
) -> Result<Option<SongList>, String> {
    Ok(db.get_playlist(&hash_id))
}

#[tauri::command]
pub fn songlist_create(
    db: State<'_, Database>,
    name: String,
    description: Option<String>,
    meta: Option<serde_json::Value>,
    source: Option<String>,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let pl = SongList {
        id,
        name,
        description: description.unwrap_or_default(),
        cover_img_url: "default-cover".into(),
        source: source.unwrap_or_else(|| "local".into()),
        meta: meta.unwrap_or(serde_json::Value::Object(Default::default())),
        create_time: now.clone(),
        update_time: now,
        position: 0,
    };
    db.insert_playlist(&pl)
}

#[tauri::command]
pub fn songlist_create_with_id(
    db: State<'_, Database>,
    hash_id: String,
    name: String,
    description: Option<String>,
    source: Option<String>,
    meta: Option<serde_json::Value>,
) -> Result<String, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let pl = SongList {
        id: hash_id.clone(),
        name,
        description: description.unwrap_or_default(),
        cover_img_url: "default-cover".into(),
        source: source.unwrap_or_else(|| "local".into()),
        meta: meta.unwrap_or(serde_json::Value::Object(Default::default())),
        create_time: now.clone(),
        update_time: now,
        position: 0,
    };
    db.insert_playlist(&pl)?;
    Ok(hash_id)
}

#[tauri::command]
pub fn songlist_delete(db: State<'_, Database>, hash_id: String) -> Result<(), String> {
    db.delete_playlist(&hash_id)
}

#[tauri::command]
pub fn songlist_batch_delete(db: State<'_, Database>, hash_ids: Vec<String>) -> Result<(), String> {
    for id in &hash_ids {
        db.delete_playlist(id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn songlist_edit(
    db: State<'_, Database>,
    hash_id: String,
    updates: serde_json::Value,
) -> Result<(), String> {
    let name = updates.get("name").and_then(|v| v.as_str());
    let description = updates.get("description").and_then(|v| v.as_str());
    let cover_img_url = updates.get("cover_img_url").and_then(|v| v.as_str());
    let source = updates.get("source").and_then(|v| v.as_str());
    let meta = updates.get("meta");
    db.update_playlist(&hash_id, name, description, cover_img_url, source, meta)
}

#[tauri::command]
pub fn songlist_update_cover(
    db: State<'_, Database>,
    hash_id: String,
    cover_img_url: String,
) -> Result<(), String> {
    db.update_cover(&hash_id, &cover_img_url)
}

#[tauri::command]
pub fn songlist_exists(db: State<'_, Database>, hash_id: String) -> Result<bool, String> {
    Ok(db.playlist_exists(&hash_id))
}

#[tauri::command]
pub fn songlist_get_statistics(db: State<'_, Database>) -> Result<SongListStatistics, String> {
    Ok(db.get_songlist_statistics())
}

#[tauri::command]
pub fn songlist_get_songs(db: State<'_, Database>, hash_id: String) -> Result<Vec<Songs>, String> {
    Ok(db.list_songs(&hash_id))
}

#[tauri::command]
pub fn songlist_get_song_count(db: State<'_, Database>, hash_id: String) -> Result<i64, String> {
    Ok(db.count_songs(&hash_id))
}

#[tauri::command]
pub fn songlist_has_song(
    db: State<'_, Database>,
    hash_id: String,
    songmid: String,
    source: Option<String>,
) -> Result<bool, String> {
    Ok(db.has_song(&hash_id, &songmid, source.as_deref()))
}

#[tauri::command]
pub fn songlist_get_song(
    db: State<'_, Database>,
    hash_id: String,
    songmid: String,
    source: Option<String>,
) -> Result<Option<Songs>, String> {
    Ok(db.get_song(&hash_id, &songmid, source.as_deref()))
}

#[tauri::command]
pub fn songlist_add_songs(
    db: State<'_, Database>,
    hash_id: String,
    songs: Vec<Songs>,
) -> Result<i64, String> {
    // Electron's ManageSongList.addSongs inserts new songs at the head and
    // lazily fills an empty playlist cover from the first usable song image.
    let added = db.add_songs_head(&hash_id, &songs);
    if added > 0 {
        if let Some(playlist) = db.get_playlist(&hash_id) {
            if !is_usable_cover_url(&playlist.cover_img_url) {
                if let Some(cover) = find_usable_cover(&songs)
                    .or_else(|| find_usable_cover(&db.list_songs(&hash_id)))
                {
                    let _ = db.update_cover(&hash_id, &cover);
                }
            }
        }
    }
    Ok(added)
}

fn find_usable_cover(songs: &[Songs]) -> Option<String> {
    songs
        .iter()
        .map(|song| song.img.trim())
        .find(|img| is_usable_cover_url(img))
        .map(|img| img.to_string())
}

fn is_usable_cover_url(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value != "default-cover"
        && value != "/default-cover.png"
        && value != "resources/logo.png"
        && value != "logo.svg"
}

#[tauri::command]
pub fn songlist_remove_song(
    db: State<'_, Database>,
    hash_id: String,
    songmid: String,
    source: Option<String>,
) -> Result<bool, String> {
    Ok(db.remove_song(&hash_id, &songmid, source.as_deref()))
}

#[tauri::command]
pub fn songlist_remove_songs(
    db: State<'_, Database>,
    hash_id: String,
    songmids: Vec<String>,
) -> Result<i64, String> {
    Ok(db.remove_songs(&hash_id, &songmids))
}

#[tauri::command]
pub fn songlist_clear_songs(db: State<'_, Database>, hash_id: String) -> Result<(), String> {
    db.clear_songs(&hash_id)
}

#[tauri::command]
pub fn songlist_search_songs(
    db: State<'_, Database>,
    hash_id: String,
    keyword: String,
) -> Result<Vec<Songs>, String> {
    Ok(db.search_songs(&hash_id, &keyword))
}

#[tauri::command]
pub fn songlist_reorder_songs(
    db: State<'_, Database>,
    hash_id: String,
    songmids: Vec<String>,
) -> Result<i64, String> {
    Ok(db.reorder_songs(&hash_id, &songmids))
}

#[tauri::command]
pub fn songlist_reorder_playlists(
    db: State<'_, Database>,
    ordered_ids: Vec<String>,
) -> Result<i64, String> {
    if ordered_ids.is_empty() {
        return Ok(0);
    }
    Ok(db.reorder_playlists(&ordered_ids)?)
}

#[tauri::command]
pub fn songlist_move_song(
    db: State<'_, Database>,
    hash_id: String,
    songmid: String,
    to_index: i64,
) -> Result<bool, String> {
    Ok(db.move_song(&hash_id, &songmid, to_index))
}

#[tauri::command]
pub fn songlist_get_song_statistics(
    db: State<'_, Database>,
    hash_id: String,
) -> Result<SongStatistics, String> {
    Ok(db.get_song_statistics(&hash_id))
}

// ==================== URL Cache Commands ====================

#[tauri::command]
pub fn music_url_cache_get(db: State<'_, Database>, key: String) -> Result<Option<String>, String> {
    Ok(db.url_cache_get(&key))
}

#[tauri::command]
pub fn music_url_cache_save(
    db: State<'_, Database>,
    key: String,
    url: String,
) -> Result<(), String> {
    db.url_cache_save(&key, &url);
    Ok(())
}

#[tauri::command]
pub fn music_url_cache_invalidate(db: State<'_, Database>, song_id: String) -> Result<(), String> {
    db.url_cache_invalidate(&song_id);
    Ok(())
}

#[tauri::command]
pub fn music_url_cache_clear(db: State<'_, Database>) -> Result<(), String> {
    db.url_cache_clear();
    Ok(())
}

// ==================== Settings ====================

#[tauri::command]
pub fn get_user_config(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let val = db.get_setting("user_config").unwrap_or_else(|| "{}".into());
    serde_json::from_str(&val).map_err(|e| format!("解析配置失败: {}", e))
}

#[tauri::command]
pub fn settings_get_close_to_tray(db: State<'_, Database>) -> Result<bool, String> {
    let val = db
        .get_setting("close_to_tray")
        .unwrap_or_else(|| "true".into());
    Ok(val == "true")
}

fn read_native_impact_settings(db: &Database) -> serde_json::Value {
    let close_to_tray_raw = db.get_setting("close_to_tray");
    let mac_status_bar_lyric_raw = db.get_setting("mac_status_bar_lyric");
    let cache_dir_raw = db.get_setting("cache_dir");
    let download_dir_raw = db.get_setting("download_dir");
    let max_concurrent_raw = db.get_setting("max_concurrent_downloads");

    let close_to_tray = close_to_tray_raw
        .as_deref()
        .map(|v| v == "true")
        .unwrap_or(true);
    let mac_status_bar_lyric_enabled = mac_status_bar_lyric_raw
        .as_deref()
        .map(|v| v == "true")
        .unwrap_or(false);
    let max_concurrent_downloads = max_concurrent_raw
        .as_deref()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(3)
        .clamp(1, 16);

    serde_json::json!({
        "closeToTray": close_to_tray,
        "macStatusBarLyricEnabled": mac_status_bar_lyric_enabled,
        "directories": {
            "cacheDir": cache_dir_raw.clone().unwrap_or_default(),
            "downloadDir": download_dir_raw.clone().unwrap_or_default(),
        },
        "download": {
            "maxConcurrent": max_concurrent_downloads,
        },
        "hasPersisted": {
            "closeToTray": close_to_tray_raw.is_some(),
            "macStatusBarLyricEnabled": mac_status_bar_lyric_raw.is_some(),
            "cacheDir": cache_dir_raw.is_some(),
            "downloadDir": download_dir_raw.is_some(),
            "maxConcurrent": max_concurrent_raw.is_some(),
        }
    })
}

#[tauri::command]
pub fn settings_get_native_impact_settings(
    db: State<'_, Database>,
) -> Result<serde_json::Value, String> {
    Ok(read_native_impact_settings(&db))
}

#[tauri::command]
pub fn settings_set_native_impact_settings(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    settings: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if let Some(value) = settings.get("closeToTray").and_then(|v| v.as_bool()) {
        db.set_setting("close_to_tray", if value { "true" } else { "false" });
    }

    if let Some(value) = settings
        .get("macStatusBarLyricEnabled")
        .and_then(|v| v.as_bool())
    {
        db.set_setting("mac_status_bar_lyric", if value { "true" } else { "false" });
        let _ = app.emit("mac-status-bar-lyric-changed", value);
    }

    if let Some(directories) = settings.get("directories") {
        if let Some(cache_dir) = directories.get("cacheDir").and_then(|v| v.as_str()) {
            db.set_setting("cache_dir", cache_dir);
        }
        if let Some(download_dir) = directories.get("downloadDir").and_then(|v| v.as_str()) {
            db.set_setting("download_dir", download_dir);
        }
    }

    let max_concurrent = settings
        .get("download")
        .and_then(|download| download.get("maxConcurrent"))
        .or_else(|| settings.get("maxConcurrentDownloads"))
        .or_else(|| settings.get("maxConcurrent"))
        .and_then(|v| v.as_i64())
        .map(|value| value.clamp(1, 16));

    if let Some(value) = max_concurrent {
        db.set_setting("max_concurrent_downloads", &value.to_string());
        if let Some(engine) = app.try_state::<DownloadEngine>() {
            engine.wake();
        }
    }

    Ok(read_native_impact_settings(&db))
}

// ==================== Hotkeys ====================

#[tauri::command]
pub fn hotkeys_get(db: State<'_, Database>) -> Result<Vec<HotkeyEntry>, String> {
    Ok(db.get_hotkeys())
}

#[tauri::command]
pub fn hotkeys_set(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    payload: Vec<HotkeyEntry>,
) -> Result<serde_json::Value, String> {
    Ok(crate::hotkeys::save_and_apply(&app, &db, payload))
}

// ==================== Directory Settings ====================

fn default_cache_dir(app: &tauri::AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("music-cache").to_string_lossy().to_string())
        .unwrap_or_else(|_| "music-cache".to_string())
}

fn default_download_dir(app: &tauri::AppHandle) -> String {
    app.path()
        .download_dir()
        .map(|dir| dir.to_string_lossy().to_string())
        .or_else(|_| {
            app.path()
                .app_data_dir()
                .map(|dir| dir.join("downloads").to_string_lossy().to_string())
        })
        .unwrap_or_else(|_| "downloads".to_string())
}

fn directory_value(value: Option<String>, fallback: String) -> Option<String> {
    value
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .or(Some(fallback))
}

fn cache_storage_dir(app: &tauri::AppHandle, db: &Database) -> String {
    db.get_setting("cache_dir")
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .unwrap_or_else(|| default_cache_dir(app))
}

#[tauri::command]
pub fn directory_settings_get_directories(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<DirectorySettings, String> {
    let cache_dir = directory_value(db.get_setting("cache_dir"), default_cache_dir(&app));
    Ok(DirectorySettings {
        cache_dir,
        download_dir: directory_value(db.get_setting("download_dir"), default_download_dir(&app)),
    })
}

#[tauri::command]
pub fn directory_settings_save_directories(
    db: State<'_, Database>,
    directories: DirectorySettings,
) -> Result<serde_json::Value, String> {
    if let Some(d) = &directories.cache_dir {
        db.set_setting("cache_dir", d.trim());
    }
    if let Some(d) = &directories.download_dir {
        db.set_setting("download_dir", d.trim());
    }
    Ok(serde_json::json!({ "success": true }))
}

#[tauri::command]
pub fn directory_settings_reset_directories(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<serde_json::Value, String> {
    db.set_setting("cache_dir", "");
    db.set_setting("download_dir", "");
    Ok(serde_json::json!({
        "success": true,
        "directories": DirectorySettings {
            cache_dir: Some(default_cache_dir(&app)),
            download_dir: Some(default_download_dir(&app)),
        }
    }))
}

// ==================== Local Music ====================

#[tauri::command]
pub fn local_music_get_dirs(db: State<'_, Database>) -> Result<Vec<String>, String> {
    Ok(db.get_dirs())
}

#[tauri::command]
pub fn local_music_set_dirs(db: State<'_, Database>, dirs: Vec<String>) -> Result<(), String> {
    db.set_dirs(&dirs);
    Ok(())
}

#[tauri::command]
pub fn local_music_get_list(db: State<'_, Database>) -> Result<Vec<TrackRow>, String> {
    Ok(db.get_all_tracks())
}

#[tauri::command]
pub fn local_music_clear_index(db: State<'_, Database>) -> Result<(), String> {
    db.clear_tracks();
    Ok(())
}

// ==================== Download ====================

#[tauri::command]
pub fn download_get_tasks(db: State<'_, Database>) -> Result<Vec<DownloadTask>, String> {
    Ok(db.get_download_tasks())
}

#[tauri::command]
pub fn download_pause_task(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    task_id: String,
) -> Result<(), String> {
    // Signal running download to stop
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        if let Some(tx) = engine.cancel_signals.lock().unwrap().remove(&task_id) {
            let _ = tx.send(());
        }
    }
    db.update_download_task_status(&task_id, "paused");
    let tasks = db.get_download_tasks();
    if let Some(task) = tasks.into_iter().find(|t| t.task_id == task_id) {
        let _ = app.emit("download:task-status-changed", &task);
    }
    Ok(())
}

#[tauri::command]
pub fn download_resume_task(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    task_id: String,
) -> Result<(), String> {
    db.update_download_task_status(&task_id, "pending");
    // Reset retries on manual resume
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "UPDATE download_tasks SET retries = 0, updated_at = ?1 WHERE task_id = ?2",
        rusqlite::params![now, task_id],
    );
    drop(conn);
    let tasks = db.get_download_tasks();
    if let Some(task) = tasks.into_iter().find(|t| t.task_id == task_id) {
        let _ = app.emit("download:task-status-changed", &task);
    }
    // Wake engine
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.wake();
    }
    Ok(())
}

#[tauri::command]
pub fn download_cancel_task(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    task_id: String,
) -> Result<(), String> {
    let cancel_tx = app
        .try_state::<DownloadEngine>()
        .and_then(|engine| engine.cancel_signals.lock().unwrap().remove(&task_id));
    db.delete_download_task(&task_id);
    let _ = app.emit("download:task-deleted", &task_id);
    if let Some(tx) = cancel_tx {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn download_delete_task(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    task_id: String,
    delete_file: Option<bool>,
) -> Result<(), String> {
    let task = db.get_download_task(&task_id);
    let cancel_tx = app
        .try_state::<DownloadEngine>()
        .and_then(|engine| engine.cancel_signals.lock().unwrap().remove(&task_id));
    db.delete_download_task(&task_id);
    if delete_file.unwrap_or(false) {
        if let Some(task) = task {
            if !task.file_path.is_empty() {
                let _ = std::fs::remove_file(&task.file_path);
                let _ = std::fs::remove_file(format!("{}.temp", task.file_path));
            }
        }
    }
    let _ = app.emit("download:task-deleted", &task_id);
    if let Some(tx) = cancel_tx {
        let _ = tx.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn download_clear_tasks(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    r#type: String,
) -> Result<(), String> {
    let cancel_signals = if r#type == "all" || r#type == "queue" {
        app.try_state::<DownloadEngine>().map(|engine| {
            let mut signals = engine.cancel_signals.lock().unwrap();
            signals.drain().map(|(_, tx)| tx).collect::<Vec<_>>()
        })
    } else {
        None
    };
    match r#type.as_str() {
        "all" => db.clear_all_download_tasks(),
        "queue" => db.clear_download_queue_tasks(),
        "failed" => db.clear_failed_download_tasks(),
        status => db.clear_download_tasks_by_status(status),
    }
    if let Some(signals) = cancel_signals {
        for tx in signals {
            let _ = tx.send(());
        }
    }
    let remaining = db.get_download_tasks();
    let _ = app.emit("download:tasks-reset", &remaining);
    Ok(())
}

#[tauri::command]
pub fn download_pause_all_tasks(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<(), String> {
    // Signal all running downloads
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        let mut signals = engine.cancel_signals.lock().unwrap();
        for (_, tx) in signals.drain() {
            let _ = tx.send(());
        }
    }
    db.update_download_tasks_status("downloading", "paused");
    db.update_download_tasks_status("pending", "paused");
    let tasks = db.get_download_tasks();
    let _ = app.emit("download:tasks-reset", &tasks);
    Ok(())
}

#[tauri::command]
pub fn download_resume_all_tasks(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<(), String> {
    db.update_download_tasks_status("paused", "pending");
    // Reset retries for all resumed tasks
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "UPDATE download_tasks SET retries = 0 WHERE status = 'pending'",
        [],
    );
    drop(conn);
    let tasks = db.get_download_tasks();
    let _ = app.emit("download:tasks-reset", &tasks);
    // Wake engine
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.wake();
    }
    Ok(())
}

#[tauri::command]
pub fn download_retry_task(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    task_id: String,
) -> Result<(), String> {
    // Reset retries
    let now = chrono::Utc::now().to_rfc3339();
    let conn = db.conn.lock().unwrap();
    let _ = conn.execute(
        "UPDATE download_tasks SET status = 'pending', retries = 0, error_message = NULL, progress = 0, downloaded_bytes = 0, updated_at = ?1 WHERE task_id = ?2",
        rusqlite::params![now, task_id],
    );
    drop(conn);
    let tasks = db.get_download_tasks();
    if let Some(task) = tasks.into_iter().find(|t| t.task_id == task_id) {
        let _ = app.emit("download:task-status-changed", &task);
    }
    // Wake engine
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.wake();
    }
    Ok(())
}

#[tauri::command]
pub fn download_set_max_concurrent(db: State<'_, Database>, max: i64) -> Result<(), String> {
    db.set_setting("max_concurrent_downloads", &max.to_string());
    Ok(())
}

#[tauri::command]
pub fn download_get_max_concurrent(db: State<'_, Database>) -> Result<i64, String> {
    let val = db
        .get_setting("max_concurrent_downloads")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(3);
    Ok(val)
}

#[tauri::command]
pub fn download_validate_files(db: State<'_, Database>) -> Result<Vec<DownloadTask>, String> {
    let tasks = db.get_download_tasks();
    let mut updated = Vec::new();
    for task in tasks {
        if task.status == "completed" {
            let exists = std::path::Path::new(&task.file_path).exists();
            if !exists {
                let mut t = task;
                t.status = "error".into();
                t.error_message = Some("文件已不存在".into());
                let _ = db.upsert_download_task(&t);
                updated.push(t);
            } else {
                updated.push(task);
            }
        } else {
            updated.push(task);
        }
    }
    Ok(db.get_download_tasks())
}

#[tauri::command]
pub fn download_open_file_location(file_path: String) -> Result<(), String> {
    let p = std::path::Path::new(&file_path);
    if !p.exists() {
        return Err("文件不存在".into());
    }
    #[cfg(target_os = "macos")]
    {
        process_util::spawn_detached(std::process::Command::new("open").args(["-R", &file_path]))
            .map_err(|e| format!("打开文件位置失败: {}", e))?;
    }
    #[cfg(target_os = "windows")]
    {
        process_util::spawn_detached(
            std::process::Command::new("explorer").args(["/select,", &file_path]),
        )
        .map_err(|e| format!("打开文件位置失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = p.parent() {
            process_util::spawn_detached(std::process::Command::new("xdg-open").arg(parent))
                .map_err(|e| format!("打开文件位置失败: {}", e))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn download_queue_status(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let tasks = db.get_download_tasks();
    let total = tasks.len() as i64;
    let pending = tasks.iter().filter(|t| t.status == "pending").count() as i64;
    let downloading = tasks.iter().filter(|t| t.status == "downloading").count() as i64;
    let paused = tasks.iter().filter(|t| t.status == "paused").count() as i64;
    let completed = tasks.iter().filter(|t| t.status == "completed").count() as i64;
    let error = tasks.iter().filter(|t| t.status == "error").count() as i64;
    Ok(serde_json::json!({
        "total": total,
        "pending": pending,
        "downloading": downloading,
        "paused": paused,
        "completed": completed,
        "error": error,
    }))
}

#[tauri::command]
pub fn download_queue_cancel(
    app: tauri::AppHandle,
    db: State<'_, Database>,
    task_id: String,
) -> Result<(), String> {
    // Signal running download to stop
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        if let Some(tx) = engine.cancel_signals.lock().unwrap().remove(&task_id) {
            let _ = tx.send(());
        }
    }
    let _ = app.emit("download:task-deleted", &task_id);
    db.delete_download_task(&task_id);
    // Wake engine to process next tasks if any
    if let Some(engine) = app.try_state::<DownloadEngine>() {
        engine.wake();
    }
    Ok(())
}

/// Format bytes into a human-readable string (e.g. "12.45 MB").
fn format_file_size(bytes: i64) -> String {
    const UNITS: &[&str] = &["B", "KB", "MB", "GB", "TB"];
    let mut size = bytes as f64;
    let mut unit_idx = 0;
    while size >= 1024.0 && unit_idx < UNITS.len() - 1 {
        size /= 1024.0;
        unit_idx += 1;
    }
    if unit_idx == 0 {
        format!("{} {}", bytes, UNITS[unit_idx])
    } else {
        format!("{:.2} {}", size, UNITS[unit_idx])
    }
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

fn cache_directory_info(dir: &str) -> (i64, i64) {
    let mut count = 0i64;
    let mut size = 0i64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (count, size);
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() || !is_audio_cache_file(&path) {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            count += 1;
            size += metadata.len() as i64;
        }
    }

    (count, size)
}

// ==================== System ====================

#[tauri::command]
pub async fn music_cache_get_info(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<serde_json::Value, String> {
    let cache_dir = cache_storage_dir(&app, &db);
    tokio::task::spawn_blocking(move || {
        let (count, size) = cache_directory_info(&cache_dir);
        serde_json::json!({
            "size": size,
            "count": count,
            "trackCount": count,
            "sizeFormatted": format_file_size(size),
        })
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn music_cache_get_size(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<i64, String> {
    let cache_dir = cache_storage_dir(&app, &db);
    tokio::task::spawn_blocking(move || cache_directory_info(&cache_dir).1)
        .await
        .map_err(|e| e.to_string())
}

// ==================== Song List Extras ====================

/// Search playlists by keyword (global, not within a playlist).
#[tauri::command]
pub fn songlist_search(
    db: State<'_, Database>,
    keyword: String,
    _source: Option<String>,
) -> Result<Vec<SongList>, String> {
    let all = db.list_playlists();
    if keyword.is_empty() {
        return Ok(all);
    }
    let kw = keyword.to_lowercase();
    Ok(all
        .into_iter()
        .filter(|p| {
            p.name.to_lowercase().contains(&kw) || p.description.to_lowercase().contains(&kw)
        })
        .collect())
}

/// Get the favorites playlist ID (stored in settings).
#[tauri::command]
pub fn songlist_get_favorites_id(db: State<'_, Database>) -> Result<Option<String>, String> {
    Ok(db.get_setting("favorites_playlist_id"))
}

/// Set the favorites playlist ID.
#[tauri::command]
pub fn songlist_set_favorites_id(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.set_setting("favorites_playlist_id", &id);
    Ok(())
}

/// Validate playlist integrity (stub).
#[tauri::command]
pub fn songlist_validate_integrity(
    _db: State<'_, Database>,
    _hash_id: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "valid": true, "issues": [] }))
}

/// Repair playlist data (stub).
#[tauri::command]
pub fn songlist_repair_data(
    _db: State<'_, Database>,
    _hash_id: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "repaired": false, "message": "无需修复" }))
}

/// Force-save a playlist (stub).
#[tauri::command]
pub fn songlist_force_save(
    _db: State<'_, Database>,
    _hash_id: String,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "success": true }))
}
