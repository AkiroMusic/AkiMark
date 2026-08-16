use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::Manager;

/// 简单文件日志：写入 app_log_dir/akimark.log，带时间戳与级别。
/// 同时安装 panic hook，崩溃信息一并落盘，便于事后排查。
pub struct Logger {
    path: Mutex<Option<PathBuf>>,
}

static LOGGER: Logger = Logger {
    path: Mutex::new(None),
};

/// 初始化日志系统：确定日志文件路径并安装 panic hook。
/// 幂等：重复调用只更新路径，不重复安装 hook。
pub fn init(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            let path = dir.join("akimark.log");
            *LOGGER.path.lock().unwrap() = Some(path.clone());
            write_line(&path, &format!("[{}] AkiMark 启动", ts()));
        }
    }

    // panic hook：崩溃信息写入日志（若已安装过则跳过，避免重复包裹）
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("[panic] {info}");
        log(&msg);
        eprintln!("{msg}");
    }));
}

/// 把 `log` crate（tauri 内部）的输出转发到应用日志文件。
/// tauri/tao 的窗口创建错误通过 `log::error!` 记录，若无 logger 会被静默丢弃。
pub fn install_log_facade() {
    static FACADE: FileLogFacade = FileLogFacade;
    let _ = log::set_logger(&FACADE);
    log::set_max_level(log::LevelFilter::Debug);
}

struct FileLogFacade;

impl log::Log for FileLogFacade {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }
    fn log(&self, record: &log::Record) {
        let line = format!("[tauri:{}] {}", record.level(), record.args());
        log(&line);
        eprintln!("{line}");
    }
    fn flush(&self) {}
}

/// 写一条日志（线程安全、追加式）。
pub fn log(msg: &str) {
    let path = LOGGER.path.lock().unwrap().clone();
    if let Some(path) = path {
        write_line(&path, &format!("[{}] {msg}", ts()));
    }
}

fn write_line(path: &PathBuf, line: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 本地时间戳 `YYYY-MM-DD HH:MM:SS`（无 chrono 依赖的简化实现，UTC+8 时区固定计算）。
fn ts() -> String {
    let (y, mo, d, hh, mm, ss) = now_local();
    format!("{y:04}-{mo:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
}

/// 文件名用时间戳 `YYYYMMDD-HHMMSS`。
pub fn ts_for_file() -> String {
    let (y, mo, d, hh, mm, ss) = now_local();
    format!("{y:04}{mo:02}{d:02}-{hh:02}{mm:02}{ss:02}")
}

fn now_local() -> (i64, u32, u32, u64, u64, u64) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 固定 UTC+8
    let local = secs + 8 * 3600;
    let days = local / 86400;
    let rem = local % 86400;
    let (y, mo, d) = civil_from_days(days as i64);
    (y, mo, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Howard Hinnant 的 civil_from_days 算法：天数 → (年, 月, 日)。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}
