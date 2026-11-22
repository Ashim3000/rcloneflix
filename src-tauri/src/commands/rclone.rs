use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use crate::process_ext::tokio_command;
use tauri::{AppHandle, Manager};
pub use crate::commands::rclone_sync::resolve_config_arg;

/// Represents a single rclone remote parsed from the config file
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RcloneRemote {
    pub name: String,
    pub remote_type: String,
}

/// Represents a file/directory listed by rclone
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RcloneListItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: i64,
    pub mime_type: Option<String>,
    pub mod_time: Option<String>,
}

/// Find the bundled rclone binary path.
/// In development we look on PATH; in production it's bundled as a sidecar.
fn rclone_binary(app: &AppHandle) -> PathBuf {
    // Try to find sidecar first
    let resource_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("."));

    let sidecar = if cfg!(target_os = "windows") {
        resource_dir.join("rclone.exe")
    } else {
        resource_dir.join("rclone")
    };

    if sidecar.exists() {
        return sidecar;
    }

    // Fall back to PATH (useful in dev)
    PathBuf::from("rclone")
}

/// Parse an rclone config file and return the list of remotes.
/// The rclone config format is an INI-style file where section names are remote names
/// and the `type` key gives the remote type.
#[tauri::command]
pub fn parse_rclone_config(
    config_path: String,
) -> Result<Vec<RcloneRemote>, String> {
    let resolved_path = crate::commands::rclone_sync::resolve_config_arg(&config_path)
        .unwrap_or_else(|| config_path.clone());
    let path = Path::new(&resolved_path);
    if !path.exists() {
        return Err(format!("Config file not found: {}", resolved_path));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read config: {}", e))?;

    let mut remotes = Vec::new();
    let mut current_section: Option<String> = None;
    let mut current_type: Option<String> = None;

    for line in content.lines() {
        let line = line.trim();

        if line.starts_with('[') && line.ends_with(']') {
            // Save previous section if it had a type
            if let (Some(name), Some(rtype)) = (current_section.take(), current_type.take()) {
                remotes.push(RcloneRemote {
                    name,
                    remote_type: rtype,
                });
            }
            current_section = Some(line[1..line.len() - 1].to_string());
            current_type = None;
        } else if line.starts_with("type") {
            if let Some(value) = line.splitn(2, '=').nth(1) {
                current_type = Some(value.trim().to_string());
            }
        }
    }

    // Don't forget the last section
    if let (Some(name), Some(rtype)) = (current_section, current_type) {
        remotes.push(RcloneRemote {
            name,
            remote_type: rtype,
        });
    }

    Ok(remotes)
}

/// List the contents of a remote path using rclone lsjson
#[tauri::command]
pub async fn list_remote_path(
    app: AppHandle,
    config_path: String,
    remote_path: String,
) -> Result<Vec<RcloneListItem>, String> {
    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    let mut cmd = tokio_command(&rclone);
    cmd.arg("lsjson");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
        &remote_path,
    ]);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone: {}. Is rclone installed?", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone error: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    #[derive(Deserialize)]
    struct RcloneJsonItem {
        #[serde(rename = "Name")]
        name: String,
        #[serde(rename = "Path")]
        path: String,
        #[serde(rename = "IsDir")]
        is_dir: bool,
        #[serde(rename = "Size")]
        size: i64,
        #[serde(rename = "MimeType")]
        mime_type: Option<String>,
        #[serde(rename = "ModTime")]
        mod_time: Option<String>,
    }

    let items: Vec<RcloneJsonItem> = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse rclone output: {}", e))?;

    let result = items
        .into_iter()
        .map(|i| RcloneListItem {
            name: i.name,
            path: i.path,
            is_dir: i.is_dir,
            size: i.size,
            mime_type: i.mime_type,
            mod_time: i.mod_time,
        })
        .collect();

    Ok(result)
}

/// Get rclone version string (also validates rclone is available)
#[tauri::command]
pub async fn get_rclone_version(app: AppHandle) -> Result<String, String> {
    let rclone = rclone_binary(&app);

    let output = tokio_command(&rclone)
        .arg("version")
        .output()
        .await
        .map_err(|e| format!("rclone not found: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let first_line = stdout.lines().next().unwrap_or("rclone unknown").to_string();
    Ok(first_line)
}

/// Create a new crypt remote in the user's rclone config file.
/// Executes: rclone config create <remote_name> crypt remote <base_remote_path> password <password> filename_encryption standard directory_name_encryption true --obscure
#[tauri::command]
pub async fn rclone_create_crypt_remote(
    app: AppHandle,
    config_path: String,
    remote_name: String,
    base_remote_path: String,
    password: String,
    password2: Option<String>,
) -> Result<Vec<RcloneRemote>, String> {
    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.args([
        "config",
        "create",
        &remote_name,
        "crypt",
        "remote",
        &base_remote_path,
        "password",
        &password,
        "filename_encryption",
        "standard",
        "directory_name_encryption",
        "true",
        "--obscure",
    ]);

    if let Some(ref p2) = password2 {
        if !p2.trim().is_empty() {
            cmd.args(["password2", p2.trim()]);
        }
    }

    let resolved_cfg = resolve_config_arg(&config_path)
        .unwrap_or_else(|| config_path.clone());
    if !resolved_cfg.trim().is_empty() {
        cmd.args(["--config", &resolved_cfg]);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone config create: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create crypt remote: {}", stderr.trim()));
    }

    // Return updated list of parsed remotes
    parse_rclone_config(resolved_cfg)
}

/// Create a new WebDAV remote in the user's rclone config file (e.g. for Telegram Drive).
/// Executes: rclone config create <remote_name> webdav url <url> vendor other [user <user>] [pass <password>] --obscure
#[tauri::command]
pub async fn rclone_create_webdav_remote(
    app: AppHandle,
    config_path: String,
    remote_name: String,
    url: String,
    vendor: Option<String>,
    user: Option<String>,
    pass: Option<String>,
) -> Result<Vec<RcloneRemote>, String> {
    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    let vendor_val = vendor.unwrap_or_else(|| "other".to_string());
    cmd.args([
        "config",
        "create",
        &remote_name,
        "webdav",
        "url",
        &url,
        "vendor",
        &vendor_val,
    ]);

    if let Some(ref u) = user {
        if !u.trim().is_empty() {
            cmd.args(["user", u.trim()]);
        }
    }

    if let Some(ref p) = pass {
        if !p.trim().is_empty() {
            cmd.args(["pass", p.trim(), "--obscure"]);
        }
    }

    let resolved_cfg = resolve_config_arg(&config_path)
        .unwrap_or_else(|| config_path.clone());
    if !resolved_cfg.trim().is_empty() {
        cmd.args(["--config", &resolved_cfg]);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone config create: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Failed to create WebDAV remote: {}", stderr.trim()));
    }

    parse_rclone_config(resolved_cfg)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MergeScopedConfigResult {
    pub config_path: String,
    pub remotes: Vec<RcloneRemote>,
}

/// Merges a scoped rclone config snippet into the destination config file.
#[tauri::command]
pub fn rclone_merge_scoped_config(
    config_path: String,
    scoped_content: String,
) -> Result<MergeScopedConfigResult, String> {
    let target_path: PathBuf = if !config_path.trim().is_empty() {
        PathBuf::from(&config_path)
    } else {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config/rclone/rclone.conf")
        } else if let Ok(appdata) = std::env::var("APPDATA") {
            PathBuf::from(appdata).join("rclone/rclone.conf")
        } else {
            PathBuf::from("rclone.conf")
        }
    };

    if let Some(parent) = target_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    // Extract section names from scoped_content to replace any existing or stale sections
    let incoming_sections: std::collections::HashSet<String> = scoped_content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                Some(trimmed[1..trimmed.len() - 1].trim().to_string())
            } else {
                None
            }
        })
        .collect();

    let mut filtered_content = String::new();
    if target_path.exists() {
        let existing = std::fs::read_to_string(&target_path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        let mut skipping = false;
        for line in existing.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') && trimmed.ends_with(']') {
                let sec = trimmed[1..trimmed.len() - 1].trim();
                skipping = incoming_sections.contains(sec);
            }
            if !skipping {
                filtered_content.push_str(line);
                filtered_content.push('\n');
            }
        }
    }

    let trimmed_existing = filtered_content.trim();
    let mut final_content = if trimmed_existing.is_empty() {
        String::new()
    } else {
        format!("{}\n", trimmed_existing)
    };

    final_content.push_str("\n# --- RcloneFlix Shared Access Pass Remotes ---\n");
    final_content.push_str(&scoped_content);
    final_content.push('\n');

    std::fs::write(&target_path, final_content).map_err(|e| format!("Failed to write config: {}", e))?;
    let remotes = parse_rclone_config(target_path.to_string_lossy().to_string())?;

    Ok(MergeScopedConfigResult {
        config_path: target_path.to_string_lossy().to_string(),
        remotes,
    })
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppliedAdminConfig {
    pub config_path: String,
    pub remotes: Vec<RcloneRemote>,
    pub merged_content: String,
}

/// Safely applies an Admin Pass rclone configuration:
/// - Creates the default OS rclone.conf directory if no config file exists yet
/// - Backs up any existing config file to `<path>.pre_pass_bak` (BEFORE any write)
/// - Preserves local-only remotes; colliding local remotes are kept as `[<name>_local_backup]`
/// - Returns the resolved `config_path`, parsed `remotes` and the final merged text
/// MUST be called WITHOUT a preceding `save_rclone_config_content` (that command overwrites the file).
#[tauri::command]
pub fn rclone_apply_admin_config(
    app: AppHandle,
    config_path: String,
    admin_content: String,
) -> Result<AppliedAdminConfig, String> {
    let target_path: PathBuf = if !config_path.trim().is_empty() && !config_path.starts_with("android://") {
        PathBuf::from(config_path.trim())
    } else if let Some(resolved) = crate::commands::rclone_sync::resolve_config_arg("") {
        PathBuf::from(resolved)
    } else if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("rclone").join("rclone.conf")
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".config").join("rclone").join("rclone.conf")
    } else {
        std::env::temp_dir().join("rcloneflix-rclone.conf")
    };

    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create rclone config directory: {}", e))?;
    }

    let incoming_sections: std::collections::HashSet<String> = admin_content
        .lines()
        .filter_map(|line| {
            let t = line.trim();
            if t.starts_with('[') && t.ends_with(']') {
                Some(t[1..t.len() - 1].trim().to_string())
            } else {
                None
            }
        })
        .collect();

    let mut preserved_local = String::new();
    if target_path.exists() {
        let existing = std::fs::read_to_string(&target_path)
            .map_err(|e| format!("Failed to read existing rclone.conf: {}", e))?;
        if !existing.trim().is_empty() {
            let bak_path = target_path.with_extension("conf.pre_pass_bak");
            let _ = std::fs::write(&bak_path, &existing);

            let mut in_section = false;
            for line in existing.lines() {
                let t = line.trim();
                if t.starts_with('[') && t.ends_with(']') {
                    let sec = t[1..t.len() - 1].trim();
                    in_section = true;
                    if incoming_sections.contains(sec) {
                        preserved_local.push_str(&format!("[{}_local_backup]\n", sec));
                    } else {
                        preserved_local.push_str(line);
                        preserved_local.push('\n');
                    }
                    continue;
                }
                if in_section {
                    preserved_local.push_str(line);
                    preserved_local.push('\n');
                }
            }
        }
    }

    let mut final_content = admin_content.trim().to_string();
    final_content.push('\n');
    if !preserved_local.trim().is_empty() {
        final_content.push_str("\n# --- Preserved Local Remotes ---\n");
        final_content.push_str(preserved_local.trim());
        final_content.push('\n');
    }

    std::fs::write(&target_path, &final_content)
        .map_err(|e| format!("Failed to write rclone.conf to {}: {}", target_path.display(), e))?;

    let resolved_str = target_path.to_string_lossy().to_string();
    let remotes = parse_rclone_config(resolved_str.clone())?;

    let _ = crate::commands::store::set_rclone_config_content_in_store(&app, &final_content);

    Ok(AppliedAdminConfig {
        config_path: resolved_str,
        remotes,
        merged_content: final_content,
    })
}

/// Removes specified scoped remotes from the config file.
#[tauri::command]
pub fn rclone_remove_scoped_remotes(
    config_path: String,
    remote_names: Vec<String>,
) -> Result<Vec<RcloneRemote>, String> {
    let target_path: PathBuf = if !config_path.trim().is_empty() {
        PathBuf::from(&config_path)
    } else {
        if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".config/rclone/rclone.conf")
        } else if let Ok(appdata) = std::env::var("APPDATA") {
            PathBuf::from(appdata).join("rclone/rclone.conf")
        } else {
            PathBuf::from("rclone.conf")
        }
    };

    if !target_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(&target_path).map_err(|e| format!("Failed to read config: {}", e))?;
    let target_set: std::collections::HashSet<String> = remote_names.into_iter().collect();
    let mut new_lines = Vec::new();
    let mut skipping = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            let section = trimmed[1..trimmed.len() - 1].to_string();
            skipping = target_set.contains(&section);
        }
        if !skipping {
            new_lines.push(line);
        }
    }

    let updated = new_lines.join("\n");
    std::fs::write(&target_path, updated).map_err(|e| format!("Failed to write config: {}", e))?;
    parse_rclone_config(target_path.to_string_lossy().to_string())
}

/// Rename or move a file/directory on an rclone remote using rclone moveto
#[tauri::command]
pub async fn rclone_rename_file(
    app: AppHandle,
    config_path: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    if from_path.starts_with("shared_")
        || to_path.starts_with("shared_")
        || path_uses_shared_remote(&config_path, &from_path)?
        || path_uses_shared_remote(&config_path, &to_path)?
    {
        return Err("Permission denied: rename/move operations are forbidden on shared access pass remotes".into());
    }

    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    let mut cmd = tokio_command(&rclone);
    cmd.arg("moveto");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "--server-side-across-configs",
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
        &from_path,
        &to_path,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone moveto: {}", e))?;

    if !output.status.success() {
        let mut retry = tokio_command(&rclone);
        retry.arg("moveto");
        if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
            retry.args(["--config", &cfg]);
        }
        if let Some(bw) = rclone_settings.clean_bw_limit() {
            retry.args(["--bwlimit", &bw]);
        }
        retry.args([
            "--tpslimit",
            &tps_limit_str,
            "--tpslimit-burst",
            &tps_burst_str,
            &from_path,
            &to_path,
        ]);
        let retry_output = retry
            .output()
            .await
            .map_err(|e| format!("Failed to run rclone moveto: {}", e))?;
        if !retry_output.status.success() {
            let stderr = String::from_utf8_lossy(&retry_output.stderr);
            return Err(format!("rclone moveto error: {}", stderr.trim()));
        }
    }
    spawn_best_effort_vfs_refresh_pair(&app, &from_path, &to_path);
    Ok(())
}

/// Copy a file or directory on an rclone remote using rclone copyto
#[tauri::command]
pub async fn rclone_copy_file(
    app: AppHandle,
    config_path: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    if to_path.starts_with("shared_") || path_uses_shared_remote(&config_path, &to_path)? {
        return Err("Permission denied: write operations are forbidden on shared access pass remotes".into());
    }

    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();
    let bw_opt = rclone_settings.clean_bw_limit();

    let mut cmd = tokio_command(&rclone);
    cmd.arg("copyto");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    if let Some(ref bw) = bw_opt {
        cmd.args(["--bwlimit", bw]);
    }
    cmd.args([
        "--server-side-across-configs",
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
        &from_path,
        &to_path,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone copyto: {}", e))?;

    if !output.status.success() {
        let mut retry = tokio_command(&rclone);
        retry.arg("copyto");
        if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
            retry.args(["--config", &cfg]);
        }
        if let Some(ref bw) = bw_opt {
            retry.args(["--bwlimit", bw]);
        }
        retry.args([
            "--tpslimit",
            &tps_limit_str,
            "--tpslimit-burst",
            &tps_burst_str,
            &from_path,
            &to_path,
        ]);
        let retry_output = retry
            .output()
            .await
            .map_err(|e| format!("Failed to run rclone copyto: {}", e))?;
        if !retry_output.status.success() {
            let stderr = String::from_utf8_lossy(&retry_output.stderr);
            return Err(format!("rclone copyto error: {}", stderr.trim()));
        }
    }
    spawn_best_effort_vfs_refresh(&app, &to_path);
    Ok(())
}

/// Delete a file or directory on an rclone remote.
/// When `softDeleteEnabled` is active in RcloneSettings (and the first path segment is not the trash folder),
/// moves the item into `<remote>:<trash_dir>/<unix_epoch_secs>/<rel_path>` via `rclone_rename_file`.
#[tauri::command]
pub async fn rclone_delete_item(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    is_dir: bool,
) -> Result<(), String> {
    if remote_path.starts_with("shared_") || path_uses_shared_remote(&config_path, &remote_path)? {
        return Err("Permission denied: delete operations are forbidden on shared access pass remotes".into());
    }

    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();
    let trash_dir = rclone_settings.clean_soft_delete_trash_dir();

    if rclone_settings.soft_delete_enabled {
        if let Some((remote_prefix, rel_path)) = remote_path.split_once(':') {
            if remote_prefix.trim().len() > 1 {
                let clean_rel = rel_path.trim_start_matches(['/', '\\']);
                let first_seg = clean_rel.split(['/', '\\']).next().unwrap_or("");
                if !clean_rel.is_empty() && first_seg != trash_dir && first_seg != ".rcloneflix_trash" {
                    let ts = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let trash_dest = format!("{}:{}/{}/{}", remote_prefix.trim(), trash_dir, ts, clean_rel);
                    return rclone_rename_file(app, config_path, remote_path, trash_dest).await;
                }
            }
        }
    }

    let mut cmd = tokio_command(&rclone);
    if is_dir {
        cmd.arg("purge");
    } else {
        cmd.arg("deletefile");
    }

    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
        &remote_path,
    ]);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone delete: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone delete error: {}", stderr.trim()));
    }
    spawn_best_effort_vfs_refresh(&app, &remote_path);
    Ok(())
}

// ============================================================================
// CLOUDFLARE WORKER CRYPT & DIRECT STREAM LINK GENERATOR
// ============================================================================

/// Default 16-byte salt used by rclone crypt when `password2` is empty
/// (from rclone/backend/crypt/cipher.go: defaultSalt)
const RCLONE_DEFAULT_SALT: [u8; 16] = [
    0xA8, 0x0D, 0xF4, 0x3A, 0x8F, 0xBD, 0x03, 0x08,
    0xA7, 0xCA, 0xB8, 0x3E, 0x58, 0x1F, 0x86, 0xB1,
];

/// Salsa20/8 core used by scrypt ROMix (RFC 7914)
fn salsa20_8(b: &mut [u8; 64]) {
    let mut x = [0u32; 16];
    for i in 0..16 {
        x[i] = u32::from_le_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]]);
    }
    let orig = x;
    for _ in 0..4 {
        x[4] ^= x[0].wrapping_add(x[12]).rotate_left(7);
        x[8] ^= x[4].wrapping_add(x[0]).rotate_left(9);
        x[12] ^= x[8].wrapping_add(x[4]).rotate_left(13);
        x[0] ^= x[12].wrapping_add(x[8]).rotate_left(18);

        x[9] ^= x[5].wrapping_add(x[1]).rotate_left(7);
        x[13] ^= x[9].wrapping_add(x[5]).rotate_left(9);
        x[1] ^= x[13].wrapping_add(x[9]).rotate_left(13);
        x[5] ^= x[1].wrapping_add(x[13]).rotate_left(18);

        x[14] ^= x[10].wrapping_add(x[6]).rotate_left(7);
        x[2] ^= x[14].wrapping_add(x[10]).rotate_left(9);
        x[6] ^= x[2].wrapping_add(x[14]).rotate_left(13);
        x[10] ^= x[6].wrapping_add(x[2]).rotate_left(18);

        x[3] ^= x[15].wrapping_add(x[11]).rotate_left(7);
        x[7] ^= x[3].wrapping_add(x[15]).rotate_left(9);
        x[11] ^= x[7].wrapping_add(x[3]).rotate_left(13);
        x[15] ^= x[11].wrapping_add(x[7]).rotate_left(18);

        x[1] ^= x[0].wrapping_add(x[3]).rotate_left(7);
        x[2] ^= x[1].wrapping_add(x[0]).rotate_left(9);
        x[3] ^= x[2].wrapping_add(x[1]).rotate_left(13);
        x[0] ^= x[3].wrapping_add(x[2]).rotate_left(18);

        x[6] ^= x[5].wrapping_add(x[4]).rotate_left(7);
        x[7] ^= x[6].wrapping_add(x[5]).rotate_left(9);
        x[4] ^= x[7].wrapping_add(x[6]).rotate_left(13);
        x[5] ^= x[4].wrapping_add(x[7]).rotate_left(18);

        x[11] ^= x[10].wrapping_add(x[9]).rotate_left(7);
        x[8] ^= x[11].wrapping_add(x[10]).rotate_left(9);
        x[9] ^= x[8].wrapping_add(x[11]).rotate_left(13);
        x[10] ^= x[9].wrapping_add(x[8]).rotate_left(18);

        x[12] ^= x[15].wrapping_add(x[14]).rotate_left(7);
        x[13] ^= x[12].wrapping_add(x[15]).rotate_left(9);
        x[14] ^= x[13].wrapping_add(x[12]).rotate_left(13);
        x[15] ^= x[14].wrapping_add(x[13]).rotate_left(18);
    }
    for i in 0..16 {
        let val = x[i].wrapping_add(orig[i]).to_le_bytes();
        b[i * 4..i * 4 + 4].copy_from_slice(&val);
    }
}

fn scrypt_block_mix(b: &[u8], y: &mut [u8], r: usize) {
    let mut x = [0u8; 64];
    x.copy_from_slice(&b[(2 * r - 1) * 64..(2 * r) * 64]);
    for i in 0..(2 * r) {
        for j in 0..64 {
            x[j] ^= b[i * 64 + j];
        }
        salsa20_8(&mut x);
        let dest = if i % 2 == 0 {
            (i / 2) * 64
        } else {
            (r + i / 2) * 64
        };
        y[dest..dest + 64].copy_from_slice(&x);
    }
}

/// Derives the 32-byte NaCl SecretBox `dataKey` using rclone crypt's exact parameters:
/// `scrypt(password, salt, N=16384, r=8, p=1, keyLen=80)[0..32]`
fn derive_rclone_crypt_data_key(password: &str, password2_plain: &str) -> [u8; 32] {
    use hmac::Hmac;
    use pbkdf2::pbkdf2;
    use sha2::Sha256;

    let salt: &[u8] = if password2_plain.is_empty() {
        &RCLONE_DEFAULT_SALT
    } else {
        password2_plain.as_bytes()
    };

    let n: usize = 16384;
    let r: usize = 8;
    let block_size = 128 * r; // 1024 bytes

    let mut b = vec![0u8; block_size];
    let _ = pbkdf2::<Hmac<Sha256>>(password.as_bytes(), salt, 1, &mut b);

    let mut v = vec![0u8; n * block_size];
    let mut y = vec![0u8; block_size];

    for i in 0..n {
        v[i * block_size..(i + 1) * block_size].copy_from_slice(&b);
        scrypt_block_mix(&b, &mut y, r);
        b.copy_from_slice(&y);
    }

    for _ in 0..n {
        let idx_offset = (2 * r - 1) * 64;
        let j_val = u32::from_le_bytes([
            b[idx_offset],
            b[idx_offset + 1],
            b[idx_offset + 2],
            b[idx_offset + 3],
        ]) as usize;
        let j = j_val & (n - 1);
        for k in 0..block_size {
            b[k] ^= v[j * block_size + k];
        }
        scrypt_block_mix(&b, &mut y, r);
        b.copy_from_slice(&y);
    }

    let mut dk = [0u8; 80];
    let _ = pbkdf2::<Hmac<Sha256>>(password.as_bytes(), &b, 1, &mut dk);

    let mut data_key = [0u8; 32];
    data_key.copy_from_slice(&dk[0..32]);
    data_key
}

/// Reveals an rclone obscured password using `rclone config show` or `rclone reveal`
async fn reveal_rclone_obscured(app: &AppHandle, obscured: &str) -> Result<String, String> {
    if obscured.trim().is_empty() {
        return Ok(String::new());
    }
    let rclone = rclone_binary(app);
    let mut cmd = tokio_command(&rclone);
    cmd.args(["reveal", obscured.trim()]);
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone reveal: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("rclone reveal failed: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CloudflareStreamLinkResult {
    pub stream_url: String,
    pub is_crypt: bool,
    pub underlying_remote: String,
    pub encrypted_path: String,
    pub expires_at: u64,
}

#[tauri::command]
pub async fn generate_cloudflare_stream_link(
    app: AppHandle,
    config_path: String,
    remote_name: String,
    file_path: String,
    worker_base_url: String,
    worker_master_key_hex: String,
    cleartext_size: Option<u64>,
    ttl_hours: Option<u64>,
) -> Result<CloudflareStreamLinkResult, String> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    let clean_remote = remote_name.trim_end_matches(':').to_string();
    let clean_path = file_path.trim_start_matches('/').to_string();
    let rclone = rclone_binary(&app);
    let cfg_opt = crate::commands::rclone_sync::resolve_config_arg(&config_path);

    // 1. Inspect rclone config dump to determine if remote is type="crypt"
    let mut dump_cmd = tokio_command(&rclone);
    dump_cmd.arg("config").arg("dump");
    if let Some(ref cfg) = cfg_opt {
        dump_cmd.args(["--config", cfg]);
    }
    let dump_out = dump_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to dump rclone config: {}", e))?;
    if !dump_out.status.success() {
        return Err(format!(
            "rclone config dump failed: {}",
            String::from_utf8_lossy(&dump_out.stderr)
        ));
    }

    let dump_json: serde_json::Value = serde_json::from_slice(&dump_out.stdout)
        .map_err(|e| format!("Invalid JSON from rclone config dump: {}", e))?;

    let remote_cfg = dump_json
        .get(&clean_remote)
        .ok_or_else(|| format!("Remote '{}' not found in rclone config", clean_remote))?;

    let remote_type = remote_cfg
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let mut is_crypt = false;
    let mut data_key_hex: Option<String> = None;
    let mut target_remote_spec = format!("{}:{}", clean_remote, clean_path);
    let mut encrypted_rel_path = clean_path.clone();

    if remote_type == "crypt" {
        is_crypt = true;
        let underlying_spec = remote_cfg
            .get("remote")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Crypt remote '{}' is missing 'remote' target", clean_remote))?;

        let obscured_pw = remote_cfg
            .get("password")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("Crypt remote '{}' is missing 'password'", clean_remote))?;
        let obscured_pw2 = remote_cfg
            .get("password2")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let plain_pw = reveal_rclone_obscured(&app, obscured_pw).await?;
        let plain_pw2 = reveal_rclone_obscured(&app, obscured_pw2).await?;

        let data_key = derive_rclone_crypt_data_key(&plain_pw, &plain_pw2);
        data_key_hex = Some(
            data_key
                .iter()
                .map(|b| format!("{:02x}", b))
                .collect::<String>(),
        );

        // Translate cleartext relative path -> encrypted path via `rclone backend encode`
        let mut enc_cmd = tokio_command(&rclone);
        enc_cmd.args(["backend", "encode", &format!("{}:", clean_remote), &clean_path]);
        if let Some(ref cfg) = cfg_opt {
            enc_cmd.args(["--config", cfg]);
        }
        let enc_out = enc_cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run rclone backend encode: {}", e))?;
        if !enc_out.status.success() {
            return Err(format!(
                "rclone backend encode failed: {}",
                String::from_utf8_lossy(&enc_out.stderr)
            ));
        }
        encrypted_rel_path = String::from_utf8_lossy(&enc_out.stdout).trim().to_string();

        let base = underlying_spec.trim_end_matches('/');
        target_remote_spec = if base.ends_with(':') {
            format!("{}{}", base, encrypted_rel_path)
        } else {
            format!("{}/{}", base, encrypted_rel_path)
        };
    }

    // 2. Obtain direct link from the underlying remote (or construct WebDAV URL if underlying is webdav)
    let underlying_remote_name = target_remote_spec
        .split(':')
        .next()
        .unwrap_or(&clean_remote)
        .to_string();
    let underlying_cfg = dump_json.get(&underlying_remote_name);
    let underlying_type = underlying_cfg
        .and_then(|c| c.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let origin_url: String;
    let mut origin_headers: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    if underlying_type == "webdav" {
        let base_url = underlying_cfg
            .and_then(|c| c.get("url"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| "WebDAV remote is missing 'url'".to_string())?
            .trim_end_matches('/');
        let rel_part = target_remote_spec
            .split_once(':')
            .map(|(_, p)| p.trim_start_matches('/'))
            .unwrap_or("");
        origin_url = format!("{}/{}", base_url, rel_part);

        if let Some(user) = underlying_cfg
            .and_then(|c| c.get("user"))
            .and_then(|v| v.as_str())
        {
            if !user.is_empty() {
                let obs_pass = underlying_cfg
                    .and_then(|c| c.get("pass"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let plain_pass = reveal_rclone_obscured(&app, obs_pass).await.unwrap_or_default();
                let basic = base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", user, plain_pass));
                origin_headers.insert("Authorization".to_string(), format!("Basic {}", basic));
            }
        }
    } else {
        let mut link_cmd = tokio_command(&rclone);
        link_cmd.args(["link", &target_remote_spec]);
        if let Some(ref cfg) = cfg_opt {
            link_cmd.args(["--config", cfg]);
        }
        let link_out = link_cmd
            .output()
            .await
            .map_err(|e| format!("Failed to run rclone link: {}", e))?;
        if !link_out.status.success() {
            return Err(format!(
                "rclone link failed for '{}': {}",
                target_remote_spec,
                String::from_utf8_lossy(&link_out.stderr).trim()
            ));
        }
        origin_url = String::from_utf8_lossy(&link_out.stdout).trim().to_string();
    }

    // 3. Seal payload with AES-256-GCM using worker_master_key_hex
    let clean_hex = worker_master_key_hex.trim();
    if clean_hex.len() != 64 {
        return Err("Worker Master Key must be a 64-character hex string (32 bytes)".into());
    }
    let mut master_key = [0u8; 32];
    for i in 0..32 {
        master_key[i] = u8::from_str_radix(&clean_hex[i * 2..i * 2 + 2], 16)
            .map_err(|_| "Worker Master Key contains invalid hex characters".to_string())?;
    }

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let exp = now_secs + ttl_hours.unwrap_or(168) * 3600; // Default 7 days (168h)

    let filename = clean_path
        .rsplit('/')
        .next()
        .unwrap_or("stream.mp4")
        .to_string();
    let mime_type = if filename.to_lowercase().ends_with(".mkv") {
        "video/x-matroska"
    } else if filename.to_lowercase().ends_with(".webm") {
        "video/webm"
    } else {
        "video/mp4"
    };

    let payload_json = serde_json::json!({
        "originUrl": origin_url,
        "originHeaders": origin_headers,
        "isCrypt": is_crypt,
        "dataKeyHex": data_key_hex,
        "cleartextSize": cleartext_size,
        "mimeType": mime_type,
        "filename": filename,
        "exp": exp,
    });
    let payload_bytes = serde_json::to_vec(&payload_json).map_err(|e| e.to_string())?;

    // Derive deterministic-unique 12-byte IV from SHA-256(master_key || now_nanos || path)
    use sha2::Digest;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = sha2::Sha256::new();
    hasher.update(&master_key);
    hasher.update(nanos.to_le_bytes());
    hasher.update(clean_path.as_bytes());
    let hash = hasher.finalize();
    let iv_bytes: [u8; 12] = hash[0..12].try_into().unwrap();

    let cipher = Aes256Gcm::new((&master_key).into());
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&iv_bytes), payload_bytes.as_ref())
        .map_err(|e| format!("AES-GCM token encryption failed: {}", e))?;

    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&iv_bytes);
    combined.extend_from_slice(&ciphertext);
    let token = URL_SAFE_NO_PAD.encode(&combined);

    let encoded_name = percent_encoding::utf8_percent_encode(&filename, percent_encoding::NON_ALPHANUMERIC);
    let base_worker = worker_base_url.trim_end_matches('/');
    let stream_url = format!("{}/stream/{}?token={}", base_worker, encoded_name, token);

    Ok(CloudflareStreamLinkResult {
        stream_url,
        is_crypt,
        underlying_remote: underlying_remote_name,
        encrypted_path: encrypted_rel_path,
        expires_at: exp,
    })
}

#[tauri::command]
pub async fn get_rclone_link(
    app: AppHandle,
    config_path: String,
    remote_name: String,
    file_path: String,
) -> Result<String, String> {
    let clean_remote = remote_name.trim_end_matches(':');
    let clean_path = file_path.trim_start_matches('/');
    let target = format!("{}:{}", clean_remote, clean_path);

    let rclone = rclone_binary(&app);
    let cfg_opt = crate::commands::rclone_sync::resolve_config_arg(&config_path);

    let mut link_cmd = tokio_command(&rclone);
    link_cmd.args(["link", &target]);
    if let Some(ref cfg) = cfg_opt {
        link_cmd.args(["--config", cfg]);
    }

    let out = link_cmd
        .output()
        .await
        .map_err(|e| format!("Failed to execute rclone link: {}", e))?;

    if !out.status.success() {
        let err_msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err_msg.is_empty() {
            format!("Remote '{}' does not support public sharing links", clean_remote)
        } else {
            err_msg
        });
    }

    let link = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if link.is_empty() {
        return Err(format!("Remote '{}' returned an empty share link", clean_remote));
    }
    Ok(link)
}

fn mounts_root_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Could not determine user home directory".to_string())?;
    Ok(home.join("RcloneFlixMounts"))
}

/// Remote names come from the frontend over IPC: reject anything that could escape the mounts root.
fn validate_remote_name(name: &str) -> Result<String, String> {
    let clean = name.trim().trim_end_matches(':').to_string();
    if clean.is_empty()
        || clean.contains('/')
        || clean.contains('\\')
        || clean.contains("..")
        || clean.contains(':')
    {
        return Err(format!("Invalid remote name '{}'.", name));
    }
    Ok(clean)
}

#[derive(Debug, Serialize, Clone)]
pub struct MountedRemote {
    pub name: String,
    pub mount_point: String,
    /// true when the mount lives under ~/RcloneFlixMounts (created by this app, so it may unmount it).
    pub managed: bool,
}

#[cfg(target_os = "linux")]
fn read_rclone_mounts() -> Vec<MountedRemote> {
    let root = mounts_root_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut out: Vec<MountedRemote> = Vec::new();
    let Ok(mounts) = std::fs::read_to_string("/proc/mounts") else {
        return out;
    };
    for line in mounts.lines() {
        let mut parts = line.split_whitespace();
        let (Some(device), Some(mount_point), Some(fs_type)) =
            (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let mount_point = mount_point.replace("\\040", " "); // /proc/mounts escapes spaces
        let managed = !root.is_empty() && mount_point.starts_with(&root);
        if !(fs_type == "fuse.rclone" || (fs_type.starts_with("fuse") && managed)) {
            continue;
        }
        let name = device.split(':').next().unwrap_or("").to_string();
        if name.is_empty() || out.iter().any(|m| m.mount_point == mount_point) {
            continue;
        }
        out.push(MountedRemote { name, mount_point, managed });
    }
    out
}

/// Lists active rclone FUSE mounts: those the app created (`managed: true`) and external ones
/// (`managed: false`). The UI shows external mounts as "Mounted (external)" with no Unmount button.
#[tauri::command]
pub fn list_mounted_remotes() -> Result<Vec<MountedRemote>, String> {
    #[cfg(target_os = "linux")]
    {
        return Ok(read_rclone_mounts());
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn mount_remote(
    app: AppHandle,
    config_path: String,
    remote_name: String,
) -> Result<String, String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, config_path, remote_name);
        return Err("FUSE remote mounting from Cloud Explorer is currently supported on Linux desktop.".to_string());
    }
    #[cfg(target_os = "linux")]
    {
        if std::env::var("FLATPAK_ID").is_ok() {
            return Err("FUSE mounts cannot be spawned from inside the Flatpak sandbox. Use the .deb build or host systemd mount.".to_string());
        }
        let clean_remote = validate_remote_name(&remote_name)?;
        let mount_dir = mounts_root_dir()?.join(&clean_remote);

        if let Some(m) = read_rclone_mounts()
            .into_iter()
            .find(|m| !m.managed && m.name.eq_ignore_ascii_case(&clean_remote))
        {
            return Err(format!("'{}' is already mounted at {}.", clean_remote, m.mount_point));
        }

        // Clear any stale/dead FUSE mount FIRST: create_dir_all fails with
        // "Transport endpoint is not connected" on a dead mount point.
        let _ = std::process::Command::new("fusermount3")
            .args(["-u", "-z", &mount_dir.to_string_lossy()])
            .output()
            .or_else(|_| {
                std::process::Command::new("fusermount")
                    .args(["-u", "-z", &mount_dir.to_string_lossy()])
                    .output()
            });
        std::fs::create_dir_all(&mount_dir)
            .map_err(|e| format!("Failed creating mount directory: {}", e))?;

        let (has_union, has_shared) = inspect_remote_chain(&config_path, &clean_remote)?;
        if has_union {
            return Err(
                "FUSE mounting 'union' remotes (or remotes wrapping a union) is disabled to prevent unmount hangs. Browse this pool in Cloud Explorer instead."
                    .to_string(),
            );
        }

        let rclone = crate::commands::player::rclone_binary(&app);
        let cfg_opt = crate::commands::rclone_sync::resolve_config_arg(&config_path);
        let rc_user = "rcloneflix_vfs".to_string();
        let rc_pass = generate_random_hex_secret();

        let mut last_err = String::new();
        let mut bound_port: u16 = 0;

        for _attempt in 0..2 {
            let candidate_port = portpicker::pick_unused_port().unwrap_or(0);
            let mut cmd = std::process::Command::new(&rclone);
            if let Some(ref cfg) = cfg_opt {
                cmd.args(["--config", cfg]);
            }
            cmd.args([
                "mount",
                &format!("{}:", clean_remote),
                &mount_dir.to_string_lossy(),
                "--vfs-cache-mode",
                "full",
                "--vfs-cache-max-size",
                "10G",
                "--vfs-cache-max-age",
                "24h",
                "--dir-cache-time",
                "5m",
                "--poll-interval",
                "15s",
                "--umask",
                "002",
                "--daemon",
            ]);

            if candidate_port > 0 {
                cmd.args([
                    "--rc",
                    "--rc-addr",
                    &format!("127.0.0.1:{}", candidate_port),
                ]);
                cmd.env("RCLONE_RC_USER", &rc_user)
                    .env("RCLONE_RC_PASS", &rc_pass);
            }

            if clean_remote.starts_with("shared_") || has_shared {
                cmd.arg("--read-only");
            }

            let out = cmd.output().map_err(|e| format!("Failed to launch rclone mount: {}", e))?;
            if out.status.success() {
                bound_port = candidate_port;
                last_err.clear();
                break;
            }
            last_err = String::from_utf8_lossy(&out.stderr).to_string();
        }

        if !last_err.is_empty() {
            return Err(format!("rclone mount failed: {}", last_err));
        }

        if bound_port > 0 {
            save_mount_rc_entry(&app, &clean_remote, bound_port, &rc_user, &rc_pass);
        }

        Ok(mount_dir.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub fn unmount_remote(app: AppHandle, remote_name: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    let _ = (&app, &remote_name);
    #[cfg(target_os = "linux")]
    {
        let clean_remote = validate_remote_name(&remote_name)?;
        let Some(m) = read_rclone_mounts()
            .into_iter()
            .find(|m| m.name.eq_ignore_ascii_case(&clean_remote) && m.managed)
        else {
            remove_mount_rc_entry(&app, &clean_remote);
            if let Some(ext) = read_rclone_mounts()
                .into_iter()
                .find(|m| m.name.eq_ignore_ascii_case(&clean_remote))
            {
                return Err(format!(
                    "'{}' is mounted at {}, outside RcloneFlix. Unmount it where it was created (e.g. its systemd unit or `fusermount3 -u {}`).",
                    clean_remote, ext.mount_point, ext.mount_point
                ));
            }
            return Ok(());
        };
        let status = std::process::Command::new("fusermount3")
            .args(["-u", "-z", &m.mount_point])
            .status()
            .or_else(|_| {
                std::process::Command::new("fusermount")
                    .args(["-u", "-z", &m.mount_point])
                    .status()
            })
            .map_err(|e| format!("Failed running fusermount: {}", e))?;
        if !status.success() {
            return Err(format!("Could not unmount {}", m.mount_point));
        }
        remove_mount_rc_entry(&app, &clean_remote);
    }
    Ok(())
}

// ─── Native Rclone Suite Extensions ──────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
struct MountRcEntry {
    port: u16,
    user: String,
    pass: String,
}

static MOUNT_RC_FILE_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();

fn mount_rc_mutex() -> &'static std::sync::Mutex<()> {
    MOUNT_RC_FILE_LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn generate_random_hex_secret() -> String {
    use aes_gcm::aead::{rand_core::RngCore, OsRng};
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

fn mount_rc_registry_file_path(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("rcloneflix"));
    let _ = std::fs::create_dir_all(&base);
    base.join("mount_rc_registry.json")
}

fn load_mount_rc_map_unlocked(path: &Path) -> std::collections::HashMap<String, MountRcEntry> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return std::collections::HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_mount_rc_map_unlocked(
    path: &Path,
    map: &std::collections::HashMap<String, MountRcEntry>,
) {
    use std::io::Write;
    let Ok(json) = serde_json::to_string(map) else {
        return;
    };
    let tmp_path = path.with_extension("json.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut file) = opts.open(&tmp_path) {
        if file.write_all(json.as_bytes()).is_ok() && file.sync_all().is_ok() {
            let _ = std::fs::rename(&tmp_path, path);
        }
    }
}

fn save_mount_rc_entry(app: &AppHandle, remote_name: &str, port: u16, user: &str, pass: &str) {
    let Ok(_guard) = mount_rc_mutex().lock() else {
        return;
    };
    let path = mount_rc_registry_file_path(app);
    let mut map = load_mount_rc_map_unlocked(&path);
    map.insert(
        remote_name.trim().trim_end_matches(':').to_lowercase(),
        MountRcEntry {
            port,
            user: user.to_string(),
            pass: pass.to_string(),
        },
    );
    write_mount_rc_map_unlocked(&path, &map);
}

fn remove_mount_rc_entry(app: &AppHandle, remote_name: &str) {
    let Ok(_guard) = mount_rc_mutex().lock() else {
        return;
    };
    let path = mount_rc_registry_file_path(app);
    let mut map = load_mount_rc_map_unlocked(&path);
    if map
        .remove(&remote_name.trim().trim_end_matches(':').to_lowercase())
        .is_some()
    {
        write_mount_rc_map_unlocked(&path, &map);
    }
}

fn parse_vfs_refresh_target(remote_or_path: &str) -> Option<(String, Option<String>)> {
    let (remote_prefix, rel) = remote_or_path.split_once(':')?;
    let clean_remote = remote_prefix.trim();
    if clean_remote.len() <= 1 || clean_remote.contains('/') || clean_remote.contains('\\') {
        return None;
    }
    let clean_rel = rel.trim_start_matches(['/', '\\']);
    let parent_dir = clean_rel
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .filter(|s| !s.is_empty());
    Some((clean_remote.to_string(), parent_dir))
}

pub(crate) fn spawn_best_effort_vfs_refresh(app: &AppHandle, remote_or_path: &str) {
    let Some((remote, parent_dir)) = parse_vfs_refresh_target(remote_or_path) else {
        return;
    };
    let app_clone = app.clone();
    tokio::spawn(async move {
        let _ = rclone_vfs_refresh(app_clone, remote, parent_dir).await;
    });
}

pub(crate) fn spawn_best_effort_vfs_refresh_pair(
    app: &AppHandle,
    first_path: &str,
    second_path: &str,
) {
    let t1 = parse_vfs_refresh_target(first_path);
    let t2 = parse_vfs_refresh_target(second_path);
    if let Some((r1, p1)) = t1.clone() {
        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = rclone_vfs_refresh(app_clone, r1, p1).await;
        });
    }
    if let Some((r2, p2)) = t2 {
        let same_as_first = t1
            .as_ref()
            .map(|(r1, p1)| r1.eq_ignore_ascii_case(&r2) && *p1 == p2)
            .unwrap_or(false);
        if !same_as_first {
            let app_clone = app.clone();
            tokio::spawn(async move {
                let _ = rclone_vfs_refresh(app_clone, r2, p2).await;
            });
        }
    }
}

fn inspect_remote_chain(config_path: &str, remote_or_path: &str) -> Result<(bool, bool), String> {
    let root_name = remote_or_path
        .trim()
        .split(':')
        .next()
        .unwrap_or("")
        .trim();
    if root_name.is_empty() {
        return Err("Remote name is empty.".into());
    }
    if root_name.to_lowercase().starts_with("shared_") {
        return Ok((false, true));
    }

    let resolved_cfg = crate::commands::rclone_sync::resolve_config_arg(config_path)
        .unwrap_or_else(|| config_path.to_string());
    let cfg_path = Path::new(&resolved_cfg);
    if !cfg_path.exists() {
        return Err(format!(
            "Cannot verify remote security policy: rclone config not found at '{}'.",
            resolved_cfg
        ));
    }
    let content = std::fs::read_to_string(cfg_path).map_err(|e| {
        format!(
            "Cannot verify remote security policy: failed reading rclone.conf ({}).",
            e
        )
    })?;
    if content.contains("RCLONE_ENCRYPT_V0:") {
        return Err(
            "Cannot verify remote security policy: encrypted rclone.conf is not supported for this operation."
                .into(),
        );
    }

    let mut sections: std::collections::HashMap<
        String,
        std::collections::HashMap<String, String>,
    > = std::collections::HashMap::new();
    let mut cur_sec: Option<String> = None;
    for line in content.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            let s = t[1..t.len() - 1].trim().to_lowercase();
            cur_sec = Some(s.clone());
            sections.entry(s).or_default();
        } else if let (Some(ref sec), Some((k, v))) = (&cur_sec, t.split_once('=')) {
            if let Some(map) = sections.get_mut(sec) {
                map.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }
    }

    let root_lower = root_name.to_lowercase();
    if !sections.contains_key(&root_lower) {
        return Err(format!(
            "Remote '{}' was not found in rclone.conf.",
            root_name
        ));
    }

    let mut has_union = false;
    let mut has_shared = false;
    let mut stack = vec![(root_lower, 0usize)];
    let mut visited = std::collections::HashSet::new();

    while let Some((cur, depth)) = stack.pop() {
        if depth > 8 {
            return Err("Remote wrapper chain exceeds maximum depth (8).".into());
        }
        if !visited.insert(cur.clone()) {
            continue;
        }
        if cur.starts_with("shared_") {
            has_shared = true;
        }
        let Some(props) = sections.get(&cur) else {
            continue;
        };
        if let Some(rtype) = props.get("type") {
            if rtype.eq_ignore_ascii_case("union") {
                has_union = true;
            }
        }
        if let Some(target) = props.get("remote") {
            let next = target
                .trim_matches('"')
                .split(':')
                .next()
                .unwrap_or("")
                .trim()
                .to_lowercase();
            if !next.is_empty() && next.len() > 1 {
                stack.push((next, depth + 1));
            }
        }
        if let Some(upstreams) = props.get("upstreams") {
            for token in upstreams.split_whitespace() {
                let cleaned = token.trim_matches('"');
                let candidate = cleaned.rsplit_once('=').map(|(_, r)| r).unwrap_or(cleaned);
                let next = candidate.split(':').next().unwrap_or("").trim().to_lowercase();
                if !next.is_empty() && next.len() > 1 {
                    stack.push((next, depth + 1));
                }
            }
        }
    }

    Ok((has_union, has_shared))
}

fn path_uses_shared_remote(config_path: &str, path: &str) -> Result<bool, String> {
    let trimmed = path.trim();
    if trimmed.to_lowercase().starts_with("shared_") {
        return Ok(true);
    }
    if let Some((prefix, _)) = trimmed.split_once(':') {
        let clean_prefix = prefix.trim();
        if clean_prefix.len() > 1
            && !clean_prefix.contains('/')
            && !clean_prefix.contains('\\')
        {
            let (_, shared) = inspect_remote_chain(config_path, clean_prefix)?;
            return Ok(shared);
        }
    }
    Ok(false)
}

fn validate_new_virtual_remote_name(config_path: &str, remote_name: &str) -> Result<String, String> {
    let clean = remote_name.trim();
    if clean.is_empty() || clean.to_lowercase().starts_with("shared_") {
        return Err("Remote name cannot be empty or start with 'shared_'.".into());
    }
    if !clean
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("Remote name may only contain letters, numbers, '_', and '-'.".into());
    }
    let existing = parse_rclone_config(config_path.to_string())?;
    if existing.iter().any(|r| r.name.eq_ignore_ascii_case(clean)) {
        return Err(format!(
            "A remote named '{}' already exists. Delete or rename it first.",
            clean
        ));
    }
    Ok(clean.to_string())
}

fn quote_rclone_upstream_token(token: &str) -> String {
    let escaped = token.replace('"', "\\\"");
    if escaped.chars().any(|c| c.is_whitespace()) {
        format!("\"{}\"", escaped)
    } else {
        escaped
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RcloneQuota {
    pub supported: bool,
    pub total: Option<u64>,
    pub used: Option<u64>,
    pub free: Option<u64>,
    pub trashed: Option<u64>,
}

/// 3.1 `rclone about <remote>: --json`
#[tauri::command]
pub async fn rclone_about(
    app: AppHandle,
    config_path: String,
    remote_name: String,
) -> Result<RcloneQuota, String> {
    let clean = remote_name.trim().trim_end_matches(':');
    if clean.is_empty() || clean.starts_with('-') {
        return Err("Valid remote name is required".into());
    }
    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.args(["about", &format!("{}:", clean), "--json"]);
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone about: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let lower = stderr.to_lowercase();
        if lower.contains("doesn't support about")
            || lower.contains("not supported")
            || lower.contains("about call is not supported")
        {
            return Ok(RcloneQuota {
                supported: false,
                total: None,
                used: None,
                free: None,
                trashed: None,
            });
        }
        return Err(format!("rclone about failed: {}", stderr.trim()));
    }
    let val: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    Ok(RcloneQuota {
        supported: true,
        total: val.get("total").and_then(|v| v.as_u64()),
        used: val.get("used").and_then(|v| v.as_u64()),
        free: val.get("free").and_then(|v| v.as_u64()),
        trashed: val.get("trashed").and_then(|v| v.as_u64()),
    })
}

/// 3.2a `rclone config create <name> union ...`
#[tauri::command]
pub async fn rclone_create_union_remote(
    app: AppHandle,
    config_path: String,
    remote_name: String,
    upstreams: Vec<String>,
    action_policy: String,
    create_policy: String,
) -> Result<Vec<RcloneRemote>, String> {
    let clean_name = validate_new_virtual_remote_name(&config_path, &remote_name)?;
    if upstreams.len() < 2 {
        return Err("A union remote requires at least 2 upstreams.".into());
    }
    const ALLOWED_ACTION: &[&str] = &["epall", "all", "epff"];
    const ALLOWED_CREATE: &[&str] = &["epmfs", "mfs", "lus", "epall"];
    if !ALLOWED_ACTION.contains(&action_policy.as_str()) {
        return Err(format!("Unsupported action_policy '{}'", action_policy));
    }
    if !ALLOWED_CREATE.contains(&create_policy.as_str()) {
        return Err(format!("Unsupported create_policy '{}'", create_policy));
    }

    let mut sanitized_upstreams = Vec::with_capacity(upstreams.len());
    for u in upstreams {
        let trimmed = u.trim().trim_matches('"');
        if trimmed.is_empty() {
            continue;
        }
        let check_target = if trimmed.contains(':') {
            trimmed.to_string()
        } else {
            format!("{}:", trimmed)
        };
        let is_shared = path_uses_shared_remote(&config_path, &check_target)?;
        let token = if is_shared && !trimmed.ends_with(":ro") {
            if trimmed.contains(':') {
                format!("{}:ro", trimmed)
            } else {
                format!("{}::ro", trimmed)
            }
        } else {
            check_target
        };
        sanitized_upstreams.push(quote_rclone_upstream_token(&token));
    }

    if sanitized_upstreams.len() < 2 {
        return Err("A union remote requires at least 2 non-empty upstreams.".into());
    }

    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "config",
        "create",
        &clean_name,
        "union",
        "upstreams",
        &sanitized_upstreams.join(" "),
        "action_policy",
        &action_policy,
        "create_policy",
        &create_policy,
        "--non-interactive",
    ]);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to create union remote: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "rclone config create union failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_rclone_config(config_path)
}

/// 3.2b `rclone config create <name> combine ...`
#[tauri::command]
pub async fn rclone_create_combine_remote(
    app: AppHandle,
    config_path: String,
    remote_name: String,
    upstreams: Vec<(String, String)>,
) -> Result<Vec<RcloneRemote>, String> {
    let clean_name = validate_new_virtual_remote_name(&config_path, &remote_name)?;
    if upstreams.is_empty() {
        return Err("At least one upstream mapping is required.".into());
    }
    let mut pairs = Vec::with_capacity(upstreams.len());
    for (alias, target) in upstreams {
        let a = alias.trim().trim_matches('"');
        let t = target.trim().trim_matches('"');
        if a.is_empty() || t.is_empty() {
            continue;
        }
        if a.contains('=') || a.contains('/') || a.contains('\\') {
            return Err(format!("Invalid combine folder alias '{}'", a));
        }
        let formatted_target = if t.contains(':') {
            t.to_string()
        } else {
            format!("{}:", t)
        };
        if path_uses_shared_remote(&config_path, &formatted_target)? {
            return Err("Guest pass (shared_) remotes cannot be added to a combine remote.".into());
        }
        pairs.push(quote_rclone_upstream_token(&format!("{}={}", a, formatted_target)));
    }

    if pairs.is_empty() {
        return Err("At least one valid upstream mapping is required.".into());
    }

    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "config",
        "create",
        &clean_name,
        "combine",
        "upstreams",
        &pairs.join(" "),
        "--non-interactive",
    ]);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to create combine remote: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "rclone config create combine failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse_rclone_config(config_path)
}

/// 3.3 `rclone_vfs_refresh` targeting the persisted per-mount `--rc` endpoint (2s fast timeout).
#[tauri::command]
pub async fn rclone_vfs_refresh(
    app: AppHandle,
    remote_name: String,
    dir_path: Option<String>,
) -> Result<bool, String> {
    let key = remote_name.trim().trim_end_matches(':').to_lowercase();

    #[cfg(target_os = "linux")]
    {
        let is_mounted = read_rclone_mounts()
            .into_iter()
            .any(|m| m.managed && m.name.eq_ignore_ascii_case(&key));
        if !is_mounted {
            remove_mount_rc_entry(&app, &key);
            return Ok(false);
        }
    }

    let entry_opt = {
        let Ok(_guard) = mount_rc_mutex().lock() else {
            return Ok(false);
        };
        let path = mount_rc_registry_file_path(&app);
        load_mount_rc_map_unlocked(&path).get(&key).cloned()
    };
    let Some(entry) = entry_opt else {
        return Ok(false);
    };
    let mut body = serde_json::json!({ "recursive": "false" });
    if let Some(d) = dir_path.filter(|s| !s.trim().is_empty()) {
        body["dir"] = serde_json::Value::String(d);
    }
    let client = reqwest::Client::new();
    let res = client
        .post(format!("http://127.0.0.1:{}/vfs/refresh", entry.port))
        .basic_auth(&entry.user, Some(&entry.pass))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .map_err(|e| format!("VFS refresh error: {}", e))?;
    Ok(res.status().is_success())
}

/// 3.4 `rclone bisync` checking both paths for `shared_` and leading `-`
#[tauri::command]
pub async fn rclone_bisync(
    app: AppHandle,
    config_path: String,
    local_dir: String,
    remote_dir: String,
    resync: bool,
    dry_run: bool,
    conflict_resolve: String,
) -> Result<String, String> {
    let p1 = local_dir.trim();
    let p2 = remote_dir.trim();
    if p1.is_empty() || p2.is_empty() || p1.starts_with('-') || p2.starts_with('-') {
        return Err("Invalid bisync path arguments.".into());
    }
    if path_uses_shared_remote(&config_path, p1)? || path_uses_shared_remote(&config_path, p2)? {
        return Err("Permission denied: bisync is forbidden on shared access pass remotes.".into());
    }
    const ALLOWED_CONFLICT: &[&str] = &["none", "newer", "older", "larger", "smaller", "path1", "path2"];
    if !ALLOWED_CONFLICT.contains(&conflict_resolve.as_str()) {
        return Err(format!("Invalid conflict_resolve mode '{}'", conflict_resolve));
    }

    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    let mut cmd = tokio_command(&rclone);
    cmd.arg("bisync");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    if let Some(bw) = rclone_settings.clean_bw_limit() {
        cmd.args(["--bwlimit", &bw]);
    }
    cmd.args([
        p1,
        p2,
        "--conflict-resolve",
        &conflict_resolve,
        "--max-delete",
        "50",
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
    ]);
    if resync {
        cmd.arg("--resync");
    }
    if dry_run {
        cmd.arg("--dry-run");
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone bisync: {}", e))?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(format!("rclone bisync failed: {}", combined.trim()));
    }
    if !dry_run {
        spawn_best_effort_vfs_refresh_pair(&app, p1, p2);
    }
    Ok(combined.trim().to_string())
}

/// 3.5a `rclone dedupe`
#[tauri::command]
pub async fn rclone_dedupe(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    mode: String,
    by_hash: bool,
    dry_run: bool,
) -> Result<String, String> {
    let target = remote_path.trim();
    if target.is_empty() || target.starts_with('-') {
        return Err("Invalid remote_path for dedupe.".into());
    }
    if !dry_run && path_uses_shared_remote(&config_path, target)? {
        return Err("Permission denied: dedupe modifications are forbidden on shared access pass remotes.".into());
    }
    const ALLOWED_MODES: &[&str] = &["newest", "oldest", "largest", "smallest", "rename", "skip"];
    if !ALLOWED_MODES.contains(&mode.as_str()) {
        return Err(format!("Unsupported dedupe mode '{}'", mode));
    }

    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.args(["dedupe", "--dedupe-mode", &mode]);
    if by_hash {
        cmd.arg("--by-hash");
    }
    if dry_run {
        cmd.arg("--dry-run");
    }
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.arg(target);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone dedupe: {}", e))?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(format!("rclone dedupe failed: {}", combined.trim()));
    }
    if !dry_run {
        spawn_best_effort_vfs_refresh(&app, target);
    }
    Ok(combined.trim().to_string())
}

/// 3.5b `rclone hashsum` (metadata-only — never passes `--download`)
#[tauri::command]
pub async fn rclone_hashsum(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    hash_type: String,
) -> Result<String, String> {
    let target = remote_path.trim();
    if target.is_empty() || target.starts_with('-') {
        return Err("Invalid remote_path for hashsum.".into());
    }
    const ALLOWED_HASHES: &[&str] = &["md5", "sha1", "sha256", "quickxor", "crc32"];
    let clean_hash = hash_type.trim().to_lowercase();
    if !ALLOWED_HASHES.contains(&clean_hash.as_str()) {
        return Err(format!("Unsupported hash type '{}'", hash_type));
    }

    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.args(["hashsum", &clean_hash, target]);
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone hashsum: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "rclone hashsum failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// 3.7a `rclone cleanup <remote>:` (empties cloud provider's native trash)
#[tauri::command]
pub async fn rclone_cleanup(
    app: AppHandle,
    config_path: String,
    remote_name: String,
) -> Result<(), String> {
    let clean = remote_name.trim().trim_end_matches(':');
    if clean.is_empty() || clean.starts_with('-') {
        return Err("Invalid remote name.".into());
    }
    if path_uses_shared_remote(&config_path, &format!("{}:", clean))? {
        return Err("Permission denied: cleanup is forbidden on shared access pass remotes.".into());
    }
    let rclone = rclone_binary(&app);
    let mut cmd = tokio_command(&rclone);
    cmd.args(["cleanup", &format!("{}:", clean)]);
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone cleanup: {}", e))?;
    if !out.status.success() {
        return Err(format!(
            "rclone cleanup failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// 3.7b Purge RcloneFlix's soft-delete app trash folder (`<remote>:<trash_dir>`).
#[tauri::command]
pub async fn rclone_empty_app_trash(
    app: AppHandle,
    config_path: String,
    remote_name: String,
) -> Result<(), String> {
    let clean = remote_name.trim().trim_end_matches(':');
    if clean.is_empty() || clean.starts_with('-') {
        return Err("Invalid remote name.".into());
    }
    if path_uses_shared_remote(&config_path, &format!("{}:", clean))? {
        return Err("Permission denied: emptying trash is forbidden on shared access pass remotes.".into());
    }
    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let trash_dir = rclone_settings.clean_soft_delete_trash_dir().to_string();
    let trash_path = format!("{}:{}", clean, trash_dir);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    let mut cmd = tokio_command(&rclone);
    cmd.arg("purge");
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        cmd.args(["--config", &cfg]);
    }
    cmd.args([
        "--tpslimit",
        &tps_limit_str,
        "--tpslimit-burst",
        &tps_burst_str,
        &trash_path,
    ]);

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to run rclone purge on app trash: {}", e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let lower = stderr.to_lowercase();
        if lower.contains("directory not found")
            || lower.contains("object not found")
            || lower.contains("doesn't exist")
        {
            return Ok(());
        }
        return Err(format!("Failed to empty app trash: {}", stderr.trim()));
    }
    spawn_best_effort_vfs_refresh(&app, &trash_path);
    Ok(())
}

/// 3.7c Restore an item from `<remote>:<trash_dir>/<ts>/<rel_path>` back to `<remote>:<rel_path>`.
#[tauri::command]
pub async fn rclone_restore_from_app_trash(
    app: AppHandle,
    config_path: String,
    trash_item_path: String,
) -> Result<String, String> {
    if path_uses_shared_remote(&config_path, &trash_item_path)? {
        return Err("Permission denied on shared access pass remote.".into());
    }
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let trash_dir = rclone_settings.clean_soft_delete_trash_dir();

    let (remote_prefix, rel) = trash_item_path
        .split_once(':')
        .ok_or_else(|| "Invalid trash item path".to_string())?;
    let clean_rel = rel.trim_start_matches(['/', '\\']);
    let mut parts = clean_rel.splitn(3, '/');
    let first = parts.next().unwrap_or("");
    let _ts = parts.next().unwrap_or("");
    let orig_rel = parts.next().unwrap_or("");

    if (first != trash_dir && first != ".rcloneflix_trash") || orig_rel.is_empty() {
        return Err("Path is not inside a timestamped RcloneFlix trash folder.".into());
    }

    let restored_path = format!("{}:{}", remote_prefix.trim(), orig_rel);

    let rclone = rclone_binary(&app);
    let mut check_cmd = tokio_command(&rclone);
    check_cmd.args(["lsjson", "--stat", &restored_path]);
    if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
        check_cmd.args(["--config", &cfg]);
    }
    if let Ok(check_out) = check_cmd.output().await {
        if check_out.status.success() && !check_out.stdout.is_empty() {
            return Err(format!(
                "Cannot restore: '{}' already exists at the destination. Rename or move the existing item first.",
                restored_path
            ));
        }
    }

    rclone_rename_file(app, config_path, trash_item_path, restored_path.clone()).await?;
    Ok(restored_path)
}


