package com.rcloneflix.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.database.sqlite.SQLiteStatement;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

public class LibraryDbHelper extends SQLiteOpenHelper {
    private static final String TAG = "RcloneFlixSQLite";
    private static final String DB_NAME = "rcloneflix_library.db";
    private static final int DB_VERSION = 1;

    private static LibraryDbHelper instance;

    public static synchronized LibraryDbHelper getInstance(Context ctx) {
        if (instance == null) {
            instance = new LibraryDbHelper(ctx.getApplicationContext());
        }
        return instance;
    }

    private LibraryDbHelper(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.enableWriteAheadLogging();
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS media_items (id TEXT PRIMARY KEY, library_id TEXT NOT NULL, data TEXT NOT NULL)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_media_items_lib ON media_items(library_id)");
        db.execSQL("CREATE TABLE IF NOT EXISTS watch_progress (item_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
        db.execSQL("CREATE TABLE IF NOT EXISTS favorites (item_id TEXT PRIMARY KEY, favorited_at INTEGER NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        onCreate(db);
    }

    public synchronized int getMediaCount() {
        try {
            SQLiteDatabase db = getReadableDatabase();
            try (Cursor c = db.rawQuery("SELECT COUNT(*) FROM media_items", null)) {
                if (c.moveToFirst()) {
                    return c.getInt(0);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "getMediaCount failed", e);
        }
        return 0;
    }

    public synchronized String loadAllJson() {
        JSONObject out = new JSONObject();
        JSONArray items = new JSONArray();
        JSONArray progress = new JSONArray();
        JSONArray playlists = new JSONArray();
        JSONArray favorites = new JSONArray();

        try {
            SQLiteDatabase db = getReadableDatabase();
            try (Cursor c = db.rawQuery("SELECT data FROM media_items", null)) {
                while (c.moveToNext()) {
                    items.put(c.getString(0));
                }
            }
            try (Cursor c = db.rawQuery("SELECT data FROM watch_progress", null)) {
                while (c.moveToNext()) {
                    progress.put(c.getString(0));
                }
            }
            try (Cursor c = db.rawQuery("SELECT data FROM playlists", null)) {
                while (c.moveToNext()) {
                    playlists.put(c.getString(0));
                }
            }
            try (Cursor c = db.rawQuery("SELECT item_id, favorited_at FROM favorites", null)) {
                while (c.moveToNext()) {
                    JSONArray pair = new JSONArray();
                    pair.put(c.getString(0));
                    pair.put(c.getLong(1));
                    favorites.put(pair);
                }
            }
            out.put("items", items);
            out.put("progress", progress);
            out.put("playlists", playlists);
            out.put("favorites", favorites);
        } catch (Exception e) {
            Log.e(TAG, "loadAllJson error", e);
        }
        return out.toString();
    }

    public synchronized String loadItemsPageJson(int offset, int limit) {
        SQLiteDatabase db = getReadableDatabase();
        JSONArray items = new JSONArray();
        try (Cursor c = db.rawQuery(
                "SELECT data FROM media_items ORDER BY rowid ASC LIMIT ? OFFSET ?",
                new String[]{String.valueOf(limit), String.valueOf(offset)})) {
            while (c.moveToNext()) {
                try {
                    items.put(new JSONObject(c.getString(0)));
                } catch (Exception ignored) {}
            }
        }
        return items.toString();
    }

    public synchronized String loadMetaJson() {
        SQLiteDatabase db = getReadableDatabase();
        JSONObject result = new JSONObject();
        try {
            JSONArray progress = new JSONArray();
            try (Cursor c = db.rawQuery("SELECT data FROM watch_progress", null)) {
                while (c.moveToNext()) {
                    try { progress.put(new JSONObject(c.getString(0))); } catch (Exception ignored) {}
                }
            }
            JSONArray playlists = new JSONArray();
            try (Cursor c = db.rawQuery("SELECT data FROM playlists", null)) {
                while (c.moveToNext()) {
                    try { playlists.put(new JSONObject(c.getString(0))); } catch (Exception ignored) {}
                }
            }
            JSONArray favorites = new JSONArray();
            try (Cursor c = db.rawQuery("SELECT item_id, favorited_at FROM favorites", null)) {
                while (c.moveToNext()) {
                    JSONArray pair = new JSONArray();
                    pair.put(c.getString(0));
                    pair.put(c.getLong(1));
                    favorites.put(pair);
                }
            }
            result.put("progress", progress);
            result.put("playlists", playlists);
            result.put("favorites", favorites);
        } catch (Exception e) {
            Log.e(TAG, "loadMetaJson failed", e);
        }
        return result.toString();
    }

    public synchronized void upsertProgressBatch(String progressArrayJson) {
        SQLiteDatabase db = null;
        try {
            JSONArray arr = new JSONArray(progressArrayJson);
            if (arr.length() == 0) return;
            db = getWritableDatabase();
            db.beginTransactionNonExclusive();
            SQLiteStatement stmt = db.compileStatement(
                    "INSERT OR REPLACE INTO watch_progress (item_id, data) VALUES (?, ?)"
            );
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                String id = obj.optString("itemId", "");
                if (id.isEmpty()) continue;
                stmt.clearBindings();
                stmt.bindString(1, id);
                stmt.bindString(2, obj.toString());
                stmt.execute();
            }
            db.setTransactionSuccessful();
        } catch (Exception e) {
            Log.e(TAG, "upsertProgressBatch failed", e);
        } finally {
            if (db != null && db.inTransaction()) {
                db.endTransaction();
            }
        }
    }

    public synchronized boolean upsertItems(String itemsJson) {
        SQLiteDatabase db = null;
        try {
            JSONArray arr = new JSONArray(itemsJson);
            if (arr.length() == 0) return true;
            db = getWritableDatabase();
            db.beginTransactionNonExclusive();
            SQLiteStatement stmt = db.compileStatement(
                    "INSERT OR REPLACE INTO media_items (id, library_id, data) VALUES (?, ?, ?)"
            );
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                stmt.clearBindings();
                stmt.bindString(1, obj.optString("id", ""));
                stmt.bindString(2, obj.optString("libraryId", ""));
                stmt.bindString(3, obj.optString("data", "{}"));
                stmt.executeInsert();
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "upsertItems error", e);
            return false;
        } finally {
            if (db != null && db.inTransaction()) {
                try { db.endTransaction(); } catch (Exception ignored) {}
            }
        }
    }

    public synchronized boolean removeItems(String idsJson) {
        SQLiteDatabase db = null;
        try {
            JSONArray arr = new JSONArray(idsJson);
            if (arr.length() == 0) return true;
            db = getWritableDatabase();
            db.beginTransactionNonExclusive();
            SQLiteStatement stmt = db.compileStatement("DELETE FROM media_items WHERE id = ?");
            for (int i = 0; i < arr.length(); i++) {
                stmt.clearBindings();
                stmt.bindString(1, arr.getString(i));
                stmt.executeUpdateDelete();
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "removeItems error", e);
            return false;
        } finally {
            if (db != null && db.inTransaction()) {
                try { db.endTransaction(); } catch (Exception ignored) {}
            }
        }
    }

    public synchronized boolean clearLibrary(String libraryId) {
        try {
            SQLiteDatabase db = getWritableDatabase();
            db.delete("media_items", "library_id = ?", new String[]{libraryId});
            return true;
        } catch (Exception e) {
            Log.e(TAG, "clearLibrary error", e);
            return false;
        }
    }

    public synchronized boolean setProgress(String itemId, String data) {
        try {
            SQLiteDatabase db = getWritableDatabase();
            SQLiteStatement stmt = db.compileStatement(
                    "INSERT OR REPLACE INTO watch_progress (item_id, data) VALUES (?, ?)"
            );
            stmt.bindString(1, itemId);
            stmt.bindString(2, data);
            stmt.executeInsert();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "setProgress error", e);
            return false;
        }
    }

    public synchronized boolean removeProgress(String itemId) {
        try {
            SQLiteDatabase db = getWritableDatabase();
            db.delete("watch_progress", "item_id = ?", new String[]{itemId});
            return true;
        } catch (Exception e) {
            Log.e(TAG, "removeProgress error", e);
            return false;
        }
    }

    public synchronized boolean upsertPlaylists(String playlistsJson) {
        SQLiteDatabase db = null;
        try {
            JSONArray arr = new JSONArray(playlistsJson);
            if (arr.length() == 0) return true;
            db = getWritableDatabase();
            db.beginTransactionNonExclusive();
            SQLiteStatement stmt = db.compileStatement(
                    "INSERT OR REPLACE INTO playlists (id, data) VALUES (?, ?)"
            );
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                stmt.clearBindings();
                stmt.bindString(1, obj.optString("id", ""));
                stmt.bindString(2, obj.optString("data", "{}"));
                stmt.executeInsert();
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "upsertPlaylists error", e);
            return false;
        } finally {
            if (db != null && db.inTransaction()) {
                try { db.endTransaction(); } catch (Exception ignored) {}
            }
        }
    }

    public synchronized boolean removePlaylists(String idsJson) {
        SQLiteDatabase db = null;
        try {
            JSONArray arr = new JSONArray(idsJson);
            if (arr.length() == 0) return true;
            db = getWritableDatabase();
            db.beginTransactionNonExclusive();
            SQLiteStatement stmt = db.compileStatement("DELETE FROM playlists WHERE id = ?");
            for (int i = 0; i < arr.length(); i++) {
                stmt.clearBindings();
                stmt.bindString(1, arr.getString(i));
                stmt.executeUpdateDelete();
            }
            db.setTransactionSuccessful();
            return true;
        } catch (Exception e) {
            Log.e(TAG, "removePlaylists error", e);
            return false;
        } finally {
            if (db != null && db.inTransaction()) {
                try { db.endTransaction(); } catch (Exception ignored) {}
            }
        }
    }

    public synchronized boolean setFavorite(String itemId, long favoritedAt) {
        try {
            SQLiteDatabase db = getWritableDatabase();
            if (favoritedAt <= 0) {
                db.delete("favorites", "item_id = ?", new String[]{itemId});
            } else {
                SQLiteStatement stmt = db.compileStatement(
                        "INSERT OR REPLACE INTO favorites (item_id, favorited_at) VALUES (?, ?)"
                );
                stmt.bindString(1, itemId);
                stmt.bindLong(2, favoritedAt);
                stmt.executeInsert();
            }
            return true;
        } catch (Exception e) {
            Log.e(TAG, "setFavorite error", e);
            return false;
        }
    }
}
