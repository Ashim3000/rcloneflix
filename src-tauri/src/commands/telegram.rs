use grammers_client::types::{Downloadable, InputMessage, LoginToken, Media, PasswordToken};
use grammers_client::{Client, Config, InitParams, SignInError};
use grammers_session::{PackedChat, PackedType, Session};
use grammers_tl_types as tl;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{Mutex, RwLock};

pub const DEFAULT_TG_API_ID: i32 = 2040;
pub const DEFAULT_TG_API_HASH: &str = "b18441a1ff607e10a989891a5462e627";
const CHUNK_SIZE: i32 = 524_288; // 512 KiB request chunk (aligned to Telegram CDN boundary)
const CDN_ALIGNMENT: u64 = 524_288; // 512 KiB Telegram CDN alignment boundary

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramFileEntry {
    #[serde(rename = "msgId")]
    pub msg_id: i32,
    #[serde(rename = "chatId")]
    pub chat_id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TelegramIndexManifest {
    pub pinned_msg_id: Option<i32>,
    pub entries: Vec<TelegramFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SavedTelegramCreds {
    pub api_id: i32,
    pub api_hash: String,
    pub bot_token: String,
    pub default_chat_id: String,
    pub auth_mode: String, // "bot" | "user"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramDriveFolder {
    pub id: i64,
    pub name: String,
    pub chat_id: String,
}

pub struct TelegramEngineState {
    pub client: Mutex<Option<Client>>,
    pub user_client: Mutex<Option<Client>>,
    pub session_path: PathBuf,
    pub user_session_path: PathBuf,
    pub index_path: PathBuf,
    pub creds_path: PathBuf,
    pub login_token: Mutex<Option<LoginToken>>,
    pub password_token: Mutex<Option<PasswordToken>>,
    pub peer_cache: RwLock<HashMap<String, PackedChat>>,
    pub media_cache: RwLock<HashMap<(String, i32), (Media, u64, String, String, std::time::Instant)>>,
    pub folders: RwLock<Vec<TelegramDriveFolder>>,
    pub index: RwLock<TelegramIndexManifest>,
}

static TG_ENGINE: OnceLock<Arc<TelegramEngineState>> = OnceLock::new();

pub fn get_engine() -> Arc<TelegramEngineState> {
    TG_ENGINE
        .get_or_init(|| {
            let base_dir = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir())
                .join(".local")
                .join("share")
                .join("com.rcloneflix.app");
            let _ = std::fs::create_dir_all(&base_dir);
            let session_path = base_dir.join("telegram_mtproto.session");
            let user_session_path = base_dir.join("telegram_user.session");
            let index_path = base_dir.join("telegram_index.json");
            let creds_path = base_dir.join("telegram_creds.json");

            let initial_index = std::fs::read_to_string(&index_path)
                .ok()
                .and_then(|s| serde_json::from_str::<TelegramIndexManifest>(&s).ok())
                .unwrap_or_default();

            let state = Arc::new(TelegramEngineState {
                client: Mutex::new(None),
                user_client: Mutex::new(None),
                session_path,
                user_session_path,
                index_path,
                creds_path,
                login_token: Mutex::new(None),
                password_token: Mutex::new(None),
                peer_cache: RwLock::new(HashMap::new()),
                media_cache: RwLock::new(HashMap::new()),
                folders: RwLock::new(Vec::new()),
                index: RwLock::new(initial_index),
            });
            import_telegram_drive_desktop_state(&state);
            state
        })
        .clone()
}

/// Automatically imports session auth keys, channel access hashes, folders, and file inventory
/// from the local `com.cameronamer.telegramdrive` desktop installation if present.
pub fn import_telegram_drive_desktop_state(state: &Arc<TelegramEngineState>) {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());

    let candidate_dirs = [
        home.join(".local/share/com.cameronamer.telegramdrive"),
        home.join(".local/share/com.caamer20.telegramdrive"),
        home.join(".local/share/telegram-drive"),
        home.join("AppData/Roaming/com.cameronamer.telegramdrive"),
        home.join("Library/Application Support/com.cameronamer.telegramdrive"),
    ];

    let Some(td_dir) = candidate_dirs.into_iter().find(|d| d.exists()) else {
        return;
    };

    // 1. Convert SQLite `telegram.session` (grammers 0.8) into `telegram_user.session` (grammers 0.7) + peer_cache
    let sqlite_sess_path = td_dir.join("telegram.session");
    let mut imported_peers: HashMap<String, PackedChat> = HashMap::new();
    if sqlite_sess_path.exists() {
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            &sqlite_sess_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            let home_dc: i32 = conn
                .query_row("SELECT dc_id FROM dc_home LIMIT 1", [], |r| r.get(0))
                .unwrap_or(1);

            let sess = Session::new();
            let mut has_auth = false;
            if let Ok(mut stmt) = conn.prepare("SELECT dc_id, ipv4, auth_key FROM dc_option") {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i32>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<Vec<u8>>>(2)?,
                    ))
                }) {
                    for row in rows.flatten() {
                        if let (dc_id, ipv4_str, Some(auth_vec)) = row {
                            if auth_vec.len() == 256 {
                                if let Ok(addr) = ipv4_str.parse::<std::net::SocketAddr>() {
                                    let mut auth = [0u8; 256];
                                    auth.copy_from_slice(&auth_vec);
                                    sess.insert_dc(dc_id, addr, auth);
                                    has_auth = true;
                                }
                            }
                        }
                    }
                }
            }

            if let Ok(mut stmt) =
                conn.prepare("SELECT peer_id, hash, subtype FROM peer_info")
            {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, Option<i64>>(2)?,
                    ))
                }) {
                    for (peer_id, hash_opt, subtype_opt) in rows.flatten() {
                        let subtype = subtype_opt.unwrap_or(0);
                        if (subtype & 1) != 0 && peer_id > 0 {
                            sess.set_user(peer_id, home_dc, false);
                            let packed = PackedChat {
                                ty: PackedType::User,
                                id: peer_id,
                                access_hash: hash_opt,
                            };
                            imported_peers.insert("me".to_string(), packed);
                            imported_peers.insert("saved".to_string(), packed);
                        } else if peer_id < -1_000_000_000_000 {
                            let bare_id = -peer_id - 1_000_000_000_000;
                            let ty = if (subtype & 8) != 0 {
                                PackedType::Broadcast
                            } else {
                                PackedType::Megagroup
                            };
                            let packed = PackedChat {
                                ty,
                                id: bare_id,
                                access_hash: hash_opt,
                            };
                            imported_peers.insert(format!("-100{bare_id}"), packed);
                            imported_peers.insert(bare_id.to_string(), packed);
                        }
                    }
                }
            }

            if has_auth {
                let _ = std::fs::File::create(&state.user_session_path);
                let _ = sess.save_to_file(&state.user_session_path);
            }
        }
    }

    // 2. Load folder definitions from `config.json` and `shares.db`
    let mut folder_map: HashMap<i64, String> = HashMap::new();
    let cfg_path = td_dir.join("config.json");
    if let Ok(cfg_str) = std::fs::read_to_string(&cfg_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&cfg_str) {
            if let Some(arr) = val.get("folders").and_then(|v| v.as_array()) {
                for item in arr {
                    if let (Some(id), Some(name)) = (
                        item.get("id").and_then(|v| v.as_i64()),
                        item.get("name").and_then(|v| v.as_str()),
                    ) {
                        let clean_name = name.trim().replace('/', "-");
                        if !clean_name.is_empty() {
                            folder_map.insert(id, clean_name);
                        }
                    }
                }
            }
        }
    }

    let shares_db_path = td_dir.join("shares.db");
    let mut imported_entries: Vec<TelegramFileEntry> = Vec::new();
    if shares_db_path.exists() {
        if let Ok(conn) = rusqlite::Connection::open_with_flags(
            &shares_db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            if let Ok(mut stmt) = conn.prepare("SELECT channel_id, name FROM folder_metadata") {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
                }) {
                    for (cid, name) in rows.flatten() {
                        let clean_name = name.trim().replace('/', "-");
                        if !clean_name.is_empty() {
                            folder_map.entry(cid).or_insert(clean_name);
                        }
                    }
                }
            }

            if let Ok(mut stmt) = conn.prepare(
                "SELECT folder_key, folder_id, message_id, file_name, file_size, mime_type, file_ext, updated_at
                 FROM file_inventory ORDER BY message_id DESC",
            ) {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, Option<i64>>(1)?,
                        r.get::<_, i32>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, Option<String>>(5)?,
                        r.get::<_, Option<String>>(6)?,
                        r.get::<_, Option<i64>>(7)?,
                    ))
                }) {
                    for (folder_key, folder_id_opt, msg_id, raw_name, file_size, mime_opt, ext_opt, updated_opt) in
                        rows.flatten()
                    {
                        if raw_name.starts_with("dir--") || file_size <= 0 {
                            continue;
                        }
                        let file_name = if raw_name.trim().is_empty() {
                            let ext = ext_opt.unwrap_or_else(|| "mp4".to_string());
                            format!("telegram_{msg_id}.{ext}")
                        } else {
                            raw_name.trim().replace('/', "_")
                        };

                        let (folder_name, chat_id) = if folder_key == "home" {
                            ("Saved Messages".to_string(), "me".to_string())
                        } else {
                            let cid = folder_id_opt
                                .or_else(|| folder_key.parse::<i64>().ok())
                                .unwrap_or(0);
                            let fname = folder_map
                                .get(&cid)
                                .cloned()
                                .unwrap_or_else(|| format!("Channel_{cid}"));
                            (fname, format!("-100{cid}"))
                        };

                        let mime = mime_opt
                            .filter(|m| !m.trim().is_empty())
                            .unwrap_or_else(|| {
                                mime_guess::from_path(&file_name)
                                    .first_or_octet_stream()
                                    .to_string()
                            });

                        imported_entries.push(TelegramFileEntry {
                            msg_id,
                            chat_id,
                            name: file_name.clone(),
                            path: format!("/{folder_name}/{file_name}"),
                            size: file_size as u64,
                            mime_type: mime,
                            updated_at: updated_opt.unwrap_or(0).max(0) as u64,
                        });
                    }
                }
            }
        }
    }

    if let Ok(mut pc) = state.peer_cache.try_write() {
        for (k, v) in imported_peers {
            pc.insert(k, v);
        }
    }

    if let Ok(mut fl) = state.folders.try_write() {
        let mut list: Vec<TelegramDriveFolder> = folder_map
            .into_iter()
            .map(|(id, name)| TelegramDriveFolder {
                id,
                name,
                chat_id: format!("-100{id}"),
            })
            .collect();
        list.push(TelegramDriveFolder {
            id: 0,
            name: "Saved Messages".to_string(),
            chat_id: "me".to_string(),
        });
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        *fl = list;
    }

    if !imported_entries.is_empty() {
        if let Ok(mut idx) = state.index.try_write() {
            for entry in imported_entries {
                if !idx
                    .entries
                    .iter()
                    .any(|e| e.chat_id == entry.chat_id && e.msg_id == entry.msg_id)
                {
                    idx.entries.push(entry);
                }
            }
        }
    }
}

impl TelegramEngineState {
    pub fn load_creds(&self) -> SavedTelegramCreds {
        std::fs::read_to_string(&self.creds_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| SavedTelegramCreds {
                api_id: DEFAULT_TG_API_ID,
                api_hash: DEFAULT_TG_API_HASH.to_string(),
                bot_token: String::new(),
                default_chat_id: String::new(),
                auth_mode: "bot".to_string(),
            })
    }

    pub fn save_creds(&self, creds: &SavedTelegramCreds) -> Result<(), String> {
        let json = serde_json::to_string_pretty(creds).map_err(|e| e.to_string())?;
        std::fs::write(&self.creds_path, json).map_err(|e| e.to_string())
    }

    pub async fn persist_index(&self) -> Result<(), String> {
        let guard = self.index.read().await;
        let json = serde_json::to_string_pretty(&*guard).map_err(|e| e.to_string())?;
        std::fs::write(&self.index_path, json).map_err(|e| e.to_string())
    }

    /// Connects the User MTProto client (imported from Telegram Drive desktop) if available,
    /// falling back to the configured Bot/User client.
    pub async fn get_or_connect_client(&self) -> Result<Client, String> {
        if self.user_session_path.exists() {
            let mut uguard = self.user_client.lock().await;
            if let Some(c) = uguard.as_ref() {
                return Ok(c.clone());
            }
            if let Ok(session) = Session::load_file(&self.user_session_path) {
                if let Ok(client) = Client::connect(Config {
                    session,
                    api_id: DEFAULT_TG_API_ID,
                    api_hash: DEFAULT_TG_API_HASH.to_string(),
                    params: InitParams {
                        flood_sleep_threshold: 60,
                        ..InitParams::default()
                    },
                })
                .await
                {
                    if client.is_authorized().await.unwrap_or(false) {
                        *uguard = Some(client.clone());
                        return Ok(client);
                    }
                }
            }
        }

        let mut guard = self.client.lock().await;
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }

        let creds = self.load_creds();
        let api_id = if creds.api_id > 0 { creds.api_id } else { DEFAULT_TG_API_ID };
        let api_hash = if !creds.api_hash.trim().is_empty() {
            creds.api_hash.trim().to_string()
        } else {
            DEFAULT_TG_API_HASH.to_string()
        };

        let session = Session::load_file_or_create(&self.session_path)
            .or_else(|_| {
                let _ = std::fs::remove_file(&self.session_path);
                Session::load_file_or_create(&self.session_path)
            })
            .map_err(|e| format!("Failed to open Telegram session: {e}"))?;

        let client = Client::connect(Config {
            session,
            api_id,
            api_hash,
            params: InitParams {
                flood_sleep_threshold: 60,
                ..InitParams::default()
            },
        })
        .await
        .map_err(|e| format!("Telegram MTProto connect failed: {e}"))?;

        if !client.is_authorized().await.unwrap_or(false) && !creds.bot_token.trim().is_empty() {
            client
                .bot_sign_in(creds.bot_token.trim())
                .await
                .map_err(|e| format!("Telegram bot_sign_in failed: {e}"))?;
            let _ = client.session().save_to_file(&self.session_path);
        }

        *guard = Some(client.clone());
        Ok(client)
    }

    pub async fn reset_client(&self) {
        *self.user_client.lock().await = None;
        *self.client.lock().await = None;
    }
}

/// Converts a Bot-API style chat ID ("-1001234567890" or "1234567890" or "me") into a valid `PackedChat`
/// with a real `access_hash` fetched from Telegram.
pub async fn resolve_packed_chat(client: &Client, chat_id_str: &str) -> Result<PackedChat, String> {
    let engine = get_engine();
    let trimmed = chat_id_str.trim();
    let target = if trimmed.is_empty() {
        engine.load_creds().default_chat_id
    } else {
        trimmed.to_string()
    };
    let target = target.trim();

    if let Some(cached) = engine.peer_cache.read().await.get(target).copied() {
        return Ok(cached);
    }

    if target.eq_ignore_ascii_case("me") || target.eq_ignore_ascii_case("saved") {
        let me = client.get_me().await.map_err(|e| e.to_string())?;
        let packed = me.pack();
        engine.peer_cache.write().await.insert(target.to_string(), packed);
        return Ok(packed);
    }

    if let Some(username) = target.strip_prefix('@') {
        if let Some(chat) = client.resolve_username(username).await.map_err(|e| e.to_string())? {
            let packed = chat.pack();
            engine.peer_cache.write().await.insert(target.to_string(), packed);
            return Ok(packed);
        }
    }

    let bare_id: i64 = if let Some(stripped) = target.strip_prefix("-100") {
        stripped.parse::<i64>().map_err(|_| format!("Invalid channel ID: {target}"))?
    } else {
        target
            .trim_start_matches('-')
            .parse::<i64>()
            .map_err(|_| format!("Invalid chat ID: {target}"))?
    };

    // 1. Try channels.getChannels with access_hash=0 (works for Bots & Users in channels/supergroups)
    let req = tl::functions::channels::GetChannels {
        id: vec![tl::types::InputChannel {
            channel_id: bare_id,
            access_hash: 0,
        }
        .into()],
    };
    if let Ok(tl::enums::messages::Chats::Chats(chats)) = client.invoke(&req).await {
        for chat in chats.chats {
            if let tl::enums::Chat::Channel(ch) = chat {
                if ch.id == bare_id {
                    let packed = PackedChat {
                        ty: if ch.broadcast {
                            PackedType::Broadcast
                        } else {
                            PackedType::Megagroup
                        },
                        id: ch.id,
                        access_hash: ch.access_hash,
                    };
                    engine.peer_cache.write().await.insert(target.to_string(), packed);
                    return Ok(packed);
                }
            }
        }
    }

    // 2. Fallback for User accounts: scan dialogs
    if let Ok(me) = client.get_me().await {
        if !me.is_bot() {
            let mut dialogs = client.iter_dialogs();
            while let Ok(Some(dialog)) = dialogs.next().await {
                let chat = dialog.chat();
                if chat.id() == bare_id {
                    let packed = chat.pack();
                    engine.peer_cache.write().await.insert(target.to_string(), packed);
                    return Ok(packed);
                }
            }
        }
    }

    Err(format!(
        "Could not resolve Telegram channel '{target}'. Ensure your Bot or User is a member/admin of the channel."
    ))
}

fn extract_media_meta(msg: &grammers_client::types::Message) -> Option<(Media, u64, String, String)> {
    let media = msg.media()?;
    match &media {
        Media::Document(doc) => {
            let size = doc.size().max(0) as u64;
            let raw_name = doc.name().trim().to_string();
            let caption = msg.text().trim();
            let name = if !raw_name.is_empty() {
                raw_name
            } else if !caption.is_empty() && !caption.starts_with('{') {
                caption.rsplit('/').next().unwrap_or(caption).to_string()
            } else {
                format!("telegram_{}.mp4", msg.id())
            };
            let mime = doc
                .mime_type()
                .map(|m| m.to_string())
                .unwrap_or_else(|| {
                    mime_guess::from_path(&name)
                        .first_or_octet_stream()
                        .to_string()
                });
            Some((media, size, name, mime))
        }
        Media::Photo(photo) => {
            let size = photo.size().max(0) as u64;
            let name = format!("photo_{}.jpg", msg.id());
            Some((media, size, name, "image/jpeg".to_string()))
        }
        _ => None,
    }
}

/// Resolves the `Media` handle, total byte size, filename, and MIME type for `(chat_id, msg_id)`.
pub async fn resolve_message_media(
    chat_id_opt: Option<&str>,
    msg_id: i32,
) -> Result<(Client, Media, u64, String, String), String> {
    let engine = get_engine();
    let client = engine.get_or_connect_client().await?;
    let creds = engine.load_creds();
    let chat_id = chat_id_opt
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or(creds.default_chat_id);

    let cache_key = (chat_id.clone(), msg_id);
    if let Some((media, size, name, mime, inserted_at)) = engine.media_cache.read().await.get(&cache_key).cloned() {
        if inserted_at.elapsed() < std::time::Duration::from_secs(1800) {
            return Ok((client, media, size, name, mime));
        }
    }

    let mut attempt = 0;
    let mut msgs = loop {
        let current_client = engine.get_or_connect_client().await?;
        let packed = resolve_packed_chat(&current_client, &chat_id).await?;
        match current_client.get_messages_by_id(packed, &[msg_id]).await {
            Ok(m) => break m,
            Err(e) if attempt < 2 && {
                let s = e.to_string();
                s.contains("Connection reset") || s.contains("IO failed") || s.contains("read error")
            } => {
                attempt += 1;
                engine.reset_client().await;
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
            Err(e) => return Err(format!("get_messages_by_id({msg_id}) failed: {e}")),
        }
    };

    let msg = msgs
        .pop()
        .flatten()
        .ok_or_else(|| format!("Telegram message #{msg_id} not found in {chat_id}"))?;

    let (media, size, name, mime) =
        extract_media_meta(&msg).ok_or_else(|| format!("Message #{msg_id} contains no downloadable media"))?;

    engine
        .media_cache
        .write()
        .await
        .insert(cache_key, (media.clone(), size, name.clone(), mime.clone(), std::time::Instant::now()));

    Ok((client, media, size, name, mime))
}

/// Syncs the in-memory & disk index with Telegram (reads pinned manifest for Bots, full history for Users, and all Telegram-Drive desktop folder channels).
pub async fn sync_channel_index(chat_id_override: Option<String>) -> Result<Vec<TelegramFileEntry>, String> {
    let engine = get_engine();

    // 0. If Telegram-Drive desktop user session exists, sync all desktop folders over MTProto
    if engine.user_session_path.exists() {
        if let Ok(uclient) = engine.get_or_connect_client().await {
            let folders = engine.folders.read().await.clone();
            for folder in folders {
                if let Ok(packed) = resolve_packed_chat(&uclient, &folder.chat_id).await {
                    let mut iter = uclient.iter_messages(packed).limit(150);
                    let mut idx = engine.index.write().await;
                    while let Ok(Some(msg)) = iter.next().await {
                        if let Some((media, size, name, mime)) = extract_media_meta(&msg) {
                            let clean_name = name.trim().replace('/', "_");
                            let path = format!("/{}/{}", folder.name, clean_name);
                            engine.media_cache.write().await.insert(
                                (folder.chat_id.clone(), msg.id()),
                                (media, size, clean_name.clone(), mime.clone(), std::time::Instant::now()),
                            );
                            if !idx
                                .entries
                                .iter()
                                .any(|e| e.msg_id == msg.id() && e.chat_id == folder.chat_id)
                            {
                                idx.entries.push(TelegramFileEntry {
                                    msg_id: msg.id(),
                                    chat_id: folder.chat_id.clone(),
                                    name: clean_name,
                                    path,
                                    size,
                                    mime_type: mime,
                                    updated_at: msg.date().timestamp().max(0) as u64,
                                });
                            }
                        }
                    }
                    drop(idx);
                }
            }
            let _ = engine.persist_index().await;
        }
    }

    let creds = engine.load_creds();
    let chat_id = chat_id_override
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| creds.default_chat_id.clone());

    if chat_id.trim().is_empty() {
        let entries = engine.index.read().await.entries.clone();
        return Ok(entries);
    }

    let Ok(client) = engine.get_or_connect_client().await else {
        let entries = engine.index.read().await.entries.clone();
        return Ok(entries);
    };

    let packed = resolve_packed_chat(&client, &chat_id).await?;
    let me = client.get_me().await.map_err(|e| e.to_string())?;

    // 1. Check pinned manifest message first (works for both Bot and User accounts)
    if let Ok(Some(pinned)) = client.get_pinned_message(packed).await {
        let text = pinned.text().trim();
        if let Some(json_str) = text.strip_prefix("RCLONEFLIX_TG_MANIFEST:") {
            if let Ok(remote_manifest) = serde_json::from_str::<TelegramIndexManifest>(json_str.trim()) {
                let mut idx = engine.index.write().await;
                idx.pinned_msg_id = Some(pinned.id());
                for remote_entry in remote_manifest.entries {
                    if !idx.entries.iter().any(|e| e.msg_id == remote_entry.msg_id) {
                        idx.entries.push(remote_entry);
                    }
                }
                drop(idx);
                let _ = engine.persist_index().await;
            }
        }
    }

    // 2. If logged in as a User Account (not a Bot), also scan channel message history directly
    if !me.is_bot() {
        let mut iter = client.iter_messages(packed).limit(500);
        let mut idx = engine.index.write().await;
        while let Ok(Some(msg)) = iter.next().await {
            if let Some((media, size, name, mime)) = extract_media_meta(&msg) {
                let caption = msg.text().trim();
                let path = if caption.starts_with('/') {
                    caption.to_string()
                } else {
                    format!("/{}", name)
                };
                engine.media_cache.write().await.insert(
                    (chat_id.clone(), msg.id()),
                    (media, size, name.clone(), mime.clone(), std::time::Instant::now()),
                );
                if !idx.entries.iter().any(|e| e.msg_id == msg.id()) {
                    idx.entries.push(TelegramFileEntry {
                        msg_id: msg.id(),
                        chat_id: chat_id.clone(),
                        name,
                        path,
                        size,
                        mime_type: mime,
                        updated_at: msg.date().timestamp().max(0) as u64,
                    });
                }
            }
        }
        drop(idx);
        let _ = engine.persist_index().await;
    }

    let entries = engine.index.read().await.entries.clone();
    Ok(entries)
}

/// Publishes the updated manifest to the channel's pinned message so other devices (Android/TV) stay synced.
pub async fn publish_pinned_manifest(client: &Client, chat_id: &str) {
    let engine = get_engine();
    let Ok(packed) = resolve_packed_chat(client, chat_id).await else {
        return;
    };
    let manifest_snapshot = engine.index.read().await.clone();
    let Ok(json_str) = serde_json::to_string(&manifest_snapshot) else {
        return;
    };
    let payload = format!("RCLONEFLIX_TG_MANIFEST:{json_str}");
    if payload.len() > 4000 {
        return; // Telegram text message cap is 4096 chars
    }

    if let Some(pin_id) = manifest_snapshot.pinned_msg_id {
        if client.edit_message(packed, pin_id, InputMessage::text(&payload)).await.is_ok() {
            return;
        }
    }

    if let Ok(sent) = client.send_message(packed, InputMessage::text(&payload)).await {
        let _ = client.pin_message(packed, sent.id()).await;
        engine.index.write().await.pinned_msg_id = Some(sent.id());
        let _ = engine.persist_index().await;
    }
}

// ── Tauri Commands ────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct TelegramConnectionStatus {
    pub connected: bool,
    pub authorized: bool,
    pub is_bot: bool,
    pub username: Option<String>,
    pub default_chat_id: String,
    pub indexed_files: usize,
    pub webdav_url: String,
}

#[tauri::command]
pub async fn telegram_configure_and_connect(
    api_id: Option<i32>,
    api_hash: Option<String>,
    bot_token: Option<String>,
    default_chat_id: Option<String>,
) -> Result<TelegramConnectionStatus, String> {
    let engine = get_engine();
    let mut creds = engine.load_creds();
    if let Some(id) = api_id.filter(|&x| x > 0) {
        creds.api_id = id;
    }
    if let Some(h) = api_hash.filter(|s| !s.trim().is_empty()) {
        creds.api_hash = h.trim().to_string();
    }
    if let Some(t) = bot_token {
        if creds.bot_token.trim() != t.trim() {
            // Reset session when bot token changes
            *engine.client.lock().await = None;
            let _ = std::fs::remove_file(&engine.session_path);
        }
        creds.bot_token = t.trim().to_string();
    }
    if let Some(c) = default_chat_id {
        creds.default_chat_id = c.trim().to_string();
    }
    engine.save_creds(&creds)?;

    // Reset cached client to force fresh connection
    *engine.client.lock().await = None;
    let client = engine.get_or_connect_client().await?;
    let authorized = client.is_authorized().await.unwrap_or(false);
    let mut is_bot = false;
    let mut username = None;
    if authorized {
        if let Ok(me) = client.get_me().await {
            is_bot = me.is_bot();
            username = me.username().map(|u| u.to_string()).or_else(|| Some(me.first_name().to_string()));
        }
        let _ = sync_channel_index(None).await;
    }

    let port = crate::commands::stream_proxy::get_or_start_proxy_server().await.unwrap_or(0);
    let indexed_files = engine.index.read().await.entries.len();

    Ok(TelegramConnectionStatus {
        connected: true,
        authorized,
        is_bot,
        username,
        default_chat_id: creds.default_chat_id,
        indexed_files,
        webdav_url: format!("http://localhost:{port}/webdav"),
    })
}

#[tauri::command]
pub async fn telegram_get_status() -> Result<TelegramConnectionStatus, String> {
    let engine = get_engine();
    let creds = engine.load_creds();
    let port = crate::commands::stream_proxy::get_or_start_proxy_server().await.unwrap_or(0);
    let indexed_files = engine.index.read().await.entries.len();

    let client_opt = engine.client.lock().await.clone();
    if let Some(client) = client_opt {
        let authorized = client.is_authorized().await.unwrap_or(false);
        let (is_bot, username) = if authorized {
            match client.get_me().await {
                Ok(me) => (
                    me.is_bot(),
                    me.username().map(|u| u.to_string()).or_else(|| Some(me.first_name().to_string())),
                ),
                Err(_) => (false, None),
            }
        } else {
            (false, None)
        };
        return Ok(TelegramConnectionStatus {
            connected: true,
            authorized,
            is_bot,
            username,
            default_chat_id: creds.default_chat_id,
            indexed_files,
            webdav_url: format!("http://localhost:{port}/webdav"),
        });
    }

    Ok(TelegramConnectionStatus {
        connected: false,
        authorized: false,
        is_bot: !creds.bot_token.is_empty(),
        username: None,
        default_chat_id: creds.default_chat_id,
        indexed_files,
        webdav_url: format!("http://localhost:{port}/webdav"),
    })
}

#[tauri::command]
pub async fn telegram_request_user_code(phone: String) -> Result<String, String> {
    let engine = get_engine();
    *engine.client.lock().await = None;
    let _ = std::fs::remove_file(&engine.session_path);
    let mut creds = engine.load_creds();
    creds.bot_token.clear();
    creds.auth_mode = "user".to_string();
    engine.save_creds(&creds)?;

    let client = engine.get_or_connect_client().await?;
    let token = client
        .request_login_code(phone.trim())
        .await
        .map_err(|e| format!("Failed to request login code: {e}"))?;
    *engine.login_token.lock().await = Some(token);
    Ok("code_sent".to_string())
}

#[tauri::command]
pub async fn telegram_sign_in_user(code: String, password: Option<String>) -> Result<TelegramConnectionStatus, String> {
    let engine = get_engine();
    let client = engine.get_or_connect_client().await?;

    if let Some(pwd) = password.filter(|p| !p.is_empty()) {
        let pwd_token = engine
            .password_token
            .lock()
            .await
            .take()
            .ok_or_else(|| "No pending 2FA password prompt".to_string())?;
        client
            .check_password(pwd_token, pwd.trim())
            .await
            .map_err(|e| format!("2FA check failed: {e}"))?;
    } else {
        let login_token = engine
            .login_token
            .lock()
            .await
            .take()
            .ok_or_else(|| "Request a login code first".to_string())?;
        match client.sign_in(&login_token, code.trim()).await {
            Ok(_) => {}
            Err(SignInError::PasswordRequired(pwd_token)) => {
                *engine.password_token.lock().await = Some(pwd_token);
                return Err("2FA_PASSWORD_REQUIRED".to_string());
            }
            Err(e) => return Err(format!("Sign-in failed: {e}")),
        }
    }

    let _ = client.session().save_to_file(&engine.session_path);
    telegram_get_status().await
}

#[tauri::command]
pub async fn telegram_sync_index(chat_id: Option<String>) -> Result<Vec<TelegramFileEntry>, String> {
    sync_channel_index(chat_id).await
}

#[tauri::command]
pub async fn telegram_upload_local_file(
    file_path: String,
    remote_path: Option<String>,
    chat_id: Option<String>,
) -> Result<TelegramFileEntry, String> {
    let engine = get_engine();
    let client = engine.get_or_connect_client().await?;
    let creds = engine.load_creds();
    let target_chat = chat_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| creds.default_chat_id.clone());
    let packed = resolve_packed_chat(&client, &target_chat).await?;

    let path_buf = PathBuf::from(&file_path);
    let file_name = path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload.bin".to_string());
    let metadata = tokio::fs::metadata(&path_buf).await.map_err(|e| e.to_string())?;
    let size = metadata.len();

    let uploaded = client
        .upload_file(&path_buf)
        .await
        .map_err(|e| format!("MTProto upload_file failed: {e}"))?;

    let clean_rel = remote_path
        .unwrap_or_else(|| format!("/{}", file_name))
        .trim()
        .to_string();
    let normalized_path = if clean_rel.starts_with('/') {
        clean_rel
    } else {
        format!("/{}", clean_rel)
    };

    let msg = client
        .send_message(
            packed,
            InputMessage::text(&normalized_path).document(uploaded),
        )
        .await
        .map_err(|e| format!("Failed sending uploaded document to channel: {e}"))?;

    let mime_type = mime_guess::from_path(&file_name)
        .first_or_octet_stream()
        .to_string();

    let entry = TelegramFileEntry {
        msg_id: msg.id(),
        chat_id: target_chat.clone(),
        name: file_name,
        path: normalized_path,
        size,
        mime_type,
        updated_at: msg.date().timestamp().max(0) as u64,
    };

    {
        let mut idx = engine.index.write().await;
        idx.entries.retain(|e| e.msg_id != entry.msg_id && e.path != entry.path);
        idx.entries.push(entry.clone());
    }
    let _ = engine.persist_index().await;
    publish_pinned_manifest(&client, &target_chat).await;

    Ok(entry)
}

// ── Embedded HTTP 206 Range Streaming + WebDAV Handler ────────────────────────

pub async fn handle_telegram_http(
    socket: &mut tokio::net::TcpStream,
    method: &str,
    raw_path: &str,
    request_str: &str,
    initial_buf: &[u8],
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let path_only = raw_path.split('?').next().unwrap_or(raw_path);
    let decoded_path = percent_encoding::percent_decode_str(path_only)
        .decode_utf8_lossy()
        .to_string();

    // Parse headers
    let mut range_header: Option<String> = None;
    let mut depth_header = "1".to_string();
    let mut content_length: usize = 0;
    for line in request_str.lines().skip(1) {
        if line.is_empty() || line == "\r" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let k_lower = k.trim().to_ascii_lowercase();
            let v_trim = v.trim();
            if k_lower == "range" {
                range_header = Some(v_trim.to_string());
            } else if k_lower == "depth" {
                depth_header = v_trim.to_string();
            } else if k_lower == "content-length" {
                content_length = v_trim.parse::<usize>().unwrap_or(0);
            }
        }
    }

    // 1. OPTIONS (WebDAV + CORS discovery)
    if method.eq_ignore_ascii_case("OPTIONS") {
        let resp = "HTTP/1.1 200 OK\r\n\
DAV: 1, 2\r\n\
MS-Author-Via: DAV\r\n\
Allow: OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, PROPFIND\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Allow-Methods: OPTIONS, GET, HEAD, PUT, DELETE, MKCOL, MOVE, PROPFIND, POST\r\n\
Access-Control-Allow-Headers: *\r\n\
Content-Length: 0\r\n\
Connection: close\r\n\r\n";
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // 2. GET /manifest & POST /rebuild-index & POST /register-entry
    if decoded_path == "/manifest" || decoded_path == "/rebuild-index" {
        let entries = match sync_channel_index(None).await {
            Ok(list) => list,
            Err(_) => get_engine().index.read().await.entries.clone(),
        };
        let body = serde_json::to_string(&serde_json::json!({ "entries": entries }))?;
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    if decoded_path == "/register-entry" && method.eq_ignore_ascii_case("POST") {
        let body_bytes = read_http_body(socket, initial_buf, content_length).await?;
        if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
            let msg_id = val.get("msgId").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let name = val.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let size = val.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            let chat_id = val
                .get("chatId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let path = val
                .get("path")
                .and_then(|v| v.as_str())
                .map(|s| if s.starts_with('/') { s.to_string() } else { format!("/{s}") })
                .unwrap_or_else(|| format!("/{name}"));
            if msg_id > 0 && !name.is_empty() {
                let engine = get_engine();
                let entry = TelegramFileEntry {
                    msg_id,
                    chat_id: if chat_id.is_empty() {
                        engine.load_creds().default_chat_id
                    } else {
                        chat_id
                    },
                    name: name.clone(),
                    path,
                    size,
                    mime_type: mime_guess::from_path(&name).first_or_octet_stream().to_string(),
                    updated_at: std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs(),
                };
                {
                    let mut idx = engine.index.write().await;
                    idx.entries.retain(|e| e.msg_id != msg_id);
                    idx.entries.push(entry);
                }
                let _ = engine.persist_index().await;
            }
        }
        let resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}";
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // 3. WebDAV PROPFIND (supports both `/dav/{token}/...` and `/webdav/...`)
    if method.eq_ignore_ascii_case("PROPFIND") {
        let (base_prefix, rel) = split_webdav_prefix(&decoded_path);
        let engine = get_engine();
        if engine.index.read().await.entries.is_empty() {
            let _ = sync_channel_index(None).await;
        }
        let entries = engine.index.read().await.entries.clone();
        let folders = engine.folders.read().await.clone();
        let xml = build_propfind_xml(&base_prefix, &rel, &depth_header, &folders, &entries);
        let resp = format!(
            "HTTP/1.1 207 Multi-Status\r\nContent-Type: application/xml; charset=utf-8\r\nDAV: 1, 2\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            xml.len(),
            xml
        );
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // 4. WebDAV MKCOL
    if method.eq_ignore_ascii_case("MKCOL") {
        let resp = "HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    // 5. WebDAV PUT (Direct Rclone/HTTP file upload to Telegram)
    if method.eq_ignore_ascii_case("PUT") {
        let rel = decoded_path
            .strip_prefix("/webdav")
            .unwrap_or(&decoded_path)
            .trim_start_matches('/');
        let file_name = rel.rsplit('/').next().unwrap_or("upload.bin").to_string();
        let temp_path = std::env::temp_dir().join(format!("rflix_tg_put_{}_{}", std::process::id(), file_name));
        stream_http_body_to_file(socket, initial_buf, content_length, &temp_path).await?;
        let res = telegram_upload_local_file(
            temp_path.to_string_lossy().to_string(),
            Some(format!("/{}", rel)),
            None,
        )
        .await;
        let _ = tokio::fs::remove_file(&temp_path).await;
        match res {
            Ok(entry) => {
                let body = serde_json::to_string(&serde_json::json!({ "ok": true, "entry": entry }))?;
                let resp = format!(
                    "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nX-Telegram-Msg-Id: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    entry.msg_id,
                    body.len(),
                    body
                );
                socket.write_all(resp.as_bytes()).await?;
            }
            Err(e) => {
                let resp = format!(
                    "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    e.len(),
                    e
                );
                socket.write_all(resp.as_bytes()).await?;
            }
        }
        return Ok(());
    }

    // 6. WebDAV DELETE
    if method.eq_ignore_ascii_case("DELETE") {
        let rel = decoded_path
            .strip_prefix("/webdav")
            .unwrap_or(&decoded_path);
        let engine = get_engine();
        let target_entry = {
            let mut idx = engine.index.write().await;
            let found = idx
                .entries
                .iter()
                .find(|e| e.path == rel || e.name == rel.trim_start_matches('/'))
                .cloned();
            idx.entries
                .retain(|e| e.path != rel && e.name != rel.trim_start_matches('/'));
            found
        };
        if let Some(entry) = target_entry {
            let _ = engine.persist_index().await;
            if let Ok(client) = engine.get_or_connect_client().await {
                if let Ok(packed) = resolve_packed_chat(&client, &entry.chat_id).await {
                    let _ = client.delete_messages(packed, &[entry.msg_id]).await;
                }
            }
        }
        socket
            .write_all(b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    }

    // 7. GET / HEAD Streaming (supports `/tg-stream/<msgId>/<name>`, `/webdav/__tg_<msgId>_<size>/<name>`, or `/webdav/<path>`)
    let engine = get_engine();
    let (chat_id_opt, msg_id) = match resolve_path_to_msg_id(&decoded_path).await {
        Some(pair) => pair,
        None => {
            socket
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\nConnection: close\r\n\r\nNot Found")
                .await?;
            return Ok(());
        }
    };

    let (client, media, total_size, _name, mime) = match resolve_message_media(chat_id_opt.as_deref(), msg_id).await {
        Ok(tuple) => tuple,
        Err(e) => {
            let resp = format!(
                "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                e.len(),
                e
            );
            socket.write_all(resp.as_bytes()).await?;
            return Ok(());
        }
    };

    // Telegram sometimes reports generic document MIME types; browsers refuse to seek/play those.
    let mime = if mime.trim().is_empty()
        || mime.eq_ignore_ascii_case("application/octet-stream")
        || mime.eq_ignore_ascii_case("binary/octet-stream")
    {
        mime_guess::from_path(&_name).first_or_octet_stream().to_string()
    } else {
        mime
    };
    let (start_byte, end_byte, is_range) = parse_byte_range(range_header.as_deref(), total_size);
    if start_byte >= total_size && total_size > 0 {
        let resp = format!(
            "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nAccept-Ranges: bytes\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            total_size
        );
        socket.write_all(resp.as_bytes()).await?;
        return Ok(());
    }

    let send_length = if total_size == 0 {
        0
    } else {
        end_byte - start_byte + 1
    };

    let status_line = if is_range {
        "HTTP/1.1 206 Partial Content"
    } else {
        "HTTP/1.1 200 OK"
    };

    let mut header = format!(
        "{status_line}\r\n\
Content-Type: {mime}\r\n\
Accept-Ranges: bytes\r\n\
Content-Length: {send_length}\r\n\
Access-Control-Allow-Origin: *\r\n\
Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type\r\n"
    );
    if is_range {
        header.push_str(&format!(
            "Content-Range: bytes {start_byte}-{end_byte}/{total_size}\r\n"
        ));
    }
    header.push_str("Connection: close\r\n\r\n");
    socket.write_all(header.as_bytes()).await?;

    if method.eq_ignore_ascii_case("HEAD") || send_length == 0 {
        return Ok(());
    }

    // Stream chunks aligned to 512 KiB (524_288) Telegram CDN boundary
    let aligned_start = (start_byte / CDN_ALIGNMENT) * CDN_ALIGNMENT;
    let mut skip_leading = (start_byte - aligned_start) as usize;
    let mut remaining = send_length;

    let downloadable = Downloadable::Media(media);
    let mut download_iter = client.iter_download(&downloadable).chunk_size(CHUNK_SIZE);

    // Safe i32 step loop to prevent (limit * n) i32 overflow on files >= 2 GiB
    let mut chunks_to_skip = (aligned_start / CHUNK_SIZE as u64) as i64;
    while chunks_to_skip > 0 {
        let step = chunks_to_skip.min(16_384) as i32;
        download_iter = download_iter.skip_chunks(step);
        chunks_to_skip -= step as i64;
    }

    // Clone what the error path needs before moving the iterator into the task.
    let chat_key_for_evict = chat_id_opt
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| engine.load_creds().default_chat_id);

    // Pipelined fetch: the producer downloads MTProto chunks ahead while we
    // write to the socket (bounded channel = 4 x 512 KiB read-ahead). When the
    // consumer returns (client disconnect/seek), tx.send() fails and the
    // producer stops — this is also the fix for the runaway download loop.
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Result<Vec<u8>, String>>(4);
    let producer = tokio::spawn(async move {
        loop {
            match download_iter.next().await {
                Ok(Some(c)) => {
                    if c.is_empty() {
                        break;
                    }
                    if tx.send(Ok(c)).await.is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    let _ = tx.send(Err(e.to_string())).await;
                    break;
                }
            }
        }
    });

    let mut stream_err: Option<String> = None;
    while remaining > 0 {
        let chunk = match rx.recv().await {
            Some(Ok(c)) => c,
            Some(Err(e)) => {
                stream_err = Some(e);
                break;
            }
            None => break,
        };
        let skip = skip_leading.min(chunk.len());
        skip_leading -= skip;
        let slice = &chunk[skip..];
        if slice.is_empty() {
            continue;
        }
        let take = (remaining as usize).min(slice.len());
        if socket.write_all(&slice[..take]).await.is_err() {
            break; // Client closed connection (e.g. player seeked to a new range)
        }
        remaining -= take as u64;
    }
    producer.abort();

    if let Some(err_str) = stream_err {
        if err_str.contains("FILE_REFERENCE_EXPIRED") {
            log::warn!(target: "telegram", "FILE_REFERENCE_EXPIRED on msg #{msg_id}; evicting cache");
            engine.media_cache.write().await.remove(&(chat_key_for_evict, msg_id));
        }
        return Err(err_str.into());
    }

    Ok(())
}

/// Splits `/dav/{token}/Folder/File.mp4` into `("/dav/{token}", "Folder/File.mp4")`,
/// `/dav/Folder/File.mp4` into `("/dav", "Folder/File.mp4")`,
/// or `/webdav/Folder/File.mp4` into `("/webdav", "Folder/File.mp4")`.
fn split_webdav_prefix(decoded_path: &str) -> (String, String) {
    if let Some(after_dav) = decoded_path.strip_prefix("/dav") {
        let trimmed = after_dav.trim_matches('/');
        if trimmed.is_empty() {
            return ("/dav".to_string(), String::new());
        }
        if let Some((first_seg, rest)) = trimmed.split_once('/') {
            if first_seg.len() >= 32 && first_seg.chars().all(|c| c.is_ascii_hexdigit()) {
                return (format!("/dav/{first_seg}"), rest.trim_matches('/').to_string());
            }
            return ("/dav".to_string(), trimmed.to_string());
        }
        if trimmed.len() >= 32 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return (format!("/dav/{trimmed}"), String::new());
        }
        return ("/dav".to_string(), trimmed.to_string());
    }
    if let Some(rest) = decoded_path.strip_prefix("/webdav") {
        return ("/webdav".to_string(), rest.trim_matches('/').to_string());
    }
    ("/webdav".to_string(), decoded_path.trim_matches('/').to_string())
}

async fn resolve_path_to_msg_id(decoded_path: &str) -> Option<(Option<String>, i32)> {
    // Pattern 1: /tg-stream/<msgId>/<filename> or /tg-stream/<chatId>/<msgId>/<filename>
    if let Some(rest) = decoded_path.strip_prefix("/tg-stream/") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() >= 3 {
            if let Ok(mid) = parts[1].parse::<i32>() {
                return Some((Some(parts[0].to_string()), mid));
            }
        }
        if let Some(first) = parts.first() {
            if let Ok(mid) = first.parse::<i32>() {
                return Some((None, mid));
            }
        }
    }

    // Pattern 2: Stateless path `/__tg_<msgId>_<size>/<filename>`
    for seg in decoded_path.split('/') {
        if let Some(rest) = seg.strip_prefix("__tg_") {
            let mut sp = rest.split('_');
            if let Some(id_str) = sp.next() {
                if let Ok(mid) = id_str.parse::<i32>() {
                    return Some((None, mid));
                }
            }
        }
    }

    // Pattern 3: Lookup in local Telegram index by `/dav/{token}/...` or `/webdav/...` path
    let (_base, rel) = split_webdav_prefix(decoded_path);
    let norm_rel = format!("/{}", rel.trim_start_matches('/'));
    let clean_name = rel.rsplit('/').next().unwrap_or(&rel);

    let engine = get_engine();
    if engine.index.read().await.entries.is_empty() {
        let _ = sync_channel_index(None).await;
    }
    let entries = engine.index.read().await;
    if let Some(found) = entries
        .entries
        .iter()
        .find(|e| e.path.eq_ignore_ascii_case(&norm_rel))
        .or_else(|| {
            entries
                .entries
                .iter()
                .find(|e| e.name.eq_ignore_ascii_case(clean_name))
        })
    {
        return Some((Some(found.chat_id.clone()), found.msg_id));
    }
    None
}

fn parse_byte_range(range_header: Option<&str>, total_size: u64) -> (u64, u64, bool) {
    if total_size == 0 {
        return (0, 0, false);
    }
    let Some(h) = range_header.and_then(|s| s.strip_prefix("bytes=")) else {
        return (0, total_size - 1, false);
    };
    let Some((start_str, end_str)) = h.split_once('-') else {
        return (0, total_size - 1, false);
    };
    let start_str = start_str.trim();
    let end_str = end_str.trim();
    if start_str.is_empty() {
        if let Ok(suffix) = end_str.parse::<u64>() {
            return (total_size.saturating_sub(suffix), total_size - 1, true);
        }
        return (0, total_size - 1, false);
    }
    let Ok(start) = start_str.parse::<u64>() else {
        return (0, total_size - 1, false);
    };
    let end = if end_str.is_empty() {
        total_size - 1
    } else {
        end_str.parse::<u64>().unwrap_or(total_size - 1).min(total_size - 1)
    };
    (start, end, true)
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn build_propfind_xml(
    base_prefix: &str,
    req_rel: &str,
    depth: &str,
    folders: &[TelegramDriveFolder],
    entries: &[TelegramFileEntry],
) -> String {
    let mut xml = String::from(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<D:multistatus xmlns:D=\"DAV:\">\n",
    );

    let clean_rel = req_rel.trim_matches('/');
    let norm_req = format!("/{clean_rel}");

    // Case 1: Request is for a specific file
    if !clean_rel.is_empty() {
        if let Some(file) = entries
            .iter()
            .find(|e| e.path.eq_ignore_ascii_case(&norm_req))
        {
            let encoded_rel =
                crate::commands::player::percent_encode_path(file.path.trim_start_matches('/'));
            xml.push_str(&format!(
                "<D:response>\n<D:href>{base_prefix}/{encoded_rel}</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:getcontentlength>{}</D:getcontentlength>\n<D:getcontenttype>{}</D:getcontenttype>\n<D:resourcetype/>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n</D:multistatus>",
                xml_escape(&file.name),
                file.size,
                xml_escape(&file.mime_type)
            ));
            return xml;
        }
    }

    // Collect distinct folder names from both `folders` metadata and `entries` paths
    let mut folder_names: Vec<String> = folders.iter().map(|f| f.name.clone()).collect();
    for entry in entries {
        let trimmed = entry.path.trim_start_matches('/');
        if let Some((folder_part, _)) = trimmed.split_once('/') {
            if !folder_part.is_empty()
                && !folder_names
                    .iter()
                    .any(|f| f.eq_ignore_ascii_case(folder_part))
            {
                folder_names.push(folder_part.to_string());
            }
        }
    }

    // Case 2: Request is for a specific Folder collection (`PROPFIND /dav/{token}/{FolderName}/`)
    if !clean_rel.is_empty() {
        if let Some(matched_folder) = folder_names
            .iter()
            .find(|f| f.eq_ignore_ascii_case(clean_rel))
        {
            let encoded_folder = crate::commands::player::percent_encode_path(matched_folder);
            xml.push_str(&format!(
                "<D:response>\n<D:href>{base_prefix}/{encoded_folder}/</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:resourcetype><D:collection/></D:resourcetype>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n",
                xml_escape(matched_folder)
            ));

            if depth != "0" {
                let prefix_check = format!("/{}/", matched_folder.to_lowercase());
                for entry in entries {
                    if entry.path.to_lowercase().starts_with(&prefix_check) {
                        let encoded_path = crate::commands::player::percent_encode_path(
                            entry.path.trim_start_matches('/'),
                        );
                        xml.push_str(&format!(
                            "<D:response>\n<D:href>{base_prefix}/{encoded_path}</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:getcontentlength>{}</D:getcontentlength>\n<D:getcontenttype>{}</D:getcontenttype>\n<D:resourcetype/>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n",
                            xml_escape(&entry.name),
                            entry.size,
                            xml_escape(&entry.mime_type)
                        ));
                    }
                }
            }
            xml.push_str("</D:multistatus>");
            return xml;
        }
    }

    // Case 3: Root directory `PROPFIND /dav/{token}/`
    xml.push_str(&format!(
        "<D:response>\n<D:href>{base_prefix}/</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>telegram-drive</D:displayname>\n<D:resourcetype><D:collection/></D:resourcetype>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n"
    ));

    if depth != "0" {
        for folder in &folder_names {
            let encoded_folder = crate::commands::player::percent_encode_path(folder);
            xml.push_str(&format!(
                "<D:response>\n<D:href>{base_prefix}/{encoded_folder}/</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:resourcetype><D:collection/></D:resourcetype>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n",
                xml_escape(folder)
            ));
        }

        // Also include any root-level files (without a subfolder)
        for entry in entries {
            let trimmed = entry.path.trim_start_matches('/');
            if !trimmed.contains('/') {
                let encoded_name = crate::commands::player::percent_encode_path(trimmed);
                xml.push_str(&format!(
                    "<D:response>\n<D:href>{base_prefix}/{encoded_name}</D:href>\n<D:propstat>\n<D:prop>\n<D:displayname>{}</D:displayname>\n<D:getcontentlength>{}</D:getcontentlength>\n<D:getcontenttype>{}</D:getcontenttype>\n<D:resourcetype/>\n</D:prop>\n<D:status>HTTP/1.1 200 OK</D:status>\n</D:propstat>\n</D:response>\n",
                    xml_escape(&entry.name),
                    entry.size,
                    xml_escape(&entry.mime_type)
                ));
            }
        }
    }

    xml.push_str("</D:multistatus>");
    xml
}

async fn read_http_body(
    socket: &mut tokio::net::TcpStream,
    initial_buf: &[u8],
    content_length: usize,
) -> Result<Vec<u8>, std::io::Error> {
    let header_end = initial_buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| p + 4)
        .unwrap_or(initial_buf.len());
    let mut out = initial_buf[header_end..].to_vec();
    while out.len() < content_length {
        let mut chunk = vec![0u8; (content_length - out.len()).min(65536)];
        let n = socket.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&chunk[..n]);
    }
    Ok(out)
}

async fn stream_http_body_to_file(
    socket: &mut tokio::net::TcpStream,
    initial_buf: &[u8],
    content_length: usize,
    dest: &PathBuf,
) -> Result<(), std::io::Error> {
    let mut file = tokio::fs::File::create(dest).await?;
    let header_end = initial_buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|p| p + 4)
        .unwrap_or(initial_buf.len());
    let initial_body = &initial_buf[header_end..];
    file.write_all(initial_body).await?;
    let mut written = initial_body.len();
    let mut buf = vec![0u8; 65536];
    while written < content_length {
        let to_read = (content_length - written).min(buf.len());
        let n = socket.read(&mut buf[..to_read]).await?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).await?;
        written += n;
    }
    file.flush().await?;
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TelegramDriveDesktopStatus {
    pub detected: bool,
    pub path: Option<String>,
    pub folders_count: usize,
    pub files_count: usize,
    pub folders: Vec<TelegramDriveFolder>,
    pub webdav_url: String,
    pub is_running: bool,
}

#[tauri::command]
pub async fn telegram_get_desktop_status() -> Result<TelegramDriveDesktopStatus, String> {
    let engine = get_engine();
    let folders = engine.folders.read().await.clone();
    let folders_count = folders.len();
    let files_count = engine.index.read().await.entries.len();

    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());

    let candidate_dirs = [
        home.join(".local/share/com.cameronamer.telegramdrive"),
        home.join(".local/share/com.caamer20.telegramdrive"),
        home.join(".local/share/telegram-drive"),
        home.join("AppData/Roaming/com.cameronamer.telegramdrive"),
        home.join("Library/Application Support/com.cameronamer.telegramdrive"),
    ];

    let detected_dir = candidate_dirs.into_iter().find(|d| d.exists());
    let detected = detected_dir.is_some() || folders_count > 0;
    let path = detected_dir.as_ref().map(|p| p.to_string_lossy().to_string());

    // Preserve any existing token URL in ~/.config/rclone/rclone.conf if present
    let mut webdav_url = "http://127.0.0.1:8551/dav/".to_string();
    let rclone_conf = home.join(".config/rclone/rclone.conf");
    if let Ok(conf_text) = std::fs::read_to_string(&rclone_conf) {
        for line in conf_text.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with("url") && trimmed.contains("127.0.0.1:8551/dav/") {
                if let Some((_, val)) = trimmed.split_once('=') {
                    webdav_url = val.trim().to_string();
                    break;
                }
            }
        }
    }

    let is_running = tokio::time::timeout(
        std::time::Duration::from_millis(800),
        tokio::net::TcpStream::connect("127.0.0.1:8551"),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false);

    Ok(TelegramDriveDesktopStatus {
        detected,
        path,
        folders_count,
        files_count,
        folders,
        webdav_url,
        is_running,
    })
}

#[tauri::command]
pub async fn telegram_import_desktop_app() -> Result<TelegramDriveDesktopStatus, String> {
    let engine = get_engine();
    import_telegram_drive_desktop_state(&engine);
    telegram_get_desktop_status().await
}

