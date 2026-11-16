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
    if from_path.starts_with("shared_") || to_path.starts_with("shared_") {
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
        // Server-side ops across different providers fail hard inside rclone
        // (e.g. WebDAV "409 Conflict: destination node is not found") instead of
        // falling back — retry once as a streamed move.
        let mut retry = tokio_command(&rclone);
        retry.arg("moveto");
        if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
            retry.args(["--config", &cfg]);
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
    if to_path.starts_with("shared_") {
        return Err("Permission denied: write operations are forbidden on shared access pass remotes".into());
    }

    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

    let mut cmd = tokio_command(&rclone);
    cmd.arg("copyto");
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
        .map_err(|e| format!("Failed to run rclone copyto: {}", e))?;

    if !output.status.success() {
        // Server-side ops across different providers fail hard inside rclone
        // (e.g. WebDAV "409 Conflict: destination node is not found") instead of
        // falling back — retry once as a streamed copy.
        let mut retry = tokio_command(&rclone);
        retry.arg("copyto");
        if let Some(cfg) = crate::commands::rclone_sync::resolve_config_arg(&config_path) {
            retry.args(["--config", &cfg]);
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
    Ok(())
}

/// Delete a file or directory on an rclone remote (deletefile for files, purge for folders)
#[tauri::command]
pub async fn rclone_delete_item(
    app: AppHandle,
    config_path: String,
    remote_path: String,
    is_dir: bool,
) -> Result<(), String> {
    if remote_path.starts_with("shared_") {
        return Err("Permission denied: delete operations are forbidden on shared access pass remotes".into());
    }

    let rclone = rclone_binary(&app);
    let rclone_settings = crate::commands::store::get_rclone_settings_sync(&app);
    let tps_limit_str = rclone_settings.clean_tps_limit().to_string();
    let tps_burst_str = rclone_settings.clean_tps_limit_burst().to_string();

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


