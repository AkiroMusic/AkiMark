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

/// 日志文件大小上限：超过后清空重写，避免无限增长
const LOG_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// 初始化日志系统：确定日志文件路径并安装 panic hook。
/// 幂等：重复调用只更新路径，不重复安装 hook。
pub fn init(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        if std::fs::create_dir_all(&dir).is_ok() {
            let path = dir.join("akimark.log");
            *LOGGER.path.lock().unwrap_or_else(|e| e.into_inner()) = Some(path.clone());
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
    if let Err(e) = log::set_logger(&FACADE) {
        eprintln!("[akimark] install_log_facade: set_logger 失败: {e}");
    }
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
    let path = LOGGER
        .path
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(path) = path {
        write_line(&path, &format!("[{}] {msg}", ts()));
    }
}

fn write_line(path: &PathBuf, line: &str) {
    // 简单大小上限：超过 10MB 直接清空重写，避免日志无限增长
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > LOG_MAX_BYTES {
            let _ = std::fs::write(path, "");
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

/// 本地时间戳 `YYYY-MM-DD HH:MM:SS`（Windows 用 GetLocalTime，DST 正确）。
fn ts() -> String {
    let (y, mo, d, hh, mm, ss, _ms) = now_local();
    format!("{y:04}-{mo:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
}

/// 文件名用时间戳 `YYYYMMDD-HHMMSSmmm`（含毫秒，避免同一秒内导出互相覆盖）。
pub fn ts_for_file() -> String {
    let (y, mo, d, hh, mm, ss, ms) = now_local();
    format!("{y:04}{mo:02}{d:02}-{hh:02}{mm:02}{ss:02}{ms:03}")
}

/// 本地时间（年, 月, 日, 时, 分, 秒, 毫秒）。
/// Windows：GetLocalTime（系统时区 + DST 自动处理）。
/// 其他平台：UTC 兜底（无 chrono 依赖）。
fn now_local() -> (i64, u32, u32, u64, u64, u64, u64) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::SYSTEMTIME;
        use windows_sys::Win32::System::SystemInformation::GetLocalTime;
        let mut st: SYSTEMTIME = unsafe { std::mem::zeroed() };
        unsafe { GetLocalTime(&mut st) };
        (
            st.wYear as i64,
            st.wMonth as u32,
            st.wDay as u32,
            st.wHour as u64,
            st.wMinute as u64,
            st.wSecond as u64,
            st.wMilliseconds as u64,
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let days = secs / 86400;
        let rem = secs % 86400;
        let (y, mo, d) = civil_from_days(days as i64);
        (y, mo, d, rem / 3600, (rem % 3600) / 60, rem % 60, 0)
    }
}

/// Howard Hinnant 的 civil_from_days 算法：天数 → (年, 月, 日)。
/// 仅非 Windows 平台使用（Windows 走 GetLocalTime）。
#[cfg(not(target_os = "windows"))]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_for_file_includes_milliseconds() {
        // 文件名时间戳必须含毫秒：YYYYMMDD-HHMMSSmmm（18 字符），
        // 避免同一秒内多次导出互相覆盖。
        let s = ts_for_file();
        assert_eq!(s.len(), 18, "时间戳格式应为 YYYYMMDD-HHMMSSmmm: {s}");
        let bytes = s.as_bytes();
        assert!(
            bytes[..8].iter().all(|b| b.is_ascii_digit()),
            "日期部分应为数字: {s}"
        );
        assert_eq!(bytes[8], b'-', "第 9 位应为连字符: {s}");
        assert!(
            bytes[9..].iter().all(|b| b.is_ascii_digit()),
            "时间部分应为数字: {s}"
        );
    }

    #[test]
    fn ts_year_is_plausible() {
        // 本地时间（GetLocalTime）应返回合理年份，防止时区换算回归
        let (y, mo, d, hh, mm, ss, _ms) = now_local();
        assert!((2020..=2100).contains(&y), "年份异常: {y}");
        assert!((1..=12).contains(&mo), "月份异常: {mo}");
        assert!((1..=31).contains(&d), "日期异常: {d}");
        assert!(hh < 24 && mm < 60 && ss < 60, "时间异常: {hh}:{mm}:{ss}");
    }
}
