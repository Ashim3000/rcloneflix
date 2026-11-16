//! Media library storage.
//!
//! The library used to live in the zustand `persist` blob in localStorage,
//! which is capped around 5-10 MB by WebKit. At ~500 bytes per item that put a
//! hard ceiling near 6-10k files, past which `setItem` throws, the in-memory
//! state survives, nothing persists, and the library silently empties on the
//! next launch. Items and watch progress now live in SQLite instead; settings
//! and library definitions are small and stay in the Tauri store.
//!
//! Items are stored as JSON blobs keyed by id rather than a wide column schema:
//! the shape is driven by the frontend `MediaItem` type and changes often, and
//! the queries we need (all items, items by library) are served by one index.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub struct LibraryDb {
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    pub id: String,
    pub library_id: String,
    /// The full MediaItem as JSON.
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlaylist {
    pub id: String,
    pub data: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFavorite {
    pub item_id: String,
    pub favorited_at: i64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct LibrarySnapshot {
    pub items: Vec<String>,
    pub progress: Vec<String>,
    pub playlists: Vec<String>,
    pub favorites: Vec<StoredFavorite>,
}

impl LibraryDb {
    pub fn new(app: &AppHandle) -> Result<Self, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("No app data dir: {}", e))?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create data dir: {}", e))?;
        let conn = Connection::open(dir.join("library.db"))
            .map_err(|e| format!("Cannot open library.db: {}", e))?;

        // WAL keeps reads fast while a scan is writing.
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS media_items (
                 id          TEXT PRIMARY KEY,
                 library_id  TEXT NOT NULL,
                 data        TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_media_items_library
                 ON media_items(library_id);

             CREATE TABLE IF NOT EXISTS watch_progress (
                 item_id     TEXT PRIMARY KEY,
                 data        TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS playlists (
                 id          TEXT PRIMARY KEY,
                 data        TEXT NOT NULL
             );

             CREATE TABLE IF NOT EXISTS favorites (
                 item_id      TEXT PRIMARY KEY,
                 favorited_at INTEGER NOT NULL
             );

             CREATE TABLE IF NOT EXISTS meta (
                 key   TEXT PRIMARY KEY,
                 value TEXT NOT NULL
             );",
        )
        .map_err(|e| format!("Cannot create schema: {}", e))?;

        Ok(LibraryDb {
            conn: Mutex::new(conn),
        })
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Load the entire library. Called once at startup.
#[tauri::command]
pub async fn library_load_all(db: State<'_, LibraryDb>) -> Result<LibrarySnapshot, String> {
    let conn = db.conn.lock().unwrap();

    let mut stmt = conn
        .prepare("SELECT data FROM media_items")
        .map_err(|e| e.to_string())?;
    let items: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut stmt = conn
        .prepare("SELECT data FROM watch_progress")
        .map_err(|e| e.to_string())?;
    let progress: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut stmt = conn
        .prepare("SELECT data FROM playlists")
        .map_err(|e| e.to_string())?;
    let playlists: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    let mut stmt = conn
        .prepare("SELECT item_id, favorited_at FROM favorites")
        .map_err(|e| e.to_string())?;
    let favorites: Vec<StoredFavorite> = stmt
        .query_map([], |row| {
            Ok(StoredFavorite {
                item_id: row.get(0)?,
                favorited_at: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    Ok(LibrarySnapshot {
        items,
        progress,
        playlists,
        favorites,
    })
}

/// Insert or replace a batch of items in a single transaction.
#[tauri::command]
pub async fn library_upsert_items(
    db: State<'_, LibraryDb>,
    items: Vec<StoredItem>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO media_items (id, library_id, data) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for item in &items {
            stmt.execute(params![item.id, item.library_id, item.data])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(items.len())
}

#[tauri::command]
pub async fn library_remove_items(
    db: State<'_, LibraryDb>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM media_items WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        for id in &ids {
            stmt.execute(params![id]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids.len())
}

#[tauri::command]
pub async fn library_clear_library(
    db: State<'_, LibraryDb>,
    library_id: String,
) -> Result<usize, String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM media_items WHERE library_id = ?1", params![library_id])
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn library_set_progress(
    db: State<'_, LibraryDb>,
    item_id: String,
    data: String,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO watch_progress (item_id, data) VALUES (?1, ?2)",
        params![item_id, data],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn library_remove_progress(
    db: State<'_, LibraryDb>,
    item_id: String,
) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute("DELETE FROM watch_progress WHERE item_id = ?1", params![item_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn library_upsert_playlists(
    db: State<'_, LibraryDb>,
    playlists: Vec<StoredPlaylist>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO playlists (id, data) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for p in &playlists {
            stmt.execute(params![p.id, p.data])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(playlists.len())
}

#[tauri::command]
pub async fn library_remove_playlists(
    db: State<'_, LibraryDb>,
    ids: Vec<String>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM playlists WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        for id in &ids {
            stmt.execute(params![id]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(ids.len())
}

#[tauri::command]
pub async fn library_set_favorites(
    db: State<'_, LibraryDb>,
    favorites: Vec<StoredFavorite>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("INSERT OR REPLACE INTO favorites (item_id, favorited_at) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for f in &favorites {
            stmt.execute(params![f.item_id, f.favorited_at])
                .map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(favorites.len())
}

#[tauri::command]
pub async fn library_remove_favorites(
    db: State<'_, LibraryDb>,
    item_ids: Vec<String>,
) -> Result<usize, String> {
    let mut conn = db.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM favorites WHERE item_id = ?1")
            .map_err(|e| e.to_string())?;
        for id in &item_ids {
            stmt.execute(params![id]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(item_ids.len())
}

/// Has the one-time localStorage import already run?
#[tauri::command]
pub async fn library_migration_done(db: State<'_, LibraryDb>) -> Result<bool, String> {
    let conn = db.conn.lock().unwrap();
    let done: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'migrated_from_localstorage'", [], |r| r.get(0))
        .ok();
    Ok(done.is_some())
}

#[tauri::command]
pub async fn library_mark_migrated(db: State<'_, LibraryDb>) -> Result<(), String> {
    let conn = db.conn.lock().unwrap();
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from_localstorage', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn library_count(db: State<'_, LibraryDb>) -> Result<i64, String> {
    let conn = db.conn.lock().unwrap();
    conn.query_row("SELECT COUNT(*) FROM media_items", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}
