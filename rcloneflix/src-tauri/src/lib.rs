mod commands;

use commands::player::ServeProcesses;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .manage(ServeProcesses(Mutex::new(HashMap::new())))
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
            commands::player::start_stream_session,
            commands::player::stop_stream_session,
            commands::player::stop_all_sessions,
            commands::player::get_media_info,
            commands::google::start_google_oauth,
            commands::google::save_google_tokens,
            commands::google::load_google_tokens,
            commands::google::clear_google_tokens,
        ])
        .setup(|app| {
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Kill all rclone serve processes on close
                let state = window.app_handle().state::<ServeProcesses>();
                let mut procs = state.0.lock().unwrap();
                for (_, mut child) in procs.drain() {
                    let _ = child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
