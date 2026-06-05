#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{SystemTime, Instant};
use std::{fs, path::Path};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::ops::ControlFlow;
use tauri::Manager;
use tauri::api::dialog::blocking::FileDialogBuilder;

use regex::Regex;
use serde::{Deserialize, Serialize};

// ============== Data Structures ==============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnimeEntry {
    pub id: String,
    pub title: String,
    pub parent_title: Option<String>,
    pub season_number: Option<String>,
    pub folder_path: String,
    pub sort_order: u32,
    pub created_at: u64,
    pub video_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub theme: String,
    pub sort: String,
    pub window_width: Option<u32>,
    pub window_height: Option<u32>,
    pub window_x: Option<i32>,
    pub window_y: Option<i32>,
    pub window_maximized: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MalResult {
    pub mal_id: u32,
    pub title: String,
    pub title_english: String,
    pub image_url: String,
    pub synopsis: String,
    pub media_type: String,
    pub year: Option<i32>,
    pub episodes: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappedEntry {
    pub id: String,
    pub mal_id: Option<u32>,
    pub poster_url: Option<String>,
    pub title: Option<String>,
    pub title_english: Option<String>,
    pub episodes: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MappingData {
    pub root_path: String,
    pub entries: Vec<MappedEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserAnimeStatus {
    pub mal_id: u32,
    pub status: String,
    pub score: i32,
    pub episodes: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserProfile {
    pub image_url: String,
}

// ============== Shared State ==============

pub struct AppState {
    client: reqwest::Client,
    num_pattern: Regex,
    strip_pattern: Regex,
    /// Serialises all writes to mapping JSON files so concurrent save_mapping
    /// calls (e.g. autoFetchPosters running while addNewAnime also saves) cannot
    /// interleave and corrupt the file.
    mapping_lock: Mutex<()>,
}

// ============== Helpers ==============

fn get_data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("AniShelf")
}

fn get_posters_dir() -> PathBuf {
    get_data_dir().join("posters")
}

fn make_entry_id(root_path: &str, folder_path: &str) -> String {
    let rel = folder_path
        .strip_prefix(root_path)
        .unwrap_or(folder_path)
        .trim_start_matches(|c| c == '/' || c == '\\');
    let mut hasher = DefaultHasher::new();
    rel.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn get_mapping_file(root_path: &str) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    root_path.hash(&mut hasher);
    let hash = hasher.finish();
    get_data_dir().join(format!("mapping_{:016x}.json", hash))
}

// ============== Commands ==============

#[tauri::command]
fn select_directory() -> Result<Option<String>, String> {
    let path = FileDialogBuilder::new().pick_folder();
    Ok(path.map(|p| p.to_string_lossy().to_string()))
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let windows_path = path.replace('/', "\\");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &windows_path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }

    Ok(())
}

fn count_video_files(dir: &Path) -> u32 {
    const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "avi", "webm", "mov", "wmv", "flv", "m4v", "ts"];
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if VIDEO_EXTS.contains(&ext.to_lowercase().as_str()) {
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

#[tauri::command]
fn scan_anime_folder(
    root_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AnimeEntry>, String> {
    let root = Path::new(&root_path);
    if !root.exists() {
        return Err("Path does not exist".into());
    }
    if !root.is_dir() {
        return Err("Path is not a directory".into());
    }

    let mut entries: Vec<AnimeEntry> = Vec::new();
    let mut sort_order: u32 = 0;

    let mut dir_entries: Vec<_> = fs::read_dir(root)
        .map_err(|e| format!("Failed to read directory: {}", e))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .collect();
    dir_entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    fn get_creation_time(p: &Path) -> u64 {
        if let Ok(meta) = fs::metadata(p) {
            if let Ok(ctime) = meta.created().or_else(|_| meta.modified()) {
                if let Ok(dur) = ctime.duration_since(SystemTime::UNIX_EPOCH) {
                    return dur.as_secs();
                }
            }
        }
        0
    }

    for entry in &dir_entries {
        let folder_name = entry.file_name().to_string_lossy().to_string();
        let folder_path = entry.path();

        let mut subdirs: Vec<_> = fs::read_dir(&folder_path)
            .map_err(|e| format!("Failed to read subdirectories: {}", e))?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .collect();
        subdirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

        if subdirs.is_empty() {
            let id = make_entry_id(&root_path, &folder_path.to_string_lossy());
            let vc = count_video_files(&folder_path);
            entries.push(AnimeEntry {
                id,
                title: folder_name,
                parent_title: None,
                season_number: None,
                folder_path: folder_path.to_string_lossy().to_string(),
                sort_order,
                created_at: get_creation_time(&folder_path),
                video_count: vc,
            });
            sort_order += 1;
        } else {
            let all_numbered = subdirs
                .iter()
                .all(|d| state.num_pattern.is_match(&d.file_name().to_string_lossy()));

            for sub in &subdirs {
                let sub_name = sub.file_name().to_string_lossy().to_string();
                let (title, season_num) = if all_numbered {
                    let clean = state.strip_pattern.replace(&sub_name, "").to_string();
                    let season = state
                        .num_pattern
                        .captures(&sub_name)
                        .and_then(|c| c.get(1))
                        .map(|m| m.as_str().to_string());
                    (clean, season)
                } else {
                    (sub_name, None)
                };

                let id = make_entry_id(&root_path, &sub.path().to_string_lossy());
                let vc = count_video_files(&sub.path());
                entries.push(AnimeEntry {
                    id,
                    title,
                    parent_title: Some(folder_name.clone()),
                    season_number: season_num,
                    folder_path: sub.path().to_string_lossy().to_string(),
                    sort_order,
                    created_at: get_creation_time(&sub.path()),
                    video_count: vc,
                });
                sort_order += 1;
            }
        }
    }

    Ok(entries)
}

#[tauri::command]
async fn search_mal(
    state: tauri::State<'_, AppState>,
    query: String,
) -> Result<Vec<MalResult>, String> {
    let mut retries = 3;
    loop {
        let params: Vec<(&str, &str)> = vec![("q", &query), ("limit", "10"), ("sfw", "false")];
        let response = state
            .client
            .get("https://api.jikan.moe/v4/anime")
            .query(&params)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if response.status() == 429 {
            retries -= 1;
            if retries == 0 {
                return Err("Rate limited. Please wait a moment.".into());
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("API error: HTTP {}", response.status()));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Parse error: {}", e))?;

        let results = body["data"]
            .as_array()
            .ok_or("Invalid API response")?
            .iter()
            .map(|item| {
                let img = item["images"]["jpg"]["large_image_url"]
                    .as_str()
                    .or_else(|| item["images"]["jpg"]["image_url"].as_str())
                    .unwrap_or("")
                    .to_string();
                MalResult {
                    mal_id: item["mal_id"].as_u64().unwrap_or(0) as u32,
                    title: item["title"].as_str().unwrap_or("Unknown").to_string(),
                    title_english: item["title_english"].as_str().unwrap_or("").to_string(),
                    image_url: img,
                    synopsis: item["synopsis"].as_str().unwrap_or("").to_string(),
                    media_type: item["type"].as_str().unwrap_or("Unknown").to_string(),
                    year: item["year"].as_i64().map(|y| y as i32),
                    episodes: item["episodes"].as_i64().map(|e| e as i32),
                }
            })
            .collect();

        return Ok(results);
    }
}

#[tauri::command]
async fn fetch_anime_episodes(
    state: tauri::State<'_, AppState>,
    mal_id: u32,
) -> Result<Option<i32>, String> {
    let mut retries = 3;
    loop {
        let url = format!("https://api.jikan.moe/v4/anime/{}", mal_id);
        let response = state
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Network error: {}", e))?;

        if response.status() == 429 {
            retries -= 1;
            if retries == 0 {
                return Err("Rate limited by Jikan API".into());
            }
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            continue;
        }

        if !response.status().is_success() {
            return Err(format!("API error: HTTP {}", response.status()));
        }

        let body: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("Parse error: {}", e))?;

        let episodes = body["data"]["episodes"].as_i64().map(|e| e as i32);
        return Ok(episodes);
    }
}

#[tauri::command]
fn load_mappings(root_path: String) -> Result<Vec<MappedEntry>, String> {
    let file_path = get_mapping_file(&root_path);
    if !file_path.exists() {
        return Ok(Vec::new());
    }
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read mappings: {}", e))?;
    let data: MappingData =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse mappings: {}", e))?;

    if data.root_path == root_path {
        Ok(data.entries)
    } else {
        Ok(Vec::new())
    }
}

#[tauri::command]
fn save_mapping(
    root_path: String,
    entry_id: String,
    mal_id: u32,
    poster_url: String,
    title: String,
    title_english: String,
    episodes: Option<i32>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let file_path = get_mapping_file(&root_path);

    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }

    let title_en = if title_english.is_empty() { None } else { Some(title_english.clone()) };

    // Hold the lock for the entire read-modify-write so concurrent calls
    // (e.g. autoFetchPosters + addNewAnime running simultaneously) cannot
    // interleave their reads and overwrite each other's entries.
    {
        let _guard = state.mapping_lock.lock().map_err(|_| "Mapping lock poisoned".to_string())?;

        let mut data = if file_path.exists() {
            let raw = fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read mappings: {}", e))?;
            serde_json::from_str::<MappingData>(&raw).unwrap_or(MappingData {
                root_path: root_path.clone(),
                entries: Vec::new(),
            })
        } else {
            MappingData {
                root_path: root_path.clone(),
                entries: Vec::new(),
            }
        };

        if let Some(existing) = data.entries.iter_mut().find(|e| e.id == entry_id) {
            existing.mal_id = Some(mal_id);
            existing.poster_url = Some(poster_url.clone());
            existing.title = Some(title.clone());
            existing.title_english = title_en;
            existing.episodes = episodes;
        } else {
            data.entries.push(MappedEntry {
                id: entry_id.clone(),
                mal_id: Some(mal_id),
                poster_url: Some(poster_url.clone()),
                title: Some(title.clone()),
                title_english: title_en,
                episodes,
            });
        }

        let serialized = serde_json::to_string_pretty(&data)
            .map_err(|e| format!("Failed to serialize: {}", e))?;
        fs::write(&file_path, serialized)
            .map_err(|e| format!("Failed to write mappings: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn cache_poster(
    state: tauri::State<'_, AppState>,
    entry_id: String,
    poster_url: String,
) -> Result<Option<String>, String> {
    let posters_dir = get_posters_dir();
    if let Err(e) = fs::create_dir_all(&posters_dir) {
        eprintln!("Failed to create posters dir: {}", e);
        return Ok(None);
    }

    let file_path = posters_dir.join(format!("{}.jpg", entry_id));

    if file_path.exists() {
        return Ok(Some(file_path.to_string_lossy().to_string()));
    }

    let response = match state.client.get(&poster_url).send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Failed to download poster for {}: {}", entry_id, e);
            return Ok(None);
        }
    };

    if !response.status().is_success() {
        eprintln!("Poster download failed for {}: HTTP {}", entry_id, response.status());
        return Ok(None);
    }

    let bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("Failed to read poster bytes for {}: {}", entry_id, e);
            return Ok(None);
        }
    };

    if let Err(e) = fs::write(&file_path, &bytes) {
        eprintln!("Failed to save poster for {}: {}", entry_id, e);
        return Ok(None);
    }

    Ok(Some(file_path.to_string_lossy().to_string()))
}

#[tauri::command]
fn get_cached_poster(entry_id: String) -> Result<Option<String>, String> {
    let file_path = get_posters_dir().join(format!("{}.jpg", entry_id));
    if file_path.exists() {
        let bytes = fs::read(&file_path)
            .map_err(|e| format!("Failed to read cached poster: {}", e))?;
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        Ok(Some(format!("data:image/jpeg;base64,{}", encoded)))
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn delete_cached_poster(entry_id: String) -> Result<(), String> {
    let file_path = get_posters_dir().join(format!("{}.jpg", entry_id));
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to delete cached poster: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn create_anime_folder(folder_path: String, root_path: String) -> Result<String, String> {
    let path = Path::new(&folder_path);
    if path.exists() {
        return Err("A folder with this name already exists".into());
    }
    fs::create_dir_all(path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    let id = make_entry_id(&root_path, &folder_path);
    Ok(id)
}

#[tauri::command]
fn convert_standalone_to_franchise(
    standalone_path: String,
    season_num: String,
    clean_name: String,
    root_path: String,
) -> Result<String, String> {
    let parent = Path::new(&standalone_path);
    if !parent.exists() {
        return Err("Standalone folder does not exist".into());
    }

    let season_folder_name = format!("{}.{}", season_num, clean_name);
    let season_path = parent.join(&season_folder_name);
    if season_path.exists() {
        return Err("Season folder already exists".into());
    }

    fs::create_dir_all(&season_path)
        .map_err(|e| format!("Failed to create season folder: {}", e))?;

    for entry in fs::read_dir(parent).map_err(|e| format!("Failed to read directory: {}", e))? {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        if path.is_file() {
            let dest = season_path.join(entry.file_name());
            fs::rename(&path, &dest)
                .or_else(|_| {
                    fs::copy(&path, &dest)?;
                    fs::remove_file(&path)?;
                    Ok::<(), std::io::Error>(())
                })
                .map_err(|e| format!("Failed to move file {:?}: {}", path, e))?;
        }
    }

    let id = make_entry_id(&root_path, &season_path.to_string_lossy());
    Ok(id)
}

#[tauri::command]
fn save_last_path(path: String) -> Result<(), String> {
    let file_path = get_data_dir().join("last_path.txt");
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    fs::write(&file_path, &path).map_err(|e| format!("Failed to save last path: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_last_path() -> Result<Option<String>, String> {
    let file_path = get_data_dir().join("last_path.txt");
    if !file_path.exists() {
        return Ok(None);
    }
    let path = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read last path: {}", e))?;
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() || !Path::new(&trimmed).exists() {
        return Ok(None);
    }
    Ok(Some(trimmed))
}

#[tauri::command]
async fn fetch_user_animelist(
    state: tauri::State<'_, AppState>,
    username: String,
) -> Result<Vec<UserAnimeStatus>, String> {
    let mut all_entries: Vec<UserAnimeStatus> = Vec::new();
    let page_size = 300;
    let mut offset: u32 = 0;
    let mut retries: u32;

    fn map_mal_status(status: i64) -> &'static str {
        match status {
            1 => "watching",
            2 => "completed",
            3 => "on_hold",
            4 => "dropped",
            6 => "plan_to_watch",
            _ => "unknown",
        }
    }

    loop {
        retries = 3;
        let offset_str = offset.to_string();
        let result = loop {
            let url = format!(
                "https://myanimelist.net/animelist/{}/load.json?offset={}&status=7",
                username, offset_str
            );
            let response = state
                .client
                .get(&url)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
                .header("Accept", "application/json")
                .header("Referer", format!("https://myanimelist.net/animelist/{}", username))
                .send()
                .await;

            match response {
                Ok(r) => {
                    if r.status() == 429 {
                        retries -= 1;
                        if retries == 0 {
                            return Err("Rate limited by MyAnimeList. Please wait a moment and try again.".into());
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                        continue;
                    }
                    let status = r.status();
                    if !status.is_success() {
                        let text = r.text().await.unwrap_or_default();
                        return Err(format!("Failed to fetch list (HTTP {}): {}", status, text));
                    }
                    break r;
                }
                Err(e) => return Err(format!("Network error: {}", e)),
            }
        };

        let body: serde_json::Value = result
            .json()
            .await
            .map_err(|e| format!("Parse error: {}", e))?;

        let data = body.as_array().ok_or("Invalid response format")?;

        for item in data {
            if let Some(anime_id) = item["anime_id"].as_i64() {
                let status_val = item["status"].as_i64().unwrap_or(0);
                let status_str = map_mal_status(status_val);
                let score = item["score"].as_i64().unwrap_or(0) as i32;
                let episodes = item["anime_num_episodes"].as_i64().map(|e| e as i32);
                if status_str != "unknown" {
                    all_entries.push(UserAnimeStatus {
                        mal_id: anime_id as u32,
                        status: status_str.to_string(),
                        score,
                        episodes,
                    });
                }
            }
        }

        // If fewer entries than page size, we've reached the end
        if data.len() < page_size as usize {
            break;
        }

        offset += page_size;
        // Be respectful to MAL
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    }

    Ok(all_entries)
}

#[tauri::command]
async fn fetch_mal_user_profile(
    username: String,
) -> Result<UserProfile, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()
        .map_err(|e| format!("Failed to create client: {}", e))?;

    let url = format!("https://api.jikan.moe/v4/users/{}", username);
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Network error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to fetch profile: HTTP {}", response.status()));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let image_url = body["data"]["images"]["jpg"]["image_url"]
        .as_str()
        .unwrap_or("")
        .to_string();

    Ok(UserProfile { image_url })
}

#[tauri::command]
fn save_mal_username(username: String) -> Result<(), String> {
    let file_path = get_data_dir().join("mal_username.txt");
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    fs::write(&file_path, &username).map_err(|e| format!("Failed to save username: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_mal_username() -> Result<Option<String>, String> {
    let file_path = get_data_dir().join("mal_username.txt");
    if !file_path.exists() {
        return Ok(None);
    }
    let username = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read username: {}", e))?;
    let trimmed = username.trim().to_string();
    if trimmed.is_empty() {
        return Ok(None);
    }
    Ok(Some(trimmed))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MalCacheEntry {
    pub mal_id: u32,
    pub status: String,
    pub score: i32,
    pub episodes: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MalCacheData {
    pub username: String,
    pub profile_img: String,
    pub entries: Vec<MalCacheEntry>,
}

#[tauri::command]
fn save_mal_cache(data: MalCacheData) -> Result<(), String> {
    let file_path = get_data_dir().join("mal_cache.json");
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    let content = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize MAL cache: {}", e))?;
    fs::write(&file_path, content).map_err(|e| format!("Failed to save MAL cache: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_mal_cache() -> Result<Option<MalCacheData>, String> {
    let file_path = get_data_dir().join("mal_cache.json");
    if !file_path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&file_path)
        .map_err(|e| format!("Failed to read MAL cache: {}", e))?;
    let data: MalCacheData = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse MAL cache: {}", e))?;
    Ok(Some(data))
}

#[tauri::command]
fn clear_mal_cache() -> Result<(), String> {
    let file_path = get_data_dir().join("mal_cache.json");
    if file_path.exists() {
        fs::remove_file(&file_path)
            .map_err(|e| format!("Failed to clear MAL cache: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<(), String> {
    let file_path = get_data_dir().join("settings.json");
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Failed to create data dir: {}", e))?;
    }
    let content =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&file_path, content).map_err(|e| format!("Failed to save settings: {}", e))?;
    Ok(())
}

#[tauri::command]
fn load_settings() -> Result<AppSettings, String> {
    let file_path = get_data_dir().join("settings.json");
    if !file_path.exists() {
        return Ok(AppSettings {
            theme: "yumeko".to_string(),
            sort: "name-asc".to_string(),
            window_width: None,
            window_height: None,
            window_x: None,
            window_y: None,
            window_maximized: None,
        });
    }
    let content =
        fs::read_to_string(&file_path).map_err(|e| format!("Failed to read settings: {}", e))?;
    let settings: AppSettings =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse settings: {}", e))?;
    Ok(settings)
}

const SMB_PORT: u16 = 1445;
const SMB_SHARE: &str = "Anime";

static CANCEL_TRANSFER: AtomicBool = AtomicBool::new(false);
static SPEED_BYTES: AtomicU64 = AtomicU64::new(0);
static SPEED_START: Mutex<Option<Instant>> = Mutex::new(None);
static CURRENT_REMOTE_FILE: Mutex<String> = Mutex::new(String::new());

fn format_speed(bytes: u64, elapsed: std::time::Duration) -> String {
    if elapsed.as_secs_f64() < 0.1 || bytes == 0 {
        return String::new();
    }
    let speed = bytes as f64 / elapsed.as_secs_f64();
    if speed >= 1_000_000.0 {
        format!("{:.1} MB/s", speed / 1_000_000.0)
    } else if speed >= 1_000.0 {
        format!("{:.0} KB/s", speed / 1_000.0)
    } else {
        format!("{:.0} B/s", speed)
    }
}

fn start_speed_tracker() {
    SPEED_BYTES.store(0, Ordering::SeqCst);
    *SPEED_START.lock().unwrap() = Some(Instant::now());
}

fn get_current_speed() -> String {
    let bytes = SPEED_BYTES.load(Ordering::SeqCst);
    let start = SPEED_START.lock().unwrap();
    if let Some(s) = start.as_ref() {
        format_speed(bytes, s.elapsed())
    } else {
        String::new()
    }
}

#[tauri::command]
fn cancel_transfer() {
    CANCEL_TRANSFER.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn reset_cancel_flag() {
    CANCEL_TRANSFER.store(false, Ordering::SeqCst);
}

#[tauri::command]
async fn discover_smb_phone() -> Result<String, String> {
    let mut handles = Vec::new();
    for x in 100..=109 {
        let ip = format!("192.168.1.{}", x);
        handles.push(tokio::spawn(async move {
            let result = tokio::time::timeout(
                std::time::Duration::from_millis(500),
                tokio::net::TcpStream::connect(format!("{}:{}", ip, SMB_PORT))
            ).await;
            match result {
                Ok(Ok(_)) => Some(ip),
                _ => None,
            }
        }));
    }

    for handle in handles {
        if let Ok(result) = handle.await {
            if let Some(ip) = result {
                return Ok(ip);
            }
        }
    }
    Err(format!("No phone found on network. Make sure the SMB server is running on port {} with a share named '{}'.", SMB_PORT, SMB_SHARE))
}

#[tauri::command]
async fn verify_smb_ip(ip: String) -> Result<String, String> {
    let addr = format!("{}:{}", ip, SMB_PORT);
    let result = tokio::time::timeout(
        std::time::Duration::from_millis(1500),
        tokio::net::TcpStream::connect(&addr),
    ).await;
    match result {
        Ok(Ok(_)) => Ok(ip),
        _ => Err(format!("Could not connect to {} on port {}. Make sure the SMB server is running.", ip, SMB_PORT)),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EntryFile {
    pub name: String,
    pub relative_path: String,
    pub size: u64,
    pub is_video: bool,
}

fn list_files_recursive(dir: &Path, base: &Path, out: &mut Vec<EntryFile>) {
    const VIDEO_EXTS: &[&str] = &["mkv", "mp4", "avi", "webm", "mov", "wmv", "flv", "m4v", "ts"];
    if let Ok(entries) = fs::read_dir(dir) {
        let mut sorted: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        sorted.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        for entry in sorted {
            let path = entry.path();
            if path.is_dir() {
                list_files_recursive(&path, base, out);
            } else if path.is_file() {
                let rel = path.strip_prefix(base).unwrap_or(&path);
                let ext = path.extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                out.push(EntryFile {
                    name: path.file_name().unwrap_or_default().to_string_lossy().to_string(),
                    relative_path: rel.to_string_lossy().to_string().replace('\\', "/"),
                    size,
                    is_video: VIDEO_EXTS.contains(&ext.as_str()),
                });
            }
        }
    }
}

#[tauri::command]
fn list_entry_files(
    entry_id: String,
    root_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<EntryFile>, String> {
    let entries = scan_anime_folder(root_path, state)?;
    let entry = entries.iter()
        .find(|e| e.id == entry_id)
        .ok_or("Entry not found")?;

    let source = Path::new(&entry.folder_path);
    if !source.exists() {
        return Err("Folder not found".into());
    }

    let mut files = Vec::new();
    list_files_recursive(source, source, &mut files);
    Ok(files)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub percentage: u8,
    pub files_copied: u32,
    pub total_files: u32,
    pub status: String,
    pub speed: String,
}

async fn copy_dir_to_smb(
    app: tauri::AppHandle,
    source: &Path,
    source_root: &Path,
    client: &mut smb2::SmbClient,
    share: &mut smb2::Tree,
    dest_path: &str,
    files_copied: &mut u32,
    total_files: u32,
    filter_set: &Option<std::collections::HashSet<String>>,
) -> Result<(), String> {
    let normalized = dest_path.trim_start_matches('/').trim_start_matches('\\');
    if !normalized.is_empty() {
        if client.stat(share, normalized).await.is_err() {
            client.create_directory(share, normalized)
                .await
                .map_err(|e| format!("Failed to create remote dir {}: {}", normalized, e))?;
        }
    }

    let entries = fs::read_dir(source)
        .map_err(|e| format!("Failed to read local dir: {}", e))?;

    for entry in entries {
        if CANCEL_TRANSFER.load(Ordering::SeqCst) {
            let partial = CURRENT_REMOTE_FILE.lock().unwrap().clone();
            if !partial.is_empty() {
                let _ = client.delete_file(share, &partial).await;
            }
            return Err("Cancelled by user".into());
        }

        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let remote_path = if normalized.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", normalized, name)
        };

        if path.is_dir() {
            let rp = remote_path.clone();
            Box::pin(copy_dir_to_smb(app.clone(), &path, source_root, client, share, &rp, files_copied, total_files, filter_set)).await?;
        } else {
            if let Some(ref allowed) = filter_set {
                let rel = path.strip_prefix(source_root).unwrap_or(&path);
                let rel_str = rel.to_string_lossy().to_string().replace('\\', "/");
                if !allowed.contains(&rel_str) {
                    continue;
                }
            }
            let next = *files_copied + 1;

            if client.stat(share, &remote_path).await.is_ok() {
                let pct = if total_files > 0 {
                    ((*files_copied as f32 / total_files as f32) * 100.0) as u8
                } else { 0 };

                app.emit_all("transfer-progress", TransferProgress {
                    percentage: pct.min(99),
                    files_copied: next,
                    total_files,
                    status: format!("Skipping {} (exists) ({}/{})", name, next, total_files),
                    speed: get_current_speed(),
                }).ok();

                *files_copied = next;
            } else {
                let app_clone = app.clone();
                let fc_clone = *files_copied;
                let name_clone = name.clone();

                let data = fs::read(&path)
                    .map_err(|e| format!("Failed to read file: {}", e))?;
                let file_size = data.len() as u64;

                *CURRENT_REMOTE_FILE.lock().unwrap() = remote_path.clone();

                let write_result = client.write_file_with_progress(
                    share,
                    &remote_path,
                    &data,
                    |progress: smb2::Progress| {
                        if CANCEL_TRANSFER.load(Ordering::SeqCst) {
                            return ControlFlow::Break(());
                        }

                        let bytes_now = progress.bytes_transferred;
                        SPEED_BYTES.store(bytes_now, Ordering::SeqCst);

                        let write_pct = if file_size > 0 {
                            ((bytes_now as f32 / file_size as f32) * 100.0) as u8
                        } else { 0 };

                        let overall_pct = if total_files > 0 {
                            ((fc_clone as f32 / total_files as f32) * 100.0) as u8
                        } else { 0 };

                        app_clone.emit_all("transfer-progress", TransferProgress {
                            percentage: overall_pct.min(99),
                            files_copied: fc_clone + 1,
                            total_files,
                            status: format!("Writing {} ({}%) ({}/{})", name_clone, write_pct, fc_clone + 1, total_files),
                            speed: get_current_speed(),
                        }).ok();

                        ControlFlow::Continue(())
                    },
                ).await;

                *CURRENT_REMOTE_FILE.lock().unwrap() = String::new();

                match write_result {
                    Ok(_) => {
                        SPEED_BYTES.fetch_add(file_size, Ordering::SeqCst);
                        *files_copied = next;

                        let pct_after = if total_files > 0 {
                            ((*files_copied as f32 / total_files as f32) * 100.0) as u8
                        } else { 0 };

                        app.emit_all("transfer-progress", TransferProgress {
                            percentage: pct_after.min(99),
                            files_copied: *files_copied,
                            total_files,
                            status: format!("Copied {} ({}/{})", name, *files_copied, total_files),
                            speed: get_current_speed(),
                        }).ok();
                    }
                    Err(_) => {
                        let _ = client.delete_file(share, &remote_path).await;
                        if CANCEL_TRANSFER.load(Ordering::SeqCst) {
                            return Err("Cancelled by user".into());
                        }
                        return Err(format!("Failed to write {}: {}", name, write_result.unwrap_err()));
                    }
                }
            }
        }
    }

    Ok(())
}

fn count_files(dir: &Path) -> u32 {
    let mut count = 0;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                count += count_files(&path);
            } else {
                count += 1;
            }
        }
    }
    count
}

#[tauri::command]
async fn transfer_folder_to_phone(
    app: tauri::AppHandle,
    entry_id: String,
    root_path: String,
    phone_ip: String,
    selected_files: Option<Vec<String>>,
) -> Result<String, String> {
    CANCEL_TRANSFER.store(false, Ordering::SeqCst);

    let entries = scan_anime_folder(root_path.clone(), app.state())?;
    let entry = entries.iter()
        .find(|e| e.id == entry_id)
        .ok_or("Entry not found in library")?;

    let source = Path::new(&entry.folder_path);
    if !source.exists() {
        return Err(format!("Source folder not found: {}", entry.folder_path));
    }

    let folder_name = source.file_name()
        .ok_or("Could not determine folder name")?
        .to_string_lossy()
        .to_string();

    let filter_set: Option<std::collections::HashSet<String>> = selected_files.map(|v| v.into_iter().collect());

    let total_files = if let Some(ref fs) = filter_set {
        fs.len() as u32
    } else {
        count_files(source)
    };

    let addr = format!("{}:{}", phone_ip, SMB_PORT);
    start_speed_tracker();

    let speed_app = app.clone();
    let speed_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(500));
        loop {
            interval.tick().await;
            let speed = get_current_speed();
            if !speed.is_empty() {
                speed_app.emit_all("transfer-speed", speed).ok();
            }
        }
    });

    app.emit_all("transfer-progress", TransferProgress {
        percentage: 0,
        files_copied: 0,
        total_files,
        status: format!("Connecting to {}...", addr),
        speed: String::new(),
    }).ok();

    let mut client = smb2::connect(&addr, "", "")
        .await
        .map_err(|e| format!("Failed to connect to {}: {}", addr, e))?;

    let mut share = client.connect_share(SMB_SHARE)
        .await
        .map_err(|e| format!("Failed to connect to '{}' share: {}", SMB_SHARE, e))?;

    let mut files_copied: u32 = 0;
    let result = copy_dir_to_smb(
        app.clone(),
        source,
        source,
        &mut client,
        &mut share,
        &folder_name,
        &mut files_copied,
        total_files,
        &filter_set,
    ).await;

    speed_handle.abort();

    if result.is_err() {
        return result.map(|_| String::new());
    }

    app.emit_all("transfer-progress", TransferProgress {
        percentage: 100,
        files_copied,
        total_files,
        status: "Complete!".into(),
        speed: get_current_speed(),
    }).ok();

    Ok(format!("{} files transferred to {}/{}", files_copied, SMB_SHARE, folder_name))
}

// ============== Migration Helper ==============

/// Called by the frontend after a scan when it detects that some current entries
/// have no mapping. We load the mapping file for this root and try to match
/// unmapped entries to orphaned mapped entries by comparing their folder-name stem.
/// On a match we rewrite the mapping entry's id and copy the cached poster file.
/// Returns a list of (new_id, old_id) pairs so JS can update its in-memory state.
#[tauri::command]
fn migrate_mappings(
    root_path: String,
    current_entries: Vec<AnimeEntry>,
) -> Result<Vec<(String, String)>, String> {
    let mapping_file = get_mapping_file(&root_path);
    if !mapping_file.exists() {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(&mapping_file)
        .map_err(|e| format!("Failed to read mappings: {}", e))?;
    let mut data: MappingData = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse mappings: {}", e))?;

    // IDs that are live in the current scan
    let current_ids: std::collections::HashSet<&str> =
        current_entries.iter().map(|e| e.id.as_str()).collect();

    let mut migrations: Vec<(String, String)> = Vec::new();
    let mut changed = false;

    for mapped in data.entries.iter_mut() {
        // This mapping id is still valid — nothing to do
        if current_ids.contains(mapped.id.as_str()) {
            continue;
        }

        let old_id = mapped.id.clone();

        // Try to find a current entry that is not yet covered by any mapping
        // and whose folder stem matches the mapped title (which IS the folder name).
        let candidate = current_entries.iter().find(|e| {
            let stem = Path::new(&e.folder_path)
                .file_name()
                .map(|n| n.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            // Match against the raw MAL title stored in the mapping (the folder name)
            if let Some(ref t) = mapped.title {
                if stem == t.to_lowercase() {
                    return true;
                }
            }
            false
        });

        if let Some(new_entry) = candidate {
            if new_entry.id != old_id {
                migrations.push((new_entry.id.clone(), old_id.clone()));

                // Copy cached poster to new id path so we don't re-download
                let posters_dir = get_posters_dir();
                let old_poster = posters_dir.join(format!("{}.jpg", old_id));
                let new_poster = posters_dir.join(format!("{}.jpg", &new_entry.id));
                if old_poster.exists() && !new_poster.exists() {
                    let _ = fs::copy(&old_poster, &new_poster);
                }

                mapped.id = new_entry.id.clone();
                changed = true;
            }
        }
    }

    if changed {
        if let Ok(serialized) = serde_json::to_string_pretty(&data) {
            let _ = fs::write(&mapping_file, serialized);
        }
    }

    Ok(migrations)
}

// ============== Main ==============

fn main() {
    let client = reqwest::Client::builder()
        .user_agent("AniShelf/1.0")
        .build()
        .expect("Failed to create HTTP client");

    let state = AppState {
        client,
        num_pattern: Regex::new(r"^(\d+)").expect("Invalid regex"),
        strip_pattern: Regex::new(r"^\d+\.\s*").expect("Invalid regex"),
        mapping_lock: Mutex::new(()),
    };

    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            select_directory,
            open_folder,
            scan_anime_folder,
            search_mal,
            load_mappings,
            save_mapping,
            cache_poster,
            get_cached_poster,
            delete_cached_poster,
            create_anime_folder,
            convert_standalone_to_franchise,
            save_last_path,
            load_last_path,
            fetch_user_animelist,
            fetch_mal_user_profile,
            fetch_anime_episodes,
            save_mal_username,
            load_mal_username,
            save_mal_cache,
            load_mal_cache,
            clear_mal_cache,
            save_settings,
            load_settings,
            discover_smb_phone,
            verify_smb_ip,
            list_entry_files,
            transfer_folder_to_phone,
            cancel_transfer,
            reset_cancel_flag,
            migrate_mappings,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
