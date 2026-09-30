/// Multi-provider music search implementations (kg, kw, mg, tx/QQ).
/// NetEase (wy) search remains in misc.rs as it was implemented first.
use base64::Engine;
use md5::Md5;
use sha1::{Digest, Sha1};
use std::time::{SystemTime, UNIX_EPOCH};

// ==================== QQ Music (tx) Search ====================
// Sign algorithm reverse-engineered from QQMusic Android client.
// SHA1 of JSON body → pick chars at specific indices → XOR with
// scramble values → base64 → "zzc{part1}{b64}{part2}".toLowerCase()

const QQ_PART_1: [usize; 8] = [23, 14, 6, 36, 16, 40, 7, 19];
const QQ_PART_2: [usize; 8] = [16, 1, 32, 12, 19, 27, 8, 5];
const QQ_SCRAMBLE: [u8; 20] = [
    89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179,
];

fn zzc_sign(text: &str) -> String {
    let hash = Sha1::digest(text.as_bytes());
    let hex_hash: String = hash.iter().map(|b| format!("{:02X}", b)).collect();

    // Pick chars at specific positions from the hex hash
    let part1: String = QQ_PART_1
        .iter()
        .map(|&i| hex_hash.chars().nth(i).unwrap())
        .collect();
    let part2: String = QQ_PART_2
        .iter()
        .map(|&i| hex_hash.chars().nth(i).unwrap())
        .collect();

    // XOR scramble: each scramble value XOR with the byte from hex hash
    let part3: Vec<u8> = QQ_SCRAMBLE
        .iter()
        .enumerate()
        .map(|(i, &scramble)| {
            let hex_pair = &hex_hash[i * 2..i * 2 + 2];
            let byte_val = u8::from_str_radix(hex_pair, 16).unwrap_or(0);
            scramble ^ byte_val
        })
        .collect();

    // Base64 encode then strip special chars (matching JS: replace(/[\\/+=]/g, ''))
    let b64 = base64::engine::general_purpose::STANDARD
        .encode(&part3)
        .replace('\\', "")
        .replace('/', "")
        .replace('+', "")
        .replace('=', "");

    format!("zzc{}{}{}", part1, b64, part2).to_lowercase()
}

async fn search_qq(keyword: &str, page: i64, limit: i64) -> Result<serde_json::Value, String> {
    let search_id = rand_search_id();

    let body = serde_json::json!({
        "comm": {
            "ct": "11",
            "cv": "14090508",
            "v": "14090508",
            "tmeAppID": "qqmusic",
            "phonetype": "EBG-AN10",
            "nettype": "1020",
            "uid": "0",
            "sid": "0"
        },
        "req": {
            "module": "music.search.SearchCgiService",
            "method": "DoSearchForQQMusicMobile",
            "param": {
                "search_type": 0,
                "searchid": search_id,
                "query": keyword,
                "page_num": page,
                "num_per_page": limit,
                "highlight": 0,
                "nqc_flag": 0,
                "multi_zhida": 0,
                "cat": 2,
                "grp": 1,
                "sin": 0,
                "sem": 0
            }
        }
    });

    let body_str = serde_json::to_string(&body).map_err(|e| format!("JSON 序列化失败: {}", e))?;
    let sign = zzc_sign(&body_str);

    let url = format!("https://u.y.qq.com/cgi-bin/musics.fcg?sign={}", sign);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("User-Agent", "QQMusic 14090508(android 12)")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    // Navigate: body.req.data
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        return Ok(empty_result("tx"));
    }

    let req = json.get("req").cloned().unwrap_or_default();
    let req_code = req.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if req_code != 0 {
        return Ok(empty_result("tx"));
    }

    let data = req.get("data").cloned().unwrap_or_default();
    let meta = data.get("meta").cloned().unwrap_or_default();
    let total = meta
        .get("estimate_sum")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    let body_data = data.get("body").cloned().unwrap_or_default();
    let raw_songs = body_data
        .get("item_song")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let list: Vec<serde_json::Value> = raw_songs
        .iter()
        .filter_map(|item| {
            let media_mid = item
                .get("file")
                .and_then(|f| f.get("media_mid"))
                .and_then(|v| v.as_str())?;
            if media_mid.is_empty() {
                return None;
            }

            // Extract singer names
            let singer = item
                .get("singer")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
                        .collect::<Vec<_>>()
                        .join("、")
                })
                .unwrap_or_default();

            let album = item.get("album").cloned().unwrap_or_default();
            let album_name = album.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let album_mid = album.get("mid").and_then(|v| v.as_str()).unwrap_or("");
            let album_id = album.get("id").and_then(|v| v.as_i64()).unwrap_or(0);

            let duration = item.get("interval").and_then(|v| v.as_i64()).unwrap_or(0);
            let song_id = item.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            let song_mid = item.get("mid").and_then(|v| v.as_str()).unwrap_or("");

            let name_extra = item.get("title_extra").and_then(|v| v.as_str()).unwrap_or("");

            // Build album art URL
            let img = if !album_mid.is_empty() && album_mid != "空" {
                format!("https://y.gtimg.cn/music/photo_new/T002R500x500M000{}.jpg", album_mid)
            } else if let Some(singers) = item.get("singer").and_then(|v| v.as_array()) {
                singers
                    .first()
                    .and_then(|s| s.get("mid").and_then(|m| m.as_str()))
                    .map(|mid| format!("https://y.gtimg.cn/music/photo_new/T001R500x500M000{}.jpg", mid))
                    .unwrap_or_default()
            } else {
                String::new()
            };

            Some(serde_json::json!({
                "songmid": song_id.to_string(),
                "name": format!("{}{}", item.get("name").and_then(|v| v.as_str()).unwrap_or(""), name_extra),
                "singer": singer,
                "albumName": album_name,
                "albumId": album_id,
                "albumMid": album_mid,
                "source": "tx",
                "interval": format_duration(duration),
                "strMediaMid": media_mid,
                "songmid_str": song_mid,
                "img": img,
                "types": [],
                "_types": {},
                "typeUrl": {}
            }))
        })
        .collect();

    let all_page = ((total as f64) / (limit as f64)).ceil() as i64;
    Ok(serde_json::json!({
        "list": list,
        "total": total,
        "allPage": all_page.max(1),
        "limit": limit,
        "source": "tx"
    }))
}

fn rand_search_id() -> String {
    // Generate a search ID similar to QQMusic Android client.
    // Uses time-based value instead of Math.random to avoid extra deps.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = (now % 1_000_000_000_000) as u64;
    let r = (now as u64).wrapping_mul(7).wrapping_add(12345) % 86_400_000;
    (base + r).to_string()
}

// ==================== Kugou (kg) Search ====================

async fn search_kugou(keyword: &str, page: i64, limit: i64) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let url = reqwest::Url::parse_with_params(
        "https://songsearch.kugou.com/song_search_v2",
        &[
            ("keyword", keyword),
            ("page", &page.to_string()),
            ("pagesize", &limit.to_string()),
            ("userid", "0"),
            ("platform", "WebFilter"),
            ("filter", "2"),
            ("iscorrection", "1"),
            ("privilege_filter", "0"),
            ("area_code", "1"),
        ],
    )
    .map_err(|e| format!("URL 解析失败: {}", e))?;

    let resp = client
        .get(url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
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

    let err_code = json
        .get("error_code")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if err_code != 0 {
        return Ok(empty_result("kg"));
    }

    let data = json.get("data").cloned().unwrap_or_default();
    let total = data.get("total").and_then(|v| v.as_i64()).unwrap_or(0);
    let raw_lists = data
        .get("lists")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut list = Vec::new();
    for item in &raw_lists {
        let singers = item
            .get("Singers")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let singer = singers
            .first()
            .and_then(|s| s.get("name").and_then(|n| n.as_str()))
            .unwrap_or("未知歌手");

        let duration = item.get("Duration").and_then(|v| v.as_i64()).unwrap_or(0);
        let song_name = item.get("SongName").and_then(|v| v.as_str()).unwrap_or("");
        let album_name = item.get("AlbumName").and_then(|v| v.as_str()).unwrap_or("");
        let album_id = item.get("AlbumID").and_then(|v| v.as_i64()).unwrap_or(0);
        let audio_id = item.get("Audioid").and_then(|v| v.as_str()).unwrap_or("");
        let file_hash = item.get("FileHash").and_then(|v| v.as_str()).unwrap_or("");

        // Kugou cover image URL pattern using FileHash
        let img = if !file_hash.is_empty() {
            format!(
                "https://imgess.kugou.com/standard/{}/{}_0.jpg",
                file_hash.get(..2).unwrap_or("00"),
                file_hash
            )
        } else {
            String::new()
        };

        list.push(serde_json::json!({
            "songmid": audio_id,
            "name": song_name,
            "singer": singer,
            "albumName": album_name,
            "albumId": album_id,
            "source": "kg",
            "interval": format_duration(duration),
            "hash": file_hash,
            "img": img,
            "types": [],
            "_types": {},
            "typeUrl": {}
        }));
    }

    let all_page = if total > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };

    Ok(serde_json::json!({
        "list": list,
        "total": total,
        "allPage": all_page,
        "limit": limit,
        "source": "kg"
    }))
}

// ==================== Kuwo (kw) Search ====================

async fn search_kuwo(keyword: &str, page: i64, limit: i64) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let pn = page - 1; // Kuwo uses 0-based page index
    let url = format!(
        "http://search.kuwo.cn/r.s?client=kt&all={}&pn={}&rn={}&uid=794762570\
         &ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1\
         &ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&vermerge=1&mobi=1&issubtitle=1",
        urlencoding(keyword),
        pn,
        limit
    );

    let resp = client
        .get(&url)
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    let show = json.get("SHOW").and_then(|v| v.as_str()).unwrap_or("0");
    if show == "0" {
        return Ok(empty_result("kw"));
    }

    let total_str = json.get("TOTAL").and_then(|v| v.as_str()).unwrap_or("0");
    let total: i64 = total_str.parse().unwrap_or(0);

    let raw_songs = json
        .get("abslist")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut list = Vec::new();
    for item in &raw_songs {
        let music_rid = item.get("MUSICRID").and_then(|v| v.as_str()).unwrap_or("");
        let song_id = music_rid.strip_prefix("MUSIC_").unwrap_or(music_rid);

        let name = item.get("SONGNAME").and_then(|v| v.as_str()).unwrap_or("");
        let artist = item.get("ARTIST").and_then(|v| v.as_str()).unwrap_or("");
        let album = item.get("ALBUM").and_then(|v| v.as_str()).unwrap_or("");
        let album_id = item.get("ALBUMID").and_then(|v| v.as_str()).unwrap_or("");

        let dur_str = item.get("DURATION").and_then(|v| v.as_str()).unwrap_or("0");
        let duration: i64 = dur_str.parse().unwrap_or(0);

        // Kuwo cover URL
        let img = format!("https://img4.kuwo.cn/star/albumcover/{}.jpg", song_id);

        // Process quality info from N_MINFO
        let n_minfo = item.get("N_MINFO").and_then(|v| v.as_str()).unwrap_or("");
        let types = parse_kuwo_quality(n_minfo);

        list.push(serde_json::json!({
            "songmid": song_id,
            "name": name,
            "singer": artist,
            "albumName": album,
            "albumId": album_id,
            "source": "kw",
            "interval": format_duration(duration),
            "img": img,
            "types": types.0,
            "_types": types.1,
            "typeUrl": {}
        }));
    }

    let all_page = if total > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };

    Ok(serde_json::json!({
        "list": list,
        "total": total,
        "allPage": all_page,
        "limit": limit,
        "source": "kw"
    }))
}

/// Parse Kuwo N_MINFO quality string into types and _types
fn parse_kuwo_quality(minfo: &str) -> (Vec<serde_json::Value>, serde_json::Value) {
    let mut types = Vec::new();
    let mut _types = serde_json::Map::new();

    // Format: "level:bitrate,format:mp3,size:12345;level:hires,bitrate:2000,format:flac,size:99999"
    for part in minfo.split(';') {
        let kv: std::collections::HashMap<&str, &str> = part
            .split(',')
            .filter_map(|kv| {
                let mut it = kv.splitn(2, ':');
                match (it.next(), it.next()) {
                    (Some(k), Some(v)) => Some((k.trim(), v.trim())),
                    _ => None,
                }
            })
            .collect();

        let bitrate = kv.get("bitrate").unwrap_or(&"0");
        let size = kv.get("size").unwrap_or(&"0");

        let type_name = match *bitrate {
            "20900" => "master",
            "4000" => "hires",
            "2000" => "flac",
            "320" => "320k",
            "128" => "128k",
            _ => continue,
        };

        types.push(serde_json::json!({
            "type": type_name,
            "size": size.to_uppercase()
        }));
        _types.insert(
            type_name.to_string(),
            serde_json::json!({ "size": size.to_uppercase() }),
        );
    }

    types.reverse(); // JS SDK reverses the order
    (types, serde_json::Value::Object(_types))
}

// ==================== Migu (mg) Search ====================

async fn search_migu(keyword: &str, page: i64, limit: i64) -> Result<serde_json::Value, String> {
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
        .to_string();

    let device_id = "963B7AA0D21511ED807EE5846EC87D20";
    let signature_md5 = "6cdc72a439cef99a3418d2a78aa28c73";

    // MD5 sign: str + signatureMd5 + "yyapp2d16148780a1dcc7408e06336b98cfd50" + deviceId + time
    let sign_input = format!(
        "{}{}yyapp2d16148780a1dcc7408e06336b98cfd50{}{}",
        keyword, signature_md5, device_id, time
    );
    let sign: String = Md5::digest(sign_input.as_bytes())
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();

    let search_switch =
        "{\"song\":1,\"album\":0,\"singer\":0,\"tagSong\":1,\"mvSong\":0,\"bestShow\":1,\"songlist\":0,\"lyricSong\":0}";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {}", e))?;

    let url = format!(
        "https://jadeite.migu.cn/music_search/v3/search/searchAll?isCorrect=0&isCopyright=1\
         &searchSwitch={}&pageSize={}&text={}&pageNo={}&sort=0&sid=USS",
        urlencoding(search_switch),
        limit,
        urlencoding(keyword),
        page
    );

    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (Linux; U; Android 11.0.0; zh-cn; MI 11 Build/OPR1.170623.032) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30")
        .header("uiVersion", "A_music_3.6.1")
        .header("deviceId", device_id)
        .header("timestamp", &time)
        .header("sign", &sign)
        .header("channel", "0146921")
        .header("Referer", "https://m.music.migu.cn/")
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;

    let code = json.get("code").and_then(|v| v.as_str()).unwrap_or("");
    if code != "000000" {
        return Ok(empty_result("mg"));
    }

    let song_result = json.get("songResultData").cloned().unwrap_or_default();
    let total = song_result
        .get("totalCount")
        .and_then(|v| {
            v.as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .or_else(|| v.as_i64())
        })
        .unwrap_or(0);

    // songResultData.resultList is an array of arrays
    let raw_groups = song_result
        .get("resultList")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut list = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for group in &raw_groups {
        if let Some(items) = group.as_array() {
            for data in items {
                let song_id = data.get("songId").and_then(|v| v.as_str()).unwrap_or("");
                let copyright_id = data
                    .get("copyrightId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if song_id.is_empty() || copyright_id.is_empty() || seen.contains(copyright_id) {
                    continue;
                }
                seen.insert(copyright_id.to_string());

                let duration = data.get("duration").and_then(|v| v.as_i64()).unwrap_or(0);
                let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let album = data.get("album").and_then(|v| v.as_str()).unwrap_or("");
                let album_id = data.get("albumId").and_then(|v| v.as_str()).unwrap_or("");

                // Extract singer (singerList can be a string or an array of {name: ...})
                let singer = {
                    let sl = data.get("singerList");
                    if let Some(s) = sl.and_then(|v| v.as_str()) {
                        s.to_string()
                    } else if let Some(arr) = sl.and_then(|v| v.as_array()) {
                        arr.iter()
                            .filter_map(|s| s.get("name").and_then(|n| n.as_str()))
                            .collect::<Vec<_>>()
                            .join("、")
                    } else {
                        String::new()
                    }
                };

                // Build cover image URL
                let img = data
                    .get("img3")
                    .and_then(|v| v.as_str())
                    .or_else(|| data.get("img2").and_then(|v| v.as_str()))
                    .or_else(|| data.get("img1").and_then(|v| v.as_str()))
                    .map(|url| {
                        if url.starts_with("http") {
                            url.to_string()
                        } else {
                            format!("http://d.musicapp.migu.cn{}", url)
                        }
                    })
                    .unwrap_or_default();

                list.push(serde_json::json!({
                    "songmid": song_id,
                    "name": name,
                    "singer": singer,
                    "albumName": album,
                    "albumId": album_id,
                    "copyrightId": copyright_id,
                    "source": "mg",
                    "interval": format_duration(duration),
                    "img": img,
                    "types": [],
                    "_types": {},
                    "typeUrl": {}
                }));
            }
        }
    }

    let all_page = if total > 0 {
        ((total as f64) / (limit as f64)).ceil() as i64
    } else {
        1
    };

    Ok(serde_json::json!({
        "list": list,
        "total": total,
        "allPage": all_page,
        "limit": limit,
        "source": "mg"
    }))
}

// ==================== Helpers ====================

fn format_duration(seconds: i64) -> String {
    let m = seconds / 60;
    let s = seconds % 60;
    format!("{:02}:{:02}", m, s)
}

fn empty_result(source: &str) -> serde_json::Value {
    serde_json::json!({
        "list": [],
        "total": 0,
        "allPage": 1,
        "limit": 30,
        "source": source
    })
}

/// Simple URL percent-encoding (only for non-ASCII / special chars)
fn urlencoding(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push_str("%20"),
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

// ==================== Public Entry Point ====================

/// Route search to the appropriate provider.
/// Returns the unified `{ list, total, allPage, limit, source }` format.
pub async fn dispatch_search(
    source: &str,
    keyword: &str,
    page: i64,
    limit: i64,
) -> Result<serde_json::Value, String> {
    match source {
        "kg" => search_kugou(keyword, page, limit).await,
        "kw" => search_kuwo(keyword, page, limit).await,
        "mg" => search_migu(keyword, page, limit).await,
        "tx" | "qq" => search_qq(keyword, page, limit).await,
        _ => Ok(empty_result(source)),
    }
}
