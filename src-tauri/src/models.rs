use serde::{Deserialize, Serialize};

// ---- Song List / Playlist ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongList {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_cover")]
    pub cover_img_url: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub meta: serde_json::Value,
    #[serde(default)]
    pub create_time: String,
    #[serde(default)]
    pub update_time: String,
    #[serde(default)]
    pub position: i64,
}

fn default_cover() -> String {
    "default-cover".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaylistRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub cover_img_url: String,
    pub source: String,
    pub meta: String,
    pub create_time: String,
    pub update_time: String,
    pub position: i64,
}

// ---- Songs within a playlist ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Songs {
    #[serde(default)]
    pub songmid: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub singer: String,
    #[serde(default)]
    pub album_name: String,
    #[serde(default)]
    pub album_id: Option<serde_json::Value>,
    #[serde(default)]
    pub img: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub interval: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub lrc: Option<String>,
    #[serde(default)]
    pub types: Option<serde_json::Value>,
    // Keep the legacy "_types" key. camelCase would rename it to "types"
    // and write a second types field, which then cannot be read back.
    #[serde(default, rename = "_types")]
    pub _types: Option<serde_json::Value>,
    #[serde(default)]
    pub type_url: Option<serde_json::Value>,
    #[serde(default)]
    pub bitrate: Option<i64>,
    #[serde(default)]
    pub sample_rate: Option<i64>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub size: Option<i64>,
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, serde_json::Value>,
}

impl Songs {
    pub fn from_stored_json(data: &str) -> Option<Self> {
        let normalized = normalize_duplicate_types(data);
        if let Ok(song) = serde_json::from_str::<Self>(normalized.as_ref()) {
            return Some(song);
        }
        let value: serde_json::Value = serde_json::from_str(normalized.as_ref()).ok()?;
        serde_json::from_value(value).ok()
    }

    pub fn source_from_stored_json(data: &str) -> String {
        serde_json::from_str::<serde_json::Value>(data)
            .ok()
            .and_then(|value| {
                value
                    .get("source")
                    .and_then(|item| item.as_str())
                    .map(|item| item.trim().to_string())
            })
            .filter(|item| !item.is_empty())
            .unwrap_or_default()
    }
}

fn normalize_duplicate_types(data: &str) -> std::borrow::Cow<'_, str> {
    let Some(first) = data.find("\"types\":") else {
        return std::borrow::Cow::Borrowed(data);
    };
    let Some(relative) = data[first + 8..].find("\"types\":") else {
        return std::borrow::Cow::Borrowed(data);
    };
    let second = first + 8 + relative;
    if !data[second..].starts_with("\"types\":null") {
        return std::borrow::Cow::Borrowed(data);
    }
    let start = if second > 0 && data.as_bytes()[second - 1] == b',' {
        second - 1
    } else {
        second
    };
    let end = second + "\"types\":null".len();
    let mut normalized = String::with_capacity(data.len() - (end - start));
    normalized.push_str(&data[..start]);
    normalized.push_str(&data[end..]);
    std::borrow::Cow::Owned(normalized)
}

#[cfg(test)]
mod tests {
    use super::Songs;

    #[test]
    fn parses_string_album_id() {
        let json = r#"{"songmid":"002KwY3t4ZcFxE","name":"0932","singer":"陈小春","albumName":"算你狠","albumId":"004OzaYo3giFy5","source":"tx","interval":"04:07","img":"https://example.com/cover.jpg","types":[{"type":"128k"}],"_types":{}}"#;
        let song = Songs::from_stored_json(json).expect("string albumId should parse");
        assert_eq!(song.songmid, "002KwY3t4ZcFxE");
        assert_eq!(song.name, "0932");
    }

    #[test]
    fn parses_song_written_with_duplicate_types() {
        let json = r#"{"songmid":"2736660964","name":"褪黑素","singer":"梓渝","albumName":"褪黑素","source":"wy","interval":"","types":[{"type":"128k"}],"types":null,"_types":{"128k":{"size":"1"}}}"#;
        let song = Songs::from_stored_json(json).expect("duplicate types should still parse");
        assert_eq!(song.name, "褪黑素");
        assert_eq!(song.source, "wy");
        assert!(song.types.is_some());
        assert!(song._types.is_some());
    }

    #[test]
    fn roundtrip_keeps_a_single_types_field() {
        let json = r#"{"songmid":"4226257","name":"Wonderwall","source":"wy","types":[{"type":"128k"}],"_types":{"128k":{"size":"1"}}}"#;
        let song = Songs::from_stored_json(json).expect("song should parse");
        let stored = serde_json::to_string(&song).expect("song should serialize");
        assert_eq!(stored.matches("\"types\"").count(), 1, "{stored}");
        let again = Songs::from_stored_json(&stored).expect("stored song should parse");
        assert_eq!(again.songmid, "4226257");
        assert_eq!(again.source, "wy");
    }
}

// ---- Local Music Track ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackRow {
    pub songmid: String,
    pub path: String,
    pub url: Option<String>,
    pub singer: String,
    pub name: String,
    pub album_name: String,
    pub album_id: i64,
    pub source: String,
    pub interval: String,
    pub has_cover: i64,
    pub cover_key: Option<String>,
    pub year: i64,
    pub lrc: Option<String>,
    pub types: String,
    pub _types: String,
    pub type_url: String,
    pub bitrate: i64,
    pub sample_rate: i64,
    pub channels: i64,
    pub duration: f64,
    pub size: i64,
    pub mtime_ms: i64,
    pub hash: Option<String>,
    pub updated_at: i64,
}

// ---- Download Task ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadTask {
    pub task_id: String,
    pub songmid: String,
    pub url: String,
    pub file_path: String,
    pub status: String, // "pending" | "downloading" | "paused" | "completed" | "error"
    pub progress: f64,
    pub total_bytes: i64,
    pub downloaded_bytes: i64,
    pub name: String,
    pub singer: String,
    pub cover: String,
    pub error_message: Option<String>,
    pub retries: i32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub song_info: serde_json::Value,
    #[serde(default)]
    pub tag_write_options: serde_json::Value,
    #[serde(default)]
    pub plugin_id: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub metadata_error: Option<String>,
}

// ---- Hotkey ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyEntry {
    pub action: String,
    pub shortcut: String,
}

// ---- Directory Settings ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectorySettings {
    pub cache_dir: Option<String>,
    pub download_dir: Option<String>,
}

// ---- Plugin ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub plugin_type: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub enabled: bool,
    pub installed_at: String,
}

// ---- Statistics ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongListStatistics {
    pub total_playlists: i64,
    pub total_songs: i64,
    pub total_duration_secs: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SongStatistics {
    pub total_songs: i64,
    pub unique_singers: i64,
    pub unique_albums: i64,
    pub by_singer: Vec<CountEntry>,
    pub by_album: Vec<CountEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountEntry {
    pub key: String,
    pub count: i64,
}
