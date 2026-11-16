// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Force XWayland on Wayland compositors so VLC's set_xwindow() works on both
    // X11 and Wayland. GDK_BACKEND=x11 must be set before GTK initialises.
    #[cfg(target_os = "linux")]
    {
        if std::env::var("WAYLAND_DISPLAY").is_ok() {
            // SAFETY: called before any threads are spawned (before GTK/Tauri init)
            unsafe {
                std::env::set_var("GDK_BACKEND", "x11");
                if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
                    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
                }
            };
        }
        if std::env::var("GTK_THEME").is_err() {
            unsafe { std::env::set_var("GTK_THEME", "Adwaita:dark") };
        }
    }

    rcloneflix_lib::run();
}
