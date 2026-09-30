use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::models::*;

pub struct Database {
    pub conn: Mutex<Connection>,
}

impl Database {
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
        let db_path = app_data_dir.join("ceru-music.db");
        let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

        conn.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| format!("设置 pragma 失败: {}", e))?;

        Self::migrate(&conn)?;

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn migrate(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS playlists (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT DEFAULT '',
                cover_img_url TEXT DEFAULT 'default-cover',
                source       TEXT NOT NULL,
                meta         TEXT DEFAULT '{}',
                create_time  TEXT NOT NULL,
                update_time  TEXT NOT NULL
                ,position    INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS playlist_songs (
                playlist_id  TEXT NOT NULL,
                songmid      TEXT NOT NULL,
                source       TEXT NOT NULL DEFAULT '',
                position     INTEGER NOT NULL,
                data         TEXT NOT NULL,
                name         TEXT DEFAULT '',
                singer       TEXT DEFAULT '',
                album_name   TEXT DEFAULT '',
                img          TEXT DEFAULT '',
                PRIMARY KEY (playlist_id, songmid, source),
                FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_ps_pos ON playlist_songs(playlist_id, position);
            CREATE INDEX IF NOT EXISTS idx_ps_name ON playlist_songs(playlist_id, name);

            CREATE TABLE IF NOT EXISTS url_cache (
                song_id     TEXT PRIMARY KEY,
                url         TEXT NOT NULL,
                updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
            );

            CREATE TABLE IF NOT EXISTS tracks (
                songmid      TEXT PRIMARY KEY,
                path         TEXT NOT NULL UNIQUE,
                url          TEXT,
                singer       TEXT DEFAULT '',
                name         TEXT DEFAULT '',
                album_name   TEXT DEFAULT '',
                album_id     INTEGER DEFAULT 0,
                source       TEXT DEFAULT 'local',
                interval     TEXT DEFAULT '',
                has_cover    INTEGER DEFAULT 0,
                cover_key    TEXT,
                year         INTEGER DEFAULT 0,
                lrc          TEXT,
                types        TEXT DEFAULT '[]',
                _types       TEXT DEFAULT '{}',
                type_url     TEXT DEFAULT '{}',
                bitrate      INTEGER DEFAULT 0,
                sample_rate  INTEGER DEFAULT 0,
                channels     INTEGER DEFAULT 0,
                duration     REAL DEFAULT 0,
                size         INTEGER DEFAULT 0,
                mtime_ms     INTEGER DEFAULT 0,
                hash         TEXT,
                updated_at   INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_tracks_path ON tracks(path);

            CREATE TABLE IF NOT EXISTS dirs (
                path TEXT PRIMARY KEY
            );

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS hotkeys (
                action   TEXT PRIMARY KEY,
                shortcut TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS download_tasks (
                task_id          TEXT PRIMARY KEY,
                songmid          TEXT NOT NULL,
                url              TEXT NOT NULL,
                file_path        TEXT NOT NULL,
                status           TEXT NOT NULL DEFAULT 'pending',
                progress         REAL NOT NULL DEFAULT 0,
                total_bytes      INTEGER NOT NULL DEFAULT 0,
                downloaded_bytes INTEGER NOT NULL DEFAULT 0,
                name             TEXT DEFAULT '',
                singer           TEXT DEFAULT '',
                cover            TEXT DEFAULT '',
                error_message    TEXT,
                retries          INTEGER NOT NULL DEFAULT 0,
                created_at       TEXT NOT NULL,
                updated_at       TEXT NOT NULL,
                song_info        TEXT DEFAULT '{}',
                tag_write_options TEXT DEFAULT '{}',
                plugin_id        TEXT,
                quality          TEXT,
                metadata_error   TEXT
            );

            CREATE TABLE IF NOT EXISTS plugin_registry (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                plugin_type  TEXT NOT NULL DEFAULT 'unknown',
                version      TEXT DEFAULT '',
                author       TEXT DEFAULT '',
                description  TEXT DEFAULT '',
                enabled      INTEGER NOT NULL DEFAULT 1,
                source       TEXT DEFAULT '',
                installed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plugin_configs (
                plugin_id TEXT NOT NULL PRIMARY KEY,
                config    TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY (plugin_id) REFERENCES plugin_registry(id) ON DELETE CASCADE
            );
        ",
        )
        .map_err(|e| format!("数据库迁移失败: {}", e))?;

        for stmt in [
            "ALTER TABLE download_tasks ADD COLUMN song_info TEXT DEFAULT '{}'",
            "ALTER TABLE download_tasks ADD COLUMN tag_write_options TEXT DEFAULT '{}'",
            "ALTER TABLE download_tasks ADD COLUMN plugin_id TEXT",
            "ALTER TABLE download_tasks ADD COLUMN quality TEXT",
            "ALTER TABLE download_tasks ADD COLUMN metadata_error TEXT",
        ] {
            let _ = conn.execute(stmt, []);
        }
        let _ = conn.execute(
            "ALTER TABLE playlists ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE plugin_registry ADD COLUMN position INTEGER NOT NULL DEFAULT 0",
            [],
        );
        Self::migrate_playlist_song_sources(conn)?;
        Self::repair_empty_song_sources(conn)?;
        conn.execute_batch(
            "UPDATE playlists SET position = ranked.position
             FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY create_time ASC, id ASC) - 1 AS position FROM playlists WHERE position = 0) AS ranked
             WHERE playlists.id = ranked.id AND playlists.position = 0;",
        ).ok();

        Ok(())
    }

    // ==================== Settings ====================

    fn migrate_playlist_song_sources(conn: &Connection) -> Result<(), String> {
        let columns = conn
            .prepare("PRAGMA table_info(playlist_songs)")
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |row| {
                    Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
                })?;
                Ok(rows.filter_map(Result::ok).collect::<Vec<_>>())
            })
            .map_err(|e| format!("检查歌单歌曲结构失败: {}", e))?;
        if columns.iter().any(|(name, pk)| name == "source" && *pk > 0) {
            return Ok(());
        }
        conn.execute_batch("DROP INDEX IF EXISTS idx_ps_pos; DROP INDEX IF EXISTS idx_ps_name; ALTER TABLE playlist_songs RENAME TO playlist_songs_legacy;").map_err(|e| format!("升级歌单歌曲表失败: {}", e))?;
        conn.execute_batch("CREATE TABLE playlist_songs (playlist_id TEXT NOT NULL, songmid TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL, data TEXT NOT NULL, name TEXT DEFAULT '', singer TEXT DEFAULT '', album_name TEXT DEFAULT '', img TEXT DEFAULT '', PRIMARY KEY (playlist_id, songmid, source), FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE); CREATE INDEX idx_ps_pos ON playlist_songs(playlist_id, position); CREATE INDEX idx_ps_name ON playlist_songs(playlist_id, name);").map_err(|e| format!("创建升级后的歌单歌曲表失败: {}", e))?;
        let mut stmt = conn.prepare("SELECT playlist_id, songmid, position, data, name, singer, album_name, img FROM playlist_songs_legacy").map_err(|e| format!("读取旧歌单歌曲失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| format!("读取旧歌单歌曲记录失败: {}", e))?;
        for row in rows {
            let (playlist_id, songmid, position, data, name, singer, album_name, img) =
                row.map_err(|e| format!("读取旧歌单歌曲记录失败: {}", e))?;
            let source = Songs::from_stored_json(&data)
                .map(|song| song.source)
                .unwrap_or_default();
            conn.execute("INSERT OR IGNORE INTO playlist_songs (playlist_id, songmid, source, position, data, name, singer, album_name, img) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)", params![playlist_id, songmid, source, position, data, name, singer, album_name, img]).map_err(|e| format!("迁移旧歌单歌曲失败: {}", e))?;
        }
        drop(stmt);
        conn.execute("DROP TABLE playlist_songs_legacy", [])
            .map_err(|e| format!("清理旧歌单歌曲表失败: {}", e))?;
        Ok(())
    }

    fn repair_empty_song_sources(conn: &Connection) -> Result<(), String> {
        let mut stmt = conn
            .prepare("SELECT playlist_id, songmid, data FROM playlist_songs WHERE source = ''")
            .map_err(|e| format!("读取缺少来源的歌曲失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("读取缺少来源的歌曲失败: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取缺少来源的歌曲失败: {}", e))?;
        drop(stmt);
        for (playlist_id, songmid, data) in rows {
            let source = Songs::source_from_stored_json(&data);
            if source.is_empty() {
                continue;
            }
            let exists = conn
                .query_row(
                    "SELECT 1 FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 AND source = ?3 LIMIT 1",
                    params![playlist_id, songmid, source],
                    |_| Ok(true),
                )
                .unwrap_or(false);
            if exists {
                let position = conn
                    .query_row(
                        "SELECT position FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 AND source = ''",
                        params![playlist_id, songmid],
                        |row| row.get::<_, i64>(0),
                    )
                    .ok();
                if let Some(position) = position {
                    conn.execute(
                        "UPDATE playlist_songs SET position = ?1 WHERE playlist_id = ?2 AND songmid = ?3 AND source = ?4",
                        params![position, playlist_id, songmid, source],
                    )
                    .map_err(|e| format!("调整已收藏歌曲顺序失败: {}", e))?;
                }
                conn.execute(
                    "DELETE FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 AND source = ''",
                    params![playlist_id, songmid],
                )
                .map_err(|e| format!("清理重复收藏失败: {}", e))?;
                continue;
            }
            conn.execute(
                "UPDATE playlist_songs SET source = ?1 WHERE playlist_id = ?2 AND songmid = ?3 AND source = ''",
                params![source, playlist_id, songmid],
            )
            .map_err(|e| format!("补齐歌曲来源失败: {}", e))?;
        }
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    // ==================== Playlists ====================
    pub fn set_setting(&self, key: &str, value: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
            params![key, value],
        ).ok();
    }

    pub fn list_playlists(&self) -> Vec<SongList> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM playlists ORDER BY position ASC, create_time ASC, id ASC")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                let meta_str: String = row.get("meta")?;
                Ok(SongList {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    description: row.get("description")?,
                    cover_img_url: row.get("cover_img_url")?,
                    source: row.get("source")?,
                    meta: serde_json::from_str(&meta_str)
                        .unwrap_or(serde_json::Value::Object(Default::default())),
                    create_time: row.get("create_time")?,
                    update_time: row.get("update_time")?,
                    position: row.get("position").unwrap_or(0),
                })
            })
            .unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn get_playlist(&self, id: &str) -> Option<SongList> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM playlists WHERE id = ?1",
            params![id],
            |row| {
                let meta_str: String = row.get("meta")?;
                Ok(SongList {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    description: row.get("description")?,
                    cover_img_url: row.get("cover_img_url")?,
                    source: row.get("source")?,
                    meta: serde_json::from_str(&meta_str)
                        .unwrap_or(serde_json::Value::Object(Default::default())),
                    create_time: row.get("create_time")?,
                    update_time: row.get("update_time")?,
                    position: row.get("position").unwrap_or(0),
                })
            },
        )
        .ok()
    }

    pub fn playlist_exists(&self, id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT 1 FROM playlists WHERE id = ?1 LIMIT 1",
            params![id],
            |_| Ok(true),
        )
        .unwrap_or(false)
    }

    pub fn insert_playlist(&self, p: &SongList) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let position: i64 = conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM playlists",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        conn.execute(
            "INSERT INTO playlists (id, name, description, cover_img_url, source, meta, create_time, update_time, position) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                p.id, p.name, p.description,
                p.cover_img_url, p.source,
                serde_json::to_string(&p.meta).unwrap_or_default(),
                p.create_time, p.update_time,
                position,
            ],
        ).map_err(|e| format!("插入歌单失败: {}", e))?;
        Ok(())
    }

    pub fn reorder_playlists(&self, ordered_ids: &[String]) -> Result<i64, String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始歌单排序事务失败: {}", e))?;
        for (position, id) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE playlists SET position = ?1, update_time = ?2 WHERE id = ?3",
                params![position as i64, chrono::Utc::now().to_rfc3339(), id],
            )
            .map_err(|e| format!("保存歌单顺序失败: {}", e))?;
        }
        tx.commit()
            .map_err(|e| format!("提交歌单排序失败: {}", e))?;
        Ok(ordered_ids.len() as i64)
    }

    pub fn delete_playlist(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])
            .map_err(|e| format!("删除歌单失败: {}", e))?;
        Ok(())
    }

    pub fn update_playlist(
        &self,
        id: &str,
        name: Option<&str>,
        description: Option<&str>,
        cover_img_url: Option<&str>,
        source: Option<&str>,
        meta: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let meta_str = meta.map(|m| serde_json::to_string(m).unwrap_or_default());
        conn.execute(
            "UPDATE playlists SET
                name = COALESCE(?1, name),
                description = COALESCE(?2, description),
                cover_img_url = COALESCE(?3, cover_img_url),
                source = COALESCE(?4, source),
                meta = COALESCE(?5, meta),
                update_time = ?6
             WHERE id = ?7",
            params![name, description, cover_img_url, source, meta_str, now, id],
        )
        .map_err(|e| format!("更新歌单失败: {}", e))?;
        Ok(())
    }

    pub fn update_cover(&self, id: &str, cover_img_url: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE playlists SET cover_img_url = ?1, update_time = ?2 WHERE id = ?3",
            params![cover_img_url, now, id],
        )
        .map_err(|e| format!("更新封面失败: {}", e))?;
        Ok(())
    }

    // ==================== Playlist Songs ====================

    pub fn list_songs(&self, playlist_id: &str) -> Vec<Songs> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM playlist_songs WHERE playlist_id = ?1 ORDER BY position ASC")
            .unwrap();
        let rows = stmt
            .query_map(params![playlist_id], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .unwrap();
        rows.filter_map(|r| {
            let data = r.ok()?;
            Songs::from_stored_json(&data)
        })
        .collect()
    }

    pub fn count_songs(&self, playlist_id: &str) -> i64 {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .unwrap_or(0)
    }

    pub fn has_song(&self, playlist_id: &str, songmid: &str, source: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        let result = if let Some(source) = source.filter(|value| !value.is_empty()) {
            conn.query_row(
                "SELECT 1 FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 AND source = ?3 LIMIT 1",
                params![playlist_id, songmid, source],
                |_| Ok(true),
            )
        } else {
            conn.query_row(
                "SELECT 1 FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 LIMIT 1",
                params![playlist_id, songmid],
                |_| Ok(true),
            )
        };
        result.unwrap_or(false)
    }

    pub fn get_song(
        &self,
        playlist_id: &str,
        songmid: &str,
        source: Option<&str>,
    ) -> Option<Songs> {
        let conn = self.conn.lock().unwrap();
        let query = if source.filter(|value| !value.is_empty()).is_some() {
            "SELECT data FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 AND source = ?3"
        } else {
            "SELECT data FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2"
        };
        let result = if let Some(source) = source.filter(|value| !value.is_empty()) {
            conn.query_row(query, params![playlist_id, songmid, source], |row| {
                let data: String = row.get(0)?;
                Songs::from_stored_json(&data).ok_or_else(|| {
                    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        "playlist song json is invalid",
                    )))
                })
            })
        } else {
            conn.query_row(query, params![playlist_id, songmid], |row| {
                let data: String = row.get(0)?;
                Songs::from_stored_json(&data).ok_or_else(|| rusqlite::Error::InvalidQuery)
            })
        };
        result.ok()
    }

    pub fn min_position(&self, playlist_id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT MIN(position) FROM playlist_songs WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .ok()
        .flatten()
    }

    pub fn max_position(&self, playlist_id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT MAX(position) FROM playlist_songs WHERE playlist_id = ?1",
            params![playlist_id],
            |row| row.get(0),
        )
        .ok()
        .flatten()
    }

    pub fn insert_song_raw(
        &self,
        playlist_id: &str,
        songmid: &str,
        position: i64,
        data: &str,
        name: &str,
        singer: &str,
        album_name: &str,
        img: &str,
    ) -> bool {
        let conn = self.conn.lock().unwrap();
        let source = Songs::source_from_stored_json(data);
        conn.execute(
            "INSERT OR IGNORE INTO playlist_songs (playlist_id, songmid, source, position, data, name, singer, album_name, img)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![playlist_id, songmid, source, position, data, name, singer, album_name, img],
        ).map(|c| c > 0).unwrap_or(false)
    }

    pub fn add_songs_head(&self, playlist_id: &str, songs: &[Songs]) -> i64 {
        let min_pos = self.min_position(playlist_id).unwrap_or(0);
        let mut inserted = 0i64;
        let mut seen = std::collections::HashSet::new();
        // reverse to maintain order: first song goes to front
        for (i, song) in songs.iter().enumerate() {
            let mid = &song.songmid;
            let key = format!("{}:{}", song.source, mid);
            if mid.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            let position = min_pos - (songs.len() as i64) + (i as i64);
            let data = serde_json::to_string(song).unwrap_or_default();
            let inserted_new = self.insert_song_raw(
                playlist_id,
                mid,
                position,
                &data,
                &song.name,
                &song.singer,
                &song.album_name,
                &song.img,
            );
            let moved = if inserted_new {
                false
            } else {
                self.bring_song_to_position(
                    playlist_id,
                    mid,
                    &song.source,
                    position,
                    &data,
                    &song.name,
                    &song.singer,
                    &song.album_name,
                    &song.img,
                )
            };
            if inserted_new || moved {
                inserted += 1;
            }
        }
        inserted
    }

    fn bring_song_to_position(
        &self,
        playlist_id: &str,
        songmid: &str,
        source: &str,
        position: i64,
        data: &str,
        name: &str,
        singer: &str,
        album_name: &str,
        img: &str,
    ) -> bool {
        let source = if source.is_empty() {
            Songs::source_from_stored_json(data)
        } else {
            source.to_string()
        };
        if source.is_empty() {
            return false;
        }
        let conn = self.conn.lock().unwrap();
        let updated = conn
            .execute(
                "UPDATE playlist_songs SET position = ?1, data = ?2, name = ?3, singer = ?4, album_name = ?5, img = ?6
                 WHERE playlist_id = ?7 AND songmid = ?8 AND source = ?9",
                params![position, data, name, singer, album_name, img, playlist_id, songmid, source],
            )
            .unwrap_or(0);
        updated > 0
    }

    pub fn append_songs(&self, playlist_id: &str, songs: &[Songs]) -> i64 {
        let max_pos = self.max_position(playlist_id).unwrap_or(-1);
        let mut pos = max_pos + 1;
        let mut inserted = 0i64;
        let mut seen = std::collections::HashSet::new();
        for song in songs {
            let mid = &song.songmid;
            let key = format!("{}:{}", song.source, mid);
            if mid.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            let data = serde_json::to_string(song).unwrap_or_default();
            if self.insert_song_raw(
                playlist_id,
                mid,
                pos,
                &data,
                &song.name,
                &song.singer,
                &song.album_name,
                &song.img,
            ) {
                inserted += 1;
                pos += 1;
            }
        }
        inserted
    }

    pub fn remove_song(&self, playlist_id: &str, songmid: &str, source: Option<&str>) -> bool {
        let conn = self.conn.lock().unwrap();
        let result = if let Some(source) = source.filter(|value| !value.is_empty()) {
            conn.execute(
                "DELETE FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2 AND source = ?3",
                params![playlist_id, songmid, source],
            )
        } else {
            conn.execute(
                "DELETE FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2",
                params![playlist_id, songmid],
            )
        };
        result.map(|c| c > 0).unwrap_or(false)
    }

    pub fn remove_songs(&self, playlist_id: &str, songmids: &[String]) -> i64 {
        let mut removed = 0i64;
        for value in songmids {
            let (mid, source) = match value.split_once(':') {
                Some((source, mid)) if !source.is_empty() && !mid.is_empty() => (mid, Some(source)),
                _ => (value.as_str(), None),
            };
            if self.remove_song(playlist_id, mid, source) {
                removed += 1;
            }
        }
        removed
    }

    pub fn clear_songs(&self, playlist_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM playlist_songs WHERE playlist_id = ?1",
            params![playlist_id],
        )
        .map_err(|e| format!("清空歌曲失败: {}", e))?;
        Ok(())
    }

    pub fn search_songs(&self, playlist_id: &str, keyword: &str) -> Vec<Songs> {
        let conn = self.conn.lock().unwrap();
        let kw = format!("%{}%", keyword.replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = conn.prepare(
            "SELECT data FROM playlist_songs
             WHERE playlist_id = ?1
               AND (name LIKE ?2 ESCAPE '\\' OR singer LIKE ?2 ESCAPE '\\' OR album_name LIKE ?2 ESCAPE '\\')
             ORDER BY position ASC"
        ).unwrap();
        let rows = stmt
            .query_map(params![playlist_id, kw], |row| {
                let data: String = row.get(0)?;
                Ok(data)
            })
            .unwrap();
        rows.filter_map(|r| {
            let data = r.ok()?;
            serde_json::from_str(&data).ok()
        })
        .collect()
    }

    pub fn reorder_songs(&self, playlist_id: &str, songmids: &[String]) -> i64 {
        let conn = self.conn.lock().unwrap();
        let mut updated = 0i64;
        for (i, value) in songmids.iter().enumerate() {
            let (mid, source) = match value.split_once(':') {
                Some((source, mid)) if !source.is_empty() && !mid.is_empty() => (mid, Some(source)),
                _ => (value.as_str(), None),
            };
            let r = conn.execute(
                "UPDATE playlist_songs SET position = ?1 WHERE playlist_id = ?2 AND songmid = ?3 AND (?4 IS NULL OR source = ?4)",
                params![i as i64, playlist_id, mid, source],
            ).unwrap_or(0);
            if r > 0 {
                updated += 1;
            }
        }
        updated
    }

    pub fn move_song(&self, playlist_id: &str, songmid: &str, to_index: i64) -> bool {
        let conn = self.conn.lock().unwrap();
        let total = self.count_songs(playlist_id);
        let clamped = to_index.max(0).min(total - 1);

        let cur_pos: Option<i64> = conn
            .query_row(
                "SELECT position FROM playlist_songs WHERE playlist_id = ?1 AND songmid = ?2",
                params![playlist_id, songmid],
                |row| row.get(0),
            )
            .ok();
        let cur_pos = match cur_pos {
            Some(p) => p,
            None => return false,
        };

        let target_pos: Option<i64> = conn.query_row(
            "SELECT position FROM playlist_songs WHERE playlist_id = ?1 ORDER BY position ASC LIMIT 1 OFFSET ?2",
            params![playlist_id, clamped], |row| row.get(0),
        ).ok().flatten();
        let target_pos = match target_pos {
            Some(p) => p,
            None => return false,
        };

        if cur_pos == target_pos {
            return false;
        }

        if cur_pos < target_pos {
            conn.execute("UPDATE playlist_songs SET position = position - 1 WHERE playlist_id = ?1 AND position > ?2 AND position <= ?3",
                         params![playlist_id, cur_pos, target_pos]).ok();
        } else {
            conn.execute("UPDATE playlist_songs SET position = position + 1 WHERE playlist_id = ?1 AND position >= ?2 AND position < ?3",
                         params![playlist_id, target_pos, cur_pos]).ok();
        }
        conn.execute(
            "UPDATE playlist_songs SET position = ?1 WHERE playlist_id = ?2 AND songmid = ?3",
            params![target_pos, playlist_id, songmid],
        )
        .ok();
        true
    }

    // ==================== URL Cache ====================

    pub fn url_cache_get(&self, song_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT url, updated_at FROM url_cache WHERE song_id = ?1",
                params![song_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .ok()?;
        let max_age_seconds = if song_id.starts_with("git_") {
            7 * 24 * 60 * 60
        } else {
            6 * 60 * 60
        };
        if row.0.is_empty() {
            return None;
        }
        if row.1 > 0 && chrono::Utc::now().timestamp() - row.1 > max_age_seconds {
            conn.execute("DELETE FROM url_cache WHERE song_id = ?1", params![song_id])
                .ok();
            return None;
        }
        Some(row.0)
    }

    pub fn url_cache_save(&self, song_id: &str, url: &str) {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().timestamp();
        conn.execute(
            "INSERT INTO url_cache (song_id, url, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(song_id) DO UPDATE SET url = ?2, updated_at = ?3",
            params![song_id, url, now],
        )
        .ok();
    }

    pub fn url_cache_invalidate(&self, song_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM url_cache WHERE song_id = ?1", params![song_id])
            .ok();
    }

    pub fn url_cache_clear(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM url_cache", []).ok();
    }

    // ==================== Local Music ====================

    pub fn get_all_tracks(&self) -> Vec<TrackRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT * FROM tracks").unwrap();
        let rows = stmt.query_map([], Self::map_track_row).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn get_track_by_id(&self, songmid: &str) -> Option<TrackRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM tracks WHERE songmid = ?1",
            params![songmid],
            Self::map_track_row,
        )
        .ok()
    }

    pub fn get_track_by_path(&self, path: &str) -> Option<TrackRow> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM tracks WHERE path = ?1",
            params![path],
            Self::map_track_row,
        )
        .ok()
    }

    pub fn upsert_track(&self, row: &TrackRow) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tracks (songmid, path, url, singer, name, album_name, album_id, source, interval,
             has_cover, cover_key, year, lrc, types, _types, type_url, bitrate, sample_rate, channels,
             duration, size, mtime_ms, hash, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)
             ON CONFLICT(songmid) DO UPDATE SET
             path=excluded.path, url=excluded.url, singer=excluded.singer, name=excluded.name,
             album_name=excluded.album_name, album_id=excluded.album_id, source=excluded.source,
             interval=excluded.interval, has_cover=excluded.has_cover, cover_key=excluded.cover_key,
             year=excluded.year, lrc=excluded.lrc, types=excluded.types, _types=excluded._types,
             type_url=excluded.type_url, bitrate=excluded.bitrate, sample_rate=excluded.sample_rate,
             channels=excluded.channels, duration=excluded.duration, size=excluded.size,
             mtime_ms=excluded.mtime_ms, hash=excluded.hash, updated_at=excluded.updated_at",
            params![
                row.songmid, row.path, row.url, row.singer, row.name, row.album_name,
                row.album_id, row.source, row.interval, row.has_cover, row.cover_key,
                row.year, row.lrc, row.types, row._types, row.type_url, row.bitrate,
                row.sample_rate, row.channels, row.duration, row.size, row.mtime_ms,
                row.hash, row.updated_at,
            ],
        ).ok();
    }

    pub fn delete_track_by_path(&self, path: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks WHERE path = ?1", params![path])
            .ok();
    }

    pub fn clear_tracks(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM tracks", []).ok();
    }

    /// Remove tracks whose paths are not in `keep_paths` and whose paths
    /// start with one of the `dirs` prefixes (managed dirs only).
    pub fn prune_by_scan(&self, dirs: &[String], keep_paths: &std::collections::HashSet<String>) {
        let conn = self.conn.lock().unwrap();
        // Build prefix conditions for managed dirs
        for dir in dirs {
            let prefix = if dir.ends_with('/') {
                dir.clone()
            } else {
                format!("{}/", dir)
            };
            let _ = conn.execute(
                "DELETE FROM tracks WHERE path LIKE ?1 AND path NOT IN (SELECT path FROM tracks WHERE path = ?2)",
                params![format!("{}%", prefix), ""], // skip since we use NOT IN with kept set
            );
        }
        // Delete tracks not in keep_paths and whose path is non-empty
        if !keep_paths.is_empty() {
            // SQLite doesn't support huge IN lists well, so we delete in chunks
            let all: Vec<String> = {
                let mut stmt = conn.prepare("SELECT path FROM tracks").unwrap();
                let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
                rows.filter_map(|r| r.ok())
                    .filter(|p| !keep_paths.contains(p))
                    .collect()
            };
            for path in all {
                let _ = conn.execute("DELETE FROM tracks WHERE path = ?1", params![path]);
            }
        }
    }

    pub fn get_dirs(&self) -> Vec<String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT path FROM dirs").unwrap();
        let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn set_dirs(&self, dirs: &[String]) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM dirs", []).ok();
        for d in dirs {
            conn.execute("INSERT OR IGNORE INTO dirs(path) VALUES (?1)", params![d])
                .ok();
        }
    }

    fn map_track_row(row: &rusqlite::Row) -> rusqlite::Result<TrackRow> {
        Ok(TrackRow {
            songmid: row.get("songmid")?,
            path: row.get("path")?,
            url: row.get("url")?,
            singer: row.get("singer")?,
            name: row.get("name")?,
            album_name: row.get("album_name")?,
            album_id: row.get("album_id")?,
            source: row.get("source")?,
            interval: row.get("interval")?,
            has_cover: row.get("has_cover")?,
            cover_key: row.get("cover_key")?,
            year: row.get("year")?,
            lrc: row.get("lrc")?,
            types: row.get("types")?,
            _types: row.get("_types")?,
            type_url: row.get("type_url")?,
            bitrate: row.get("bitrate")?,
            sample_rate: row.get("sample_rate")?,
            channels: row.get("channels")?,
            duration: row.get("duration")?,
            size: row.get("size")?,
            mtime_ms: row.get("mtime_ms")?,
            hash: row.get("hash")?,
            updated_at: row.get("updated_at")?,
        })
    }

    // ==================== Hotkeys ====================

    pub fn get_hotkeys(&self) -> Vec<HotkeyEntry> {
        let stored = self.read_stored_hotkeys();
        if stored.is_empty() {
            let defaults = Self::default_hotkeys();
            if self.hotkeys_enabled() {
                self.set_hotkeys(&defaults);
            }
            return defaults;
        }
        let stored_len = stored.len();
        let mut merged = stored;
        for default in Self::default_hotkeys() {
            if !merged.iter().any(|item| item.action == default.action) {
                merged.push(default);
            }
        }
        if merged.len() != stored_len && self.hotkeys_enabled() {
            self.set_hotkeys(&merged);
        }
        merged
    }

    fn read_stored_hotkeys(&self) -> Vec<HotkeyEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT action, shortcut FROM hotkeys")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok(HotkeyEntry {
                    action: row.get(0)?,
                    shortcut: row.get(1)?,
                })
            })
            .unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn hotkeys_enabled(&self) -> bool {
        self.get_setting("hotkeys_enabled")
            .map(|value| value != "false")
            .unwrap_or(true)
    }

    pub fn set_hotkeys_enabled(&self, enabled: bool) {
        self.set_setting("hotkeys_enabled", if enabled { "true" } else { "false" });
    }

    pub fn default_hotkeys() -> Vec<HotkeyEntry> {
        vec![
            HotkeyEntry {
                action: "toggle".into(),
                shortcut: "CommandOrControl+Alt+P".into(),
            },
            HotkeyEntry {
                action: "playPrev".into(),
                shortcut: "CommandOrControl+Alt+Left".into(),
            },
            HotkeyEntry {
                action: "playNext".into(),
                shortcut: "CommandOrControl+Alt+Right".into(),
            },
            HotkeyEntry {
                action: "seekBackward".into(),
                shortcut: "CommandOrControl+Alt+J".into(),
            },
            HotkeyEntry {
                action: "seekForward".into(),
                shortcut: "CommandOrControl+Alt+L".into(),
            },
            HotkeyEntry {
                action: "volumeDown".into(),
                shortcut: "CommandOrControl+Alt+Down".into(),
            },
            HotkeyEntry {
                action: "volumeUp".into(),
                shortcut: "CommandOrControl+Alt+Up".into(),
            },
            HotkeyEntry {
                action: "toggleDesktopLyric".into(),
                shortcut: "CommandOrControl+Alt+D".into(),
            },
            HotkeyEntry {
                action: "setPlayModeSequence".into(),
                shortcut: "CommandOrControl+Alt+4".into(),
            },
            HotkeyEntry {
                action: "setPlayModeRandom".into(),
                shortcut: "CommandOrControl+Alt+5".into(),
            },
            HotkeyEntry {
                action: "togglePlayModeSingle".into(),
                shortcut: "CommandOrControl+Alt+6".into(),
            },
            HotkeyEntry {
                action: "toggleAudioOutputSelector".into(),
                shortcut: "Alt+O".into(),
            },
        ]
    }

    pub fn set_hotkeys(&self, keys: &[HotkeyEntry]) {
        let mut map: HashMap<String, String> = HashMap::new();
        for default in Self::default_hotkeys() {
            map.insert(default.action, String::new());
        }
        for key in keys {
            map.insert(key.action.clone(), key.shortcut.clone());
        }
        let mut ordered = Vec::new();
        for default in Self::default_hotkeys() {
            if let Some(shortcut) = map.remove(&default.action) {
                ordered.push(HotkeyEntry {
                    action: default.action,
                    shortcut,
                });
            }
        }
        for (action, shortcut) in map {
            ordered.push(HotkeyEntry { action, shortcut });
        }
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM hotkeys", []).ok();
        for key in &ordered {
            conn.execute(
                "INSERT INTO hotkeys (action, shortcut) VALUES (?1, ?2)",
                params![key.action, key.shortcut],
            )
            .ok();
        }
    }

    // ==================== Download Tasks ====================

    pub fn get_download_tasks(&self) -> Vec<DownloadTask> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM download_tasks ORDER BY created_at DESC")
            .unwrap();
        let rows = stmt.query_map([], Self::map_download_task).unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn get_download_task(&self, task_id: &str) -> Option<DownloadTask> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM download_tasks WHERE task_id = ?1",
            params![task_id],
            Self::map_download_task,
        )
        .ok()
    }

    pub fn clear_download_queue_tasks(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM download_tasks WHERE status IN ('pending', 'downloading', 'paused')",
            [],
        )
        .ok();
    }

    pub fn clear_failed_download_tasks(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM download_tasks WHERE status IN ('error', 'failed', 'cancelled')",
            [],
        )
        .ok();
    }

    pub fn upsert_download_task(&self, task: &DownloadTask) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let song_info = serde_json::to_string(&task.song_info).unwrap_or_else(|_| "{}".to_string());
        let tag_write_options =
            serde_json::to_string(&task.tag_write_options).unwrap_or_else(|_| "{}".to_string());
        conn.execute(
            "INSERT INTO download_tasks (task_id, songmid, url, file_path, status, progress,
             total_bytes, downloaded_bytes, name, singer, cover, error_message, retries, created_at, updated_at,
             song_info, tag_write_options, plugin_id, quality, metadata_error)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)
             ON CONFLICT(task_id) DO UPDATE SET
             status=excluded.status, progress=excluded.progress, total_bytes=excluded.total_bytes,
             downloaded_bytes=excluded.downloaded_bytes, error_message=excluded.error_message,
             retries=excluded.retries, updated_at=excluded.updated_at,
             song_info=excluded.song_info, tag_write_options=excluded.tag_write_options,
             plugin_id=excluded.plugin_id, quality=excluded.quality, metadata_error=excluded.metadata_error",
            params![
                task.task_id,
                task.songmid,
                task.url,
                task.file_path,
                task.status,
                task.progress,
                task.total_bytes,
                task.downloaded_bytes,
                task.name,
                task.singer,
                task.cover,
                task.error_message,
                task.retries,
                task.created_at,
                task.updated_at,
                song_info,
                tag_write_options,
                task.plugin_id,
                task.quality,
                task.metadata_error,
            ],
        )
        .map_err(|e| format!("保存下载任务失败: {}", e))?;
        Ok(())
    }

    pub fn delete_download_task(&self, task_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM download_tasks WHERE task_id = ?1",
            params![task_id],
        )
        .ok();
    }

    pub fn update_download_task_status(&self, task_id: &str, new_status: &str) {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let _ = conn.execute(
            "UPDATE download_tasks SET status = ?1, updated_at = ?2 WHERE task_id = ?3",
            params![new_status, now, task_id],
        );
    }

    pub fn update_download_tasks_status(&self, from_status: &str, to_status: &str) {
        let conn = self.conn.lock().unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        let _ = conn.execute(
            "UPDATE download_tasks SET status = ?1, updated_at = ?2 WHERE status = ?3",
            params![to_status, now, from_status],
        );
    }

    pub fn clear_download_tasks_by_status(&self, status: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM download_tasks WHERE status = ?1",
            params![status],
        )
        .ok();
    }

    pub fn clear_all_download_tasks(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM download_tasks", []).ok();
    }

    fn map_download_task(row: &rusqlite::Row) -> rusqlite::Result<DownloadTask> {
        Ok(DownloadTask {
            task_id: row.get("task_id")?,
            songmid: row.get("songmid")?,
            url: row.get("url")?,
            file_path: row.get("file_path")?,
            status: row.get("status")?,
            progress: row.get("progress")?,
            total_bytes: row.get("total_bytes")?,
            downloaded_bytes: row.get("downloaded_bytes")?,
            name: row.get("name")?,
            singer: row.get("singer")?,
            cover: row.get("cover")?,
            error_message: row.get("error_message")?,
            retries: row.get("retries")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            song_info: row
                .get::<_, Option<String>>("song_info")?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or(serde_json::Value::Object(Default::default())),
            tag_write_options: row
                .get::<_, Option<String>>("tag_write_options")?
                .and_then(|value| serde_json::from_str(&value).ok())
                .unwrap_or(serde_json::Value::Object(Default::default())),
            plugin_id: row.get("plugin_id")?,
            quality: row.get("quality")?,
            metadata_error: row.get("metadata_error")?,
        })
    }

    // ==================== Plugin Registry ====================

    pub fn list_plugins(&self) -> Vec<PluginInfo> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT * FROM plugin_registry ORDER BY position ASC, installed_at DESC")
            .unwrap();
        let rows = stmt
            .query_map([], |row| {
                Ok(PluginInfo {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    plugin_type: row.get("plugin_type")?,
                    version: row.get("version")?,
                    author: row.get("author")?,
                    description: row.get("description")?,
                    enabled: row.get("enabled")?,
                    installed_at: row.get("installed_at")?,
                })
            })
            .unwrap();
        rows.filter_map(|r| r.ok()).collect()
    }

    pub fn get_plugin(&self, id: &str) -> Option<PluginInfo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT * FROM plugin_registry WHERE id = ?1",
            params![id],
            |row| {
                Ok(PluginInfo {
                    id: row.get("id")?,
                    name: row.get("name")?,
                    plugin_type: row.get("plugin_type")?,
                    version: row.get("version")?,
                    author: row.get("author")?,
                    description: row.get("description")?,
                    enabled: row.get("enabled")?,
                    installed_at: row.get("installed_at")?,
                })
            },
        )
        .ok()
    }

    pub fn insert_plugin(&self, p: &PluginInfo) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO plugin_registry (id, name, plugin_type, version, author, description, enabled, source, installed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![p.id, p.name, p.plugin_type, p.version, p.author, p.description, p.enabled, "", p.installed_at],
        ).map_err(|e| format!("保存插件注册信息失败: {}", e))?;
        Ok(())
    }

    pub fn delete_plugin(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM plugin_registry WHERE id = ?1", params![id])
            .map_err(|e| format!("删除插件失败: {}", e))?;
        Ok(())
    }

    pub fn reorder_plugins(&self, ordered_ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| format!("开始插件重排失败: {}", e))?;
        for (position, id) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE plugin_registry SET position = ?1 WHERE id = ?2",
                params![position as i64, id],
            )
            .map_err(|e| format!("更新插件顺序失败: {}", e))?;
        }
        tx.commit().map_err(|e| format!("保存插件顺序失败: {}", e))
    }

    pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE plugin_registry SET enabled = ?1 WHERE id = ?2",
            params![enabled as i32, id],
        )
        .map_err(|e| format!("更新插件状态失败: {}", e))?;
        Ok(())
    }

    // ==================== Plugin Configs ====================

    pub fn get_plugin_config(&self, plugin_id: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT config FROM plugin_configs WHERE plugin_id = ?1",
            params![plugin_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    pub fn set_plugin_config(&self, plugin_id: &str, config: &str) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO plugin_configs (plugin_id, config) VALUES (?1, ?2)",
            params![plugin_id, config],
        )
        .map_err(|e| format!("保存插件配置失败: {}", e))?;
        Ok(())
    }

    // ==================== Statistics ====================

    pub fn get_songlist_statistics(&self) -> SongListStatistics {
        let conn = self.conn.lock().unwrap();
        let total_playlists: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlists", [], |r| r.get(0))
            .unwrap_or(0);
        let total_songs: i64 = conn
            .query_row("SELECT COUNT(*) FROM playlist_songs", [], |r| r.get(0))
            .unwrap_or(0);
        SongListStatistics {
            total_playlists,
            total_songs,
            total_duration_secs: 0.0,
        }
    }

    pub fn get_song_statistics(&self, playlist_id: &str) -> SongStatistics {
        let conn = self.conn.lock().unwrap();
        let total_songs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM playlist_songs WHERE playlist_id = ?1",
                params![playlist_id],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let by_singer: Vec<CountEntry> = {
            let mut stmt = conn.prepare(
                "SELECT singer AS k, COUNT(*) AS c FROM playlist_songs WHERE playlist_id = ?1 AND singer != '' GROUP BY singer"
            ).unwrap();
            let rows = stmt
                .query_map(params![playlist_id], |r| {
                    Ok(CountEntry {
                        key: r.get(0)?,
                        count: r.get(1)?,
                    })
                })
                .unwrap();
            rows.filter_map(|r| r.ok()).collect()
        };

        let by_album: Vec<CountEntry> = {
            let mut stmt = conn.prepare(
                "SELECT album_name AS k, COUNT(*) AS c FROM playlist_songs WHERE playlist_id = ?1 AND album_name != '' GROUP BY album_name"
            ).unwrap();
            let rows = stmt
                .query_map(params![playlist_id], |r| {
                    Ok(CountEntry {
                        key: r.get(0)?,
                        count: r.get(1)?,
                    })
                })
                .unwrap();
            rows.filter_map(|r| r.ok()).collect()
        };

        SongStatistics {
            total_songs,
            unique_singers: by_singer.len() as i64,
            unique_albums: by_album.len() as i64,
            by_singer,
            by_album,
        }
    }
}
