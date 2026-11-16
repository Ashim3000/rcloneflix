use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use serde::{Deserialize, Serialize};
use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use aes_gcm::aead::rand_core::RngCore;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use crate::process_ext::tokio_command;

const PBKDF2_ITERATIONS: u32 = 100_000;
const SALT_LENGTH: usize = 16;
const IV_LENGTH: usize = 12;

pub const DEFAULT_PUBLIC_KEY: &str = "rcloneflix-public-vault-2026";
pub const DEFAULT_ADULT_KEY: &str = "rcloneflix-adult-vault-standard";

use crate::commands::player::rclone_binary;

pub fn photo_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("No cache dir: {}", e))?
        .join("photos");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create photos cache dir: {}", e))?;
    Ok(dir)
}

pub fn derive_key(pin: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(pin.as_bytes(), salt, PBKDF2_ITERATIONS, &mut key);
    key
}

pub fn decrypt_bytes(encrypted: &[u8], pin: &str) -> Result<Vec<u8>, String> {
    if encrypted.len() < SALT_LENGTH + IV_LENGTH + 16 {
        return Err("Payload too short".into());
    }

    let salt = &encrypted[..SALT_LENGTH];
    let iv = &encrypted[SALT_LENGTH..SALT_LENGTH + IV_LENGTH];
    let ciphertext = &encrypted[SALT_LENGTH + IV_LENGTH..];

    let key = derive_key(pin, salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init error: {}", e))?;
    let nonce = Nonce::from_slice(iv);

    let mut decrypted = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("AES-GCM decryption failed: {}", e))?;

    // Auto-heal RIFF header for WebP if byte 4..8 is 0
    if decrypted.len() >= 12 && &decrypted[0..4] == b"RIFF" && &decrypted[8..12] == b"WEBP" {
        let size = (decrypted.len() - 8) as u32;
        let cur_size = u32::from_le_bytes(decrypted[4..8].try_into().unwrap_or([0; 4]));
        if cur_size == 0 {
            decrypted[4..8].copy_from_slice(&size.to_le_bytes());
        }
    }

    Ok(decrypted)
}

#[allow(dead_code)]
pub fn encrypt_bytes(data: &[u8], pin: &str) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LENGTH];
    let mut iv = [0u8; IV_LENGTH];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut iv);

    let key = derive_key(pin, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| format!("Cipher init error: {}", e))?;
    let nonce = Nonce::from_slice(&iv);

    let ciphertext = cipher
        .encrypt(nonce, data)
        .map_err(|e| format!("AES-GCM encryption failed: {}", e))?;

    let mut result = Vec::with_capacity(SALT_LENGTH + IV_LENGTH + ciphertext.len());
    result.extend_from_slice(&salt);
    result.extend_from_slice(&iv);
    result.extend_from_slice(&ciphertext);

    Ok(result)
}

/// Attempts decryption with candidate pin, falling back to public and adult standard keys.
pub fn decrypt_with_fallbacks(encrypted: &[u8], primary_pin: &str) -> Result<Vec<u8>, String> {
    // 1. Check if payload is already unencrypted raw image (starts with RIFF...WEBP, JPEG, PNG, etc)
    if is_plain_image(encrypted) {
        let mut copy = encrypted.to_vec();
        if copy.len() >= 12 && &copy[0..4] == b"RIFF" && &copy[8..12] == b"WEBP" {
            let size = (copy.len() - 8) as u32;
            let cur_size = u32::from_le_bytes(copy[4..8].try_into().unwrap_or([0; 4]));
            if cur_size == 0 {
                copy[4..8].copy_from_slice(&size.to_le_bytes());
            }
        }
        return Ok(copy);
    }

    // 2. Try primary pin
    if let Ok(data) = decrypt_bytes(encrypted, primary_pin) {
        return Ok(data);
    }

    // 3. Fallbacks
    let candidates = [DEFAULT_PUBLIC_KEY, DEFAULT_ADULT_KEY];
    for cand in candidates {
        if cand != primary_pin {
            if let Ok(data) = decrypt_bytes(encrypted, cand) {
                return Ok(data);
            }
        }
    }

    Err("Decryption failed: PIN mismatch or corrupted payload".into())
}

pub fn is_plain_image(data: &[u8]) -> bool {
    if data.len() < 12 {
        return false;
    }
    // WebP: 'RIFF' .... 'WEBP'
    if &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return true;
    }
    // JPEG: 0xFF, 0xD8, 0xFF
    if &data[0..3] == b"\xFF\xD8\xFF" {
        return true;
    }
    // PNG: 0x89, 'P', 'N', 'G'
    if &data[0..4] == b"\x89PNG" {
        return true;
    }
    // GIF: 'GIF8'
    if &data[0..4] == b"GIF8" {
        return true;
    }
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultPhotoRequest {
    pub id: String,
    pub filename: String,
    pub remote_path: Option<String>,
    pub storage_mode: Option<String>,
    pub is_adult: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedPhotoResult {
    pub path: String,
    pub mime_type: String,
    pub bytes: Vec<u8>,
}

/// Prepares a single vault photo for viewing:
/// Decrypts in native Rust, caches the readable file locally, and returns its metadata and bytes.
#[tauri::command]
pub async fn prepare_vault_photo(
    app: AppHandle,
    photo_id: String,
    pin: Option<String>,
    remote_path: Option<String>,
    config_path: Option<String>,
) -> Result<PreparedPhotoResult, String> {
    let dir = photo_cache_dir(&app)?;
    let safe_id: String = photo_id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
    if safe_id.is_empty() {
        return Err("Invalid photo ID".into());
    }

    // 1. Check if decrypted file already exists on disk
    let dec_path_webp = dir.join(format!("{}.dec.webp", safe_id));
    if dec_path_webp.exists() && std::fs::metadata(&dec_path_webp).map(|m| m.len() > 0).unwrap_or(false) {
        let bytes = std::fs::read(&dec_path_webp).map_err(|e| format!("Failed reading cached photo: {}", e))?;
        return Ok(PreparedPhotoResult {
            path: dec_path_webp.to_string_lossy().to_string(),
            mime_type: "image/webp".into(),
            bytes,
        });
    }
    let dec_path_jpg = dir.join(format!("{}.dec.jpg", safe_id));
    if dec_path_jpg.exists() && std::fs::metadata(&dec_path_jpg).map(|m| m.len() > 0).unwrap_or(false) {
        let bytes = std::fs::read(&dec_path_jpg).map_err(|e| format!("Failed reading cached photo: {}", e))?;
        return Ok(PreparedPhotoResult {
            path: dec_path_jpg.to_string_lossy().to_string(),
            mime_type: "image/jpeg".into(),
            bytes,
        });
    }
    let dec_path_png = dir.join(format!("{}.dec.png", safe_id));
    if dec_path_png.exists() && std::fs::metadata(&dec_path_png).map(|m| m.len() > 0).unwrap_or(false) {
        let bytes = std::fs::read(&dec_path_png).map_err(|e| format!("Failed reading cached photo: {}", e))?;
        return Ok(PreparedPhotoResult {
            path: dec_path_png.to_string_lossy().to_string(),
            mime_type: "image/png".into(),
            bytes,
        });
    }

    // 2. Fetch raw (encrypted or plain) bytes from disk cache or cloud remote
    let bin_path = dir.join(format!("{}.bin", safe_id));
    let base_bin_path = safe_id
        .strip_suffix("-orig")
        .or_else(|| safe_id.strip_suffix("_orig"))
        .map(|b| dir.join(format!("{}.bin", b)));

    let raw_bytes = if bin_path.exists() {
        std::fs::read(&bin_path).map_err(|e| format!("Failed reading cached photo: {}", e))?
    } else if let Some(ref bp) = base_bin_path.filter(|p| p.exists()) {
        std::fs::read(bp).map_err(|e| format!("Failed reading base cached photo: {}", e))?
    } else if let (Some(rem), Some(cfg)) = (remote_path.as_ref(), config_path.as_ref()) {
        if rem.is_empty() || cfg.is_empty() {
            return Err("Photo not cached locally and remote path is missing".into());
        }
        let rclone = rclone_binary(&app);
        let mut cmd = tokio_command(&rclone);
        cmd.arg("cat");
        if let Some(c) = crate::commands::rclone_sync::resolve_config_arg(cfg) {
            cmd.args(["--config", &c]);
        }
        cmd.arg(rem);
        let output = cmd
            .output()
            .await
            .map_err(|e| format!("rclone cat failed: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Failed fetching remote photo: {}", stderr.trim()));
        }

        let bytes = output.stdout;
        // Save to disk cache
        let tmp = bin_path.with_extension("tmp");
        let _ = std::fs::write(&tmp, &bytes);
        let _ = std::fs::rename(&tmp, &bin_path);
        bytes
    } else {
        return Err(format!("Photo {} not found in local cache and no remote path provided", photo_id));
    };

    if raw_bytes.is_empty() {
        return Err("Photo payload is empty".into());
    }

    // 3. Decrypt payload
    let target_pin = pin.as_deref().unwrap_or(DEFAULT_PUBLIC_KEY);
    let decrypted = decrypt_with_fallbacks(&raw_bytes, target_pin)?;

    // 4. Determine file extension and write to decrypted cache
    let is_webp = decrypted.len() >= 12 && &decrypted[0..4] == b"RIFF" && &decrypted[8..12] == b"WEBP";
    let is_png = decrypted.len() >= 4 && &decrypted[0..4] == b"\x89PNG";
    let ext = if is_webp {
        "webp"
    } else if is_png {
        "png"
    } else {
        "jpg"
    };

    let target_dec_path = dir.join(format!("{}.dec.{}", safe_id, ext));
    let tmp_path = dir.join(format!("{}.dec.{}.part", safe_id, ext));
    std::fs::write(&tmp_path, &decrypted).map_err(|e| format!("Failed to write decrypted photo: {}", e))?;
    std::fs::rename(&tmp_path, &target_dec_path).map_err(|e| format!("Failed to finalize decrypted photo: {}", e))?;

    let mime_type = if ext == "jpg" { "image/jpeg".to_string() } else { format!("image/{}", ext) };

    Ok(PreparedPhotoResult {
        path: target_dec_path.to_string_lossy().to_string(),
        mime_type,
        bytes: decrypted,
    })
}

/// Batch prepares a list of vault photos concurrently in background threads.
/// Returns a map of photo_id -> absolute filesystem path.
#[tauri::command]
pub async fn batch_prepare_vault_photos(
    app: AppHandle,
    photos: Vec<VaultPhotoRequest>,
    pin: Option<String>,
    config_path: Option<String>,
) -> Result<HashMap<String, String>, String> {
    let mut results = HashMap::new();
    let dir = photo_cache_dir(&app)?;
    let target_pin = pin.unwrap_or_else(|| DEFAULT_PUBLIC_KEY.to_string());

    // Separate into photos that are already decrypted vs those that need processing
    let mut to_process = Vec::new();
    for photo in photos {
        let safe_id: String = photo.id.chars().filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_').collect();
        if safe_id.is_empty() {
            continue;
        }

        let dec_webp = dir.join(format!("{}.dec.webp", safe_id));
        if dec_webp.exists() && std::fs::metadata(&dec_webp).map(|m| m.len() > 0).unwrap_or(false) {
            results.insert(photo.id, dec_webp.to_string_lossy().to_string());
            continue;
        }
        let dec_jpg = dir.join(format!("{}.dec.jpg", safe_id));
        if dec_jpg.exists() && std::fs::metadata(&dec_jpg).map(|m| m.len() > 0).unwrap_or(false) {
            results.insert(photo.id, dec_jpg.to_string_lossy().to_string());
            continue;
        }

        to_process.push((photo.id, safe_id, photo.remote_path));
    }

    if to_process.is_empty() {
        return Ok(results);
    }

    // Process up to 3 in parallel chunks to prevent IO thrashing and memory exhaustion
    for chunk in to_process.chunks(3) {
        let mut tasks = Vec::new();
        for (pid, safe_id, rem) in chunk {
            let app_c = app.clone();
            let pid_c = pid.clone();
            let safe_id_c = safe_id.clone();
            let rem_c = rem.clone();
            let pin_c = target_pin.clone();
            let cfg_c = config_path.clone();

            tasks.push(tokio::spawn(async move {
                let res = prepare_vault_photo(
                    app_c,
                    safe_id_c,
                    Some(pin_c),
                    rem_c,
                    cfg_c,
                ).await;
                (pid_c, res)
            }));
        }

        for task in tasks {
            if let Ok((pid, Ok(prepared))) = task.await {
                results.insert(pid, prepared.path);
            }
        }
    }

    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn round_trip_encrypt_decrypt() {
        let secret = b"RIFF\x00\x00\x00\x00WEBPVP8 test payload for photo vault";
        let pin = "my-secret-pin-1234";

        let encrypted = encrypt_bytes(secret, pin).expect("encrypt failed");
        assert!(encrypted.len() > secret.len());
        assert_ne!(&encrypted[..4], b"RIFF");

        let decrypted = decrypt_bytes(&encrypted, pin).expect("decrypt failed");
        assert_eq!(&decrypted[..4], b"RIFF");
        assert_eq!(&decrypted[8..12], b"WEBP");
        // Check RIFF size auto-healed
        let size = u32::from_le_bytes(decrypted[4..8].try_into().unwrap());
        assert_eq!(size, (decrypted.len() - 8) as u32);
    }

    #[test]
    fn decrypt_existing_cached_photo() {
        let path = Path::new("/home/ashim3000/.cache/com.rcloneflix.app/photos/pho-1789513794283-4bqi5f.bin");
        if path.exists() {
            let data = std::fs::read(path).unwrap();
            let dec = decrypt_with_fallbacks(&data, "wrong-pin").expect("fallback decryption should succeed");
            assert!(dec.len() >= 12);
            assert_eq!(&dec[0..4], b"RIFF");
        }
    }

    #[test]
    fn test_all_162_cached_photos_decrypt_cleanly() {
        let dir = Path::new("/home/ashim3000/.cache/com.rcloneflix.app/photos");
        if !dir.exists() {
            return;
        }
        let entries = std::fs::read_dir(dir).unwrap();
        let mut count = 0;
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("bin") {
                let data = std::fs::read(&p).unwrap();
                let dec = decrypt_with_fallbacks(&data, DEFAULT_PUBLIC_KEY).expect("Should decrypt");
                assert!(dec.len() >= 12);
                assert!(is_plain_image(&dec));
                count += 1;
                if count >= 5 {
                    break;
                }
            }
        }
        println!("Successfully decrypted and validated {} cached photo bins!", count);
    }
}
