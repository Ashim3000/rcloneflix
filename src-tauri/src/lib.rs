mod commands;
pub mod logging;
pub mod process_ext;

use commands::player::VlcManager;
use logging::Logger;
use commands::library_db::LibraryDb;
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
            // Logging first: everything after this point can report failures.
            let log_dir = app
                .path()
                .app_log_dir()
                .or_else(|_| app.path().app_data_dir())
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            let logger = Logger::new(log_dir);
            logger.log(
                "info",
                "startup",
                &format!("RcloneFlix {} starting", env!("CARGO_PKG_VERSION")),
            );
            app.manage(logger);

            // Point VLC at bundled plugins when running from a packaged release.
            // On a plain install the system path is fine; this only overrides when the
            // bundled directory actually exists (i.e. we shipped it).
            if let Ok(resource_dir) = app.path().resource_dir() {
                let bundled_plugins = if cfg!(target_os = "windows") {
                    resource_dir.join("plugins")
                } else {
                    resource_dir.join("vlc/plugins")
                };
                if bundled_plugins.exists() {
                    // SAFETY: called in setup before worker threads start
                    unsafe { std::env::set_var("VLC_PLUGIN_PATH", bundled_plugins) };
                }
            }


            match LibraryDb::new(app.handle()) {
                Ok(db) => {
                    app.manage(db);
                    logging::log(app.handle(), "info", "startup", "library.db ready");
                }
                Err(e) => logging::log(
                    app.handle(),
                    "error",
                    "startup",
                    format!("library.db unavailable: {}", e),
                ),
            }

            let vlc = VlcManager::new(app.handle().clone());
            app.manage(vlc);
            let dlna = commands::dlna::DlnaManager::new();
            app.manage(dlna);
            let cast = commands::cast::CastManager::new();
            app.manage(cast);

            // Auto-start stream proxy (port 8552) and pre-hydrate engines
            tauri::async_runtime::spawn(async {
                let _ = commands::stream_proxy::get_or_start_proxy_server().await;
                let _ = commands::telegram::get_engine();
                let _ = commands::usenet_dav::get_usenet_engine();
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Tauri does not drop managed state on exit, so the rclone serve
            // daemons must be reaped explicitly or they outlive the app.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    if let Some(vlc) = window.app_handle().try_state::<VlcManager>() {
                        vlc.shutdown_all();
                    }
                    if let Some(dlna) = window.app_handle().try_state::<commands::dlna::DlnaManager>() {
                        dlna.stop();
                    }
                    let _ = tauri::async_runtime::block_on(commands::alist::stop_alist_server());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::rclone::parse_rclone_config,
            commands::rclone::list_remote_path,
            commands::rclone::get_rclone_version,
            commands::rclone::rclone_create_crypt_remote,
            commands::rclone::rclone_create_webdav_remote,
            commands::rclone::rclone_merge_scoped_config,
            commands::rclone::rclone_apply_admin_config,
            commands::rclone::rclone_remove_scoped_remotes,
            commands::rclone::rclone_rename_file,
            commands::rclone::rclone_copy_file,
            commands::rclone::rclone_delete_item,
            commands::rclone::generate_cloudflare_stream_link,
            commands::rclone::get_rclone_link,
            commands::rclone::list_mounted_remotes,
            commands::rclone::mount_remote,
            commands::rclone::unmount_remote,
            commands::archive::extract_archive,
            commands::archive::extract_remote_archive_to_remote,
            commands::archive::extract_comic_pages,
            commands::archive::fetch_remote_comic_manifest,
            commands::archive::fetch_remote_comic_page,
            commands::archive::fetch_remote_comic_cover,
            commands::archive::start_progressive_comic_download,
            commands::archive::comic_progressive_status,
            commands::archive::cancel_progressive_comic,
            logging::log_message,
            logging::get_log_path,
            logging::read_log_tail,
            commands::rclone_sync::rclone_write_backup,
            commands::rclone_sync::rclone_read_backup,
            commands::rclone_sync::rclone_read_bytes,
            commands::rclone_sync::rclone_mkdir,
            commands::rclone_sync::rclone_upload_file,
            commands::rclone_sync::rclone_upload_bytes,
            commands::rclone_sync::read_local_file_bytes,
            commands::rclone_sync::write_local_file_bytes,
            commands::rclone_sync::list_local_image_files,
            commands::rclone_sync::arweave_post_data_item,
            commands::rclone_sync::arweave_fetch_bytes,
            commands::rclone_sync::compress_photo_vault,
            commands::rclone_sync::open_external_url,
            commands::artwork::cache_artwork,
            commands::artwork::cached_artwork_path,
            commands::artwork::artwork_cache_stats,
            commands::artwork::clear_artwork_cache,
            commands::artwork::get_cached_vault_photo,
            commands::artwork::save_cached_vault_photo,
            commands::artwork::clear_vault_photo_cache,
            commands::artwork::vault_photo_cache_stats,
            commands::artwork::generate_screencap,
            commands::vault_crypto::prepare_vault_photo,
            commands::vault_crypto::batch_prepare_vault_photos,
            commands::library_db::library_load_all,
            commands::library_db::library_upsert_items,
            commands::library_db::library_remove_items,
            commands::library_db::library_clear_library,
            commands::library_db::library_set_progress,
            commands::library_db::library_remove_progress,
            commands::library_db::library_upsert_playlists,
            commands::library_db::library_remove_playlists,
            commands::library_db::library_set_favorites,
            commands::library_db::library_remove_favorites,
            commands::library_db::library_migration_done,
            commands::library_db::library_mark_migrated,
            commands::library_db::library_count,
            commands::store::save_api_keys,
            commands::store::load_api_keys,
            commands::store::save_rclone_config_content,
            commands::store::load_rclone_config_content,
            commands::store::save_rclone_settings,
            commands::store::load_rclone_settings,
            commands::scan::scan_library_files,
            commands::scan::parse_media_filename,
            commands::scan::hash_remote_path,
            commands::player::open_media,
            commands::player::open_local_media,
            commands::player::start_stream_session,
            commands::player::start_local_file_stream,
            commands::player::player_play,
            commands::player::player_pause,
            commands::player::player_seek,
            commands::player::player_set_volume,
            commands::player::player_stop,
            commands::player::player_set_audio_track,
            commands::player::player_set_subtitle_track,
            commands::player::player_get_tracks,
            commands::player::stop_stream_session,
            commands::player::stop_all_sessions,
            commands::player::get_media_info,
            commands::player::get_audio_chapters,
            commands::player::detect_audio_silences,
            commands::player::convert_audiobook_m4b_local,
            commands::player::check_ffmpeg_installed,
            commands::player::local_transcode_video,
            commands::player::check_fuse_path,
            commands::player::download_book_to_temp,
            commands::player::read_binary_file,
            commands::player::cleanup_book_temp,
            commands::google::start_google_oauth,
            commands::google::save_google_tokens,
            commands::google::load_google_tokens,
            commands::google::clear_google_tokens,
            commands::download::start_download,
            commands::download::start_folder_download,
            commands::download::get_default_download_dir,
            commands::download::open_download_folder,
            commands::download::find_downloaded_file,
            commands::download::download_web_stream,
            commands::stream_ingest::fetch_web_stream_info,
            commands::stream_ingest::resolve_web_stream_url,
            commands::stream_ingest::crawl_website_releases,
            commands::stream_ingest::search_iheart_radio,
            commands::stream_ingest::search_jiosaavn_streams,
            commands::stream_ingest::search_streamed_sports,
            commands::stream_ingest::search_libgen_books,
            commands::stream_ingest::search_comics_portal,
            commands::stream_ingest::extract_comic_issue_pages,
            commands::stream_ingest::get_cinextream_payload,
            commands::kaggle::save_kaggle_credentials,
            commands::kaggle::load_kaggle_credentials,
            commands::kaggle::import_kaggle_json,
            commands::kaggle::test_kaggle_connection,
            commands::kaggle::dispatch_kaggle_transcode,
            commands::kaggle::dispatch_kaggle_transfer,
            commands::kaggle::dispatch_kaggle_align,
            commands::kaggle::dispatch_kaggle_rd_seed,
            commands::kaggle::get_kaggle_transcode_status,
            commands::kaggle::get_kaggle_transcode_output,
            commands::iptv::fetch_iptv_playlist,
            commands::iptv::check_xtream_account,
            commands::stream_proxy::get_stream_proxy_url,
            commands::stream_proxy::dropmb_sign_in,
            commands::stream_proxy::dropmb_create_share,
            commands::stream_proxy::dropmb_upload_chunk,
            commands::stream_proxy::dropmb_complete_share,
            commands::dlna::start_dlna_server,
            commands::dlna::stop_dlna_server,
            commands::dlna::get_dlna_status,
            commands::dlna::get_tailscale_status,
            commands::dlna::get_tailscale_routes,
            commands::dlna::set_tailscale_serve,
            commands::dlna::set_tailscale_funnel,
            commands::dlna::reset_tailscale_routes,
            commands::cast::discover_cast_devices,
            commands::cast::connect_cast_device,
            commands::cast::disconnect_cast_device,
            commands::cast::cast_load_media,
            commands::cast::cast_control,
            commands::cast::get_cast_status,
            commands::alist::start_alist_daemon,
            commands::alist::stop_alist_daemon,
            commands::alist::get_alist_status,
            commands::alist::configure_streamtape,
            commands::telegram::telegram_configure_and_connect,
            commands::telegram::telegram_get_status,
            commands::telegram::telegram_request_user_code,
            commands::telegram::telegram_sign_in_user,
            commands::telegram::telegram_sync_index,
            commands::telegram::telegram_resolve_source_entries,
            commands::telegram::telegram_upload_local_file,
            commands::telegram::telegram_get_desktop_status,
            commands::telegram::telegram_import_desktop_app,
            commands::usenet_dav::search_usenet_indexers,
            commands::usenet_dav::parse_nzb_media_files,
            commands::usenet_dav::usenet_get_status,
            commands::usenet_dav::usenet_get_config,
            commands::catbox::catbox_upload_file,
            commands::fingerprint::compute_remote_oshash,
            commands::fingerprint::compute_remote_phash,
            commands::usenet_dav::usenet_save_config,
            commands::usenet_dav::usenet_test_connection,
            commands::usenet_dav::usenet_mount_remote,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
