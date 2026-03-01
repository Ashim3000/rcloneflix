// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Force XWayland on Wayland compositors so VLC's set_xwindow() works on both
    // X11 and Wayland. GDK_BACKEND=x11 must be set before GTK initialises.
    #[cfg(target_os = "linux")]
    if std::env::var("WAYLAND_DISPLAY").is_ok() {
        std::env::set_var("GDK_BACKEND", "x11");
    }

    rcloneflix_lib::run();
}
