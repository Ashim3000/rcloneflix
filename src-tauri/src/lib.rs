mod commands;

use commands::player::VlcManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            let vlc = VlcManager::new(app.handle().clone());
            app.manage(vlc);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::rclone::parse_rclone_config,
            commands::rclone::list_remote_path,
            commands::rclone::get_rclone_version,
            commands::rclone::get_stream_url,
            commands::store::save_api_keys,
            commands::store::load_api_keys,
            commands::scan::scan_library_files,
            commands::scan::parse_media_filename,
            commands::scan::hash_remote_path,
            commands::player::open_media,
            commands::player::player_play,
            commands::player::player_pause,
            commands::player::player_seek,
            commands::player::player_set_volume,
            commands::player::player_stop,
            commands::player::stop_stream_session,
            commands::player::stop_all_sessions,
            commands::player::get_media_info,
            commands::google::start_google_oauth,
            commands::google::save_google_tokens,
            commands::google::load_google_tokens,
            commands::google::clear_google_tokens,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
