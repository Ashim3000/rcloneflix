use std::path::{Path, PathBuf};
use std::process::Stdio;
use log::info;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::process::Child;
use tokio::sync::Mutex;
use crate::process_ext::tokio_command;

static ALIST_PROCESS: Mutex<Option<Child>> = Mutex::const_new(None);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AlistStatus {
    pub running: bool,
    pub port: u16,
    pub streamtape_configured: bool,
    pub error: Option<String>,
}

/// Find bundled or dev AList binary path
pub fn alist_binary(app: &AppHandle) -> PathBuf {
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sidecar = if cfg!(target_os = "windows") {
        resource_dir.join("alist.exe")
    } else {
        resource_dir.join("alist")
    };

    if sidecar.exists() {
        return sidecar;
    }

    let flatpak_bin = PathBuf::from("/app/bin/alist");
    if flatpak_bin.exists() {
        return flatpak_bin;
    }

    // In development mode, check relative src-tauri or current directory
    if cfg!(target_os = "windows") {
        let dev = PathBuf::from("src-tauri").join("alist.exe");
        if dev.exists() {
            return dev;
        }
    } else {
        let dev = PathBuf::from("src-tauri").join("alist");
        if dev.exists() {
            return dev;
        }
    }

    PathBuf::from(if cfg!(target_os = "windows") { "alist.exe" } else { "alist" })
}

/// Get the isolated app data directory for AList runtime data and database
pub fn get_alist_data_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("alist_data")
}

/// Ensure AList configuration file exists and binds to loopback 127.0.0.1:5244
fn ensure_alist_config(data_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data_dir).map_err(|e| format!("Failed to create AList data directory: {}", e))?;
    let _ = std::fs::create_dir_all(data_dir.join("temp"));
    let _ = std::fs::create_dir_all(data_dir.join("bleve"));
    let _ = std::fs::create_dir_all(data_dir.join("log"));

    let config_path = data_dir.join("config.json");
    let db_file_abs = data_dir.join("data.db").to_string_lossy().to_string();
    let temp_dir_abs = data_dir.join("temp").to_string_lossy().to_string();
    let bleve_dir_abs = data_dir.join("bleve").to_string_lossy().to_string();
    let log_file_abs = data_dir.join("log").join("log.log").to_string_lossy().to_string();

    if config_path.exists() {
        if let Ok(content) = std::fs::read_to_string(&config_path) {
            if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(&content) {
                let mut modified = false;
                if let Some(db) = json.get_mut("database") {
                    if db.get("db_file").and_then(|v| v.as_str()) != Some(&db_file_abs) {
                        db["db_file"] = serde_json::Value::String(db_file_abs.clone());
                        modified = true;
                    }
                }
                if json.get("temp_dir").and_then(|v| v.as_str()) != Some(&temp_dir_abs) {
                    json["temp_dir"] = serde_json::Value::String(temp_dir_abs.clone());
                    modified = true;
                }
                if json.get("bleve_dir").and_then(|v| v.as_str()) != Some(&bleve_dir_abs) {
                    json["bleve_dir"] = serde_json::Value::String(bleve_dir_abs.clone());
                    modified = true;
                }
                if let Some(log) = json.get_mut("log") {
                    if log.get("name").and_then(|v| v.as_str()) != Some(&log_file_abs) {
                        log["name"] = serde_json::Value::String(log_file_abs.clone());
                        modified = true;
                    }
                }
                if modified {
                    let _ = std::fs::write(&config_path, serde_json::to_string_pretty(&json).unwrap());
                }
                return Ok(());
            }
        }
    }

    let config = serde_json::json!({
        "force": false,
        "site_url": "",
        "cdn": "",
        "jwt_secret": "rcloneflix_alist_internal_secret",
        "token_expires_in": 72,
        "database": {
            "type": "sqlite3",
            "host": "",
            "port": 0,
            "user": "",
            "password": "",
            "name": "",
            "db_file": db_file_abs,
            "table_prefix": "x_",
            "ssl_mode": ""
        },
        "scheme": {
            "address": "127.0.0.1",
            "http_port": 5244,
            "https_port": -1,
            "force_https": false,
            "cert_file": "",
            "key_file": ""
        },
        "temp_dir": temp_dir_abs,
        "bleve_dir": bleve_dir_abs,
        "log": {
            "enable": true,
            "name": log_file_abs,
            "max_size": 10,
            "max_backups": 3,
            "max_age": 7,
            "compress": false
        },
        "max_connections": 0,
        "tls_insecure_skip_verify": true
    });
    std::fs::write(&config_path, serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| format!("Failed to write initial AList config.json: {}", e))?;

    Ok(())
}

/// Ensure AList admin password is set to 'rcloneflix' universally
pub async fn ensure_alist_admin_password(app: &AppHandle) -> Result<(), String> {
    let bin = alist_binary(app);
    let data_dir = get_alist_data_dir(app);
    ensure_alist_config(&data_dir)?;

    info!(target: "alist", "Ensuring universal AList admin password is set to 'rcloneflix'...");
    let mut cmd = tokio_command(&bin);
    cmd.arg("admin")
        .arg("set")
        .arg("rcloneflix")
        .arg("--data")
        .arg(&data_dir)
        .current_dir(&data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let _ = cmd.output().await;
    Ok(())
}

/// Configure the Streamtape driver in AList's SQLite database directly.
/// Returns `Ok(true)` if the `/streamtape` row was inserted or changed (requiring an AList restart),
/// or `Ok(false)` if the existing row already matches.
pub fn configure_streamtape_storage(data_dir: &Path, api_login: &str, api_key: &str) -> Result<bool, String> {
    let db_path = data_dir.join("data.db");
    if !db_path.exists() {
        return Err("AList data.db does not exist yet. Please start AList once to initialize.".to_string());
    }

    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("Failed to open AList data.db: {}", e))?;

    let addition = serde_json::json!({
        "root_folder_id": "0",
        "api_login": api_login.trim(),
        "api_key": api_key.trim(),
        "enable_range_control": false,
        "range_mode": "chunk",
        "range_chunk_mb": 8,
        "range_concurrency": 1,
    }).to_string();

    let existing: Option<(String, i64)> = conn
        .query_row(
            "SELECT addition, disabled FROM x_storages WHERE mount_path = '/streamtape' LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();

    if let Some((cur_addition, cur_disabled)) = existing {
        if cur_addition == addition && cur_disabled == 0 {
            return Ok(false);
        }
    }

    conn.execute(
        "INSERT INTO x_storages (
            mount_path, \"order\", driver, cache_expiration, status, addition, remark,
            disabled, enable_sign, extract_folder, web_proxy, webdav_policy, down_proxy_sign
        ) VALUES (
            '/streamtape', 0, 'Streamtape', 30, 'work', ?1, 'Streamtape CDN Edge Cache',
            0, 0, 'front', 1, '302_redirect', 0
        ) ON CONFLICT(mount_path) DO UPDATE SET
            driver = 'Streamtape',
            addition = excluded.addition,
            disabled = 0,
            enable_sign = 0,
            extract_folder = 'front',
            web_proxy = 1,
            webdav_policy = '302_redirect',
            down_proxy_sign = 0,
            status = 'work';",
        [&addition],
    ).map_err(|e| format!("Failed to configure Streamtape in AList database: {}", e))?;

    Ok(true)
}

fn write_streamtape_remote_to_file(path: &Path) -> Result<(), String> {
    let content = if path.exists() {
        std::fs::read_to_string(path).unwrap_or_default()
    } else {
        String::new()
    };

    let streamtape_block = "[streamtape]\ntype = webdav\nurl = http://127.0.0.1:5244/dav/streamtape\nvendor = other\nuser = admin\npass = DX7ZUA9B10vScxTPS9Q57GzeK8R4Ojq71HI\n";

    let new_content = if let Some(idx) = content.find("[streamtape]") {
        let after = &content[idx + "[streamtape]".len()..];
        let next_section = after.find("\n[").map(|i| idx + "[streamtape]".len() + i).unwrap_or(content.len());
        format!("{}{}\n{}", &content[..idx], streamtape_block, &content[next_section..].trim_start())
    } else {
        let prefix = if content.is_empty() || content.ends_with('\n') { "" } else { "\n" };
        format!("{}{}\n{}", content, prefix, streamtape_block)
    };

    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, new_content)
        .map_err(|e| format!("Failed to write streamtape remote to {:?}: {}", path, e))?;

    Ok(())
}

/// Automatically inject or verify the [streamtape] WebDAV remote in rclone.conf
pub fn ensure_streamtape_rclone_remote(config_path: &str) -> Result<(), String> {
    if let Some(resolved) = crate::commands::rclone_sync::resolve_config_arg(config_path) {
        let path = Path::new(&resolved);
        write_streamtape_remote_to_file(path)?;
        info!(target: "alist", "Successfully ensured [streamtape] WebDAV remote in {:?}", path);
    } else if !config_path.trim().is_empty() {
        let path = Path::new(config_path.trim());
        write_streamtape_remote_to_file(path)?;
    }

    // Also ensure default OS rclone.conf has it if distinct
    if let Ok(home) = std::env::var("HOME") {
        let default_cfg = PathBuf::from(home).join(".config/rclone/rclone.conf");
        if default_cfg.exists() {
            let _ = write_streamtape_remote_to_file(&default_cfg);
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        let default_cfg = PathBuf::from(appdata).join("rclone/rclone.conf");
        if default_cfg.exists() {
            let _ = write_streamtape_remote_to_file(&default_cfg);
        }
    }

    Ok(())
}

/// Start AList daemon child process
pub async fn start_alist_server(app: &AppHandle) -> Result<(), String> {
    {
        let mut lock = ALIST_PROCESS.lock().await;
        if let Some(child) = lock.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *lock = None;
            } else {
                return Ok(());
            }
        }
    }

    let bin = alist_binary(app);
    let data_dir = get_alist_data_dir(app);
    ensure_alist_config(&data_dir)?;
    ensure_alist_admin_password(app).await?;

    info!(target: "alist", "Spawning AList server from {:?} with data dir {:?}", bin, data_dir);
    let mut cmd = tokio_command(&bin);
    cmd.arg("server")
        .arg("--data")
        .arg(&data_dir)
        .current_dir(&data_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn alist process: {}", e))?;

    let mut lock = ALIST_PROCESS.lock().await;
    *lock = Some(child);
    Ok(())
}

/// Stop AList daemon child process
pub async fn stop_alist_server() -> Result<(), String> {
    let child_opt = {
        let mut lock = ALIST_PROCESS.lock().await;
        lock.take()
    };
    if let Some(mut child) = child_opt {
        info!(target: "alist", "Terminating AList server child process...");
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn start_alist_daemon(
    app: AppHandle,
    config_path: String,
    api_login: Option<String>,
    api_key: Option<String>,
) -> Result<AlistStatus, String> {
    let data_dir = get_alist_data_dir(&app);
    ensure_alist_config(&data_dir)?;
    ensure_alist_admin_password(&app).await?;

    let mut storage_changed = false;
    // If login and key are provided, configure storage
    if let (Some(login), Some(key)) = (api_login, api_key) {
        if !login.trim().is_empty() && !key.trim().is_empty() {
            storage_changed = configure_streamtape_storage(&data_dir, &login, &key)?;
            ensure_streamtape_rclone_remote(&config_path)?;
        }
    }

    if storage_changed {
        let _ = stop_alist_server().await;
    }
    start_alist_server(&app).await?;

    get_alist_status(app).await
}

#[tauri::command]
pub async fn stop_alist_daemon() -> Result<bool, String> {
    stop_alist_server().await?;
    Ok(true)
}

#[tauri::command]
pub async fn get_alist_status(app: AppHandle) -> Result<AlistStatus, String> {
    let is_running = {
        let mut lock = ALIST_PROCESS.lock().await;
        if let Some(child) = lock.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                *lock = None;
                false
            } else {
                true
            }
        } else {
            false
        }
    };

    let data_dir = get_alist_data_dir(&app);
    let db_path = data_dir.join("data.db");
    let streamtape_configured = if db_path.exists() {
        if let Ok(conn) = rusqlite::Connection::open(&db_path) {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM x_storages WHERE mount_path = '/streamtape' AND disabled = 0;",
                [],
                |r| r.get(0),
            ).unwrap_or(0);
            count > 0
        } else {
            false
        }
    } else {
        false
    };

    Ok(AlistStatus {
        running: is_running,
        port: 5244,
        streamtape_configured,
        error: None,
    })
}

#[tauri::command]
pub async fn configure_streamtape(
    app: AppHandle,
    config_path: String,
    api_login: String,
    api_key: String,
) -> Result<bool, String> {
    let data_dir = get_alist_data_dir(&app);
    ensure_alist_config(&data_dir)?;
    ensure_alist_admin_password(&app).await?;

    configure_streamtape_storage(&data_dir, &api_login, &api_key)?;
    ensure_streamtape_rclone_remote(&config_path)?;

    let _ = stop_alist_server().await;
    start_alist_server(&app).await?;

    Ok(true)
}
