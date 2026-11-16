//! Application logging.
//!
//! Everything — Rust and frontend alike — lands in one newline-delimited file
//! under the app data dir, so a bug report is a single attachment rather than a
//! reconstruction from memory. The frontend forwards through the `log_message`
//! command so its errors interleave with backend events in real time order.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// Roll the log over at this size so it can't grow without bound.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone)]
pub struct Logger {
    path: PathBuf,
    file: Arc<Mutex<Option<File>>>,
}

pub static GLOBAL_LOGGER: OnceLock<Logger> = OnceLock::new();

struct StandardLogBridge;

impl log::Log for StandardLogBridge {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        if let Some(logger) = GLOBAL_LOGGER.get() {
            let level = match record.level() {
                log::Level::Error => "error",
                log::Level::Warn => "warn",
                log::Level::Info => "info",
                log::Level::Debug => "debug",
                log::Level::Trace => "trace",
            };
            logger.log(level, record.target(), &format!("{}", record.args()));
        }
    }

    fn flush(&self) {
        if let Some(logger) = GLOBAL_LOGGER.get() {
            let mut guard = logger.file.lock().unwrap();
            if let Some(file) = guard.as_mut() {
                let _ = file.flush();
            }
        }
    }
}

static BRIDGE: StandardLogBridge = StandardLogBridge;

impl Logger {
    pub fn new(log_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&log_dir);
        let path = log_dir.join("rcloneflix.log");
        let logger = Logger {
            path: path.clone(),
            file: Arc::new(Mutex::new(None)),
        };
        logger.rotate_if_needed();
        logger.open();
        let _ = GLOBAL_LOGGER.set(logger.clone());
        let _ = log::set_logger(&BRIDGE);
        log::set_max_level(log::LevelFilter::Debug);
        logger
    }

    fn open(&self) {
        let handle = OpenOptions::new().create(true).append(true).open(&self.path);
        if let Ok(f) = handle {
            *self.file.lock().unwrap() = Some(f);
        }
    }

    fn rotate_if_needed(&self) {
        if let Ok(meta) = fs::metadata(&self.path) {
            if meta.len() > MAX_LOG_BYTES {
                let old = self.path.with_extension("log.1");
                let _ = fs::rename(&self.path, old);
            }
        }
    }

    pub fn log(&self, level: &str, target: &str, message: &str) {
        let line = format!(
            "{} {:<5} [{}] {}\n",
            now_iso8601(),
            level.to_uppercase(),
            target,
            message
        );

        // Mirror to stderr so `rcloneflix` from a terminal shows live output.
        eprint!("{}", line);

        let mut guard = self.file.lock().unwrap();
        if let Some(file) = guard.as_mut() {
            let _ = file.write_all(line.as_bytes());
            let _ = file.flush();
        }
    }

    pub fn path(&self) -> &PathBuf {
        &self.path
    }
}

/// Timestamp without pulling in `chrono` — seconds precision is plenty here.
fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Civil-from-days (Howard Hinnant's algorithm).
    let days = (secs / 86_400) as i64;
    let tod = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        tod / 3600,
        (tod % 3600) / 60,
        tod % 60
    )
}

/// Log from anywhere with an `AppHandle`.
pub fn log(app: &AppHandle, level: &str, target: &str, message: impl AsRef<str>) {
    if let Some(logger) = GLOBAL_LOGGER.get() {
        logger.log(level, target, message.as_ref());
    } else if let Some(logger) = app.try_state::<Logger>() {
        logger.log(level, target, message.as_ref());
    }
}

#[macro_export]
macro_rules! log_info {
    ($app:expr, $target:expr, $($arg:tt)*) => {
        $crate::logging::log($app, "info", $target, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($app:expr, $target:expr, $($arg:tt)*) => {
        $crate::logging::log($app, "warn", $target, format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($app:expr, $target:expr, $($arg:tt)*) => {
        $crate::logging::log($app, "error", $target, format!($($arg)*))
    };
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Frontend log bridge.
#[tauri::command]
pub fn log_message(app: AppHandle, level: String, target: String, message: String) {
    log(&app, &level, &target, message);
}

#[tauri::command]
pub fn get_log_path(app: AppHandle) -> Result<String, String> {
    let logger = app
        .try_state::<Logger>()
        .ok_or_else(|| "Logger not initialised".to_string())?;
    Ok(logger.path().to_string_lossy().into_owned())
}

/// Return the tail of the log for the diagnostics panel.
#[tauri::command]
pub fn read_log_tail(app: AppHandle, lines: usize) -> Result<String, String> {
    let logger = app
        .try_state::<Logger>()
        .ok_or_else(|| "Logger not initialised".to_string())?;
    let file = File::open(logger.path()).map_err(|e| format!("Cannot read log: {}", e))?;
    let all: Vec<String> = BufReader::new(file).lines().map_while(Result::ok).collect();
    let start = all.len().saturating_sub(lines.clamp(1, 5000));
    Ok(all[start..].join("\n"))
}
