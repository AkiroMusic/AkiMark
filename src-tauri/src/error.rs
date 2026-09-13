use std::sync::atomic::{AtomicBool, Ordering};
use thiserror::Error;

/// 面向前端的错误文案语言：true = 英文，false = 中文（日志/Display 恒中文）。
/// 启动时按 config.general.locale 设置，save_general 成功后同步更新。
static ERROR_LOCALE_EN: AtomicBool = AtomicBool::new(false);

/// 设置面向前端的错误文案语言（config.general.locale → en/zh-CN）
pub fn set_error_locale(locale: &str) {
    let en = locale.eq_ignore_ascii_case("en");
    ERROR_LOCALE_EN.store(en, Ordering::SeqCst);
}

fn error_locale_en() -> bool {
    ERROR_LOCALE_EN.load(Ordering::SeqCst)
}

#[derive(Debug, Error)]
pub enum AppError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Serde(#[from] serde_json::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error("窗口不存在: {0}")]
    WindowNotFound(String),
    #[error("无效的快捷键: {0}")]
    InvalidShortcut(String),
    #[error(transparent)]
    Shortcut(#[from] tauri_plugin_global_shortcut::Error),
    #[error(transparent)]
    Autostart(#[from] tauri_plugin_autostart::Error),
    #[error("截图失败")]
    CaptureFailed,
    /// 非 Windows 平台的截屏/导出路径使用（Windows 构建中视为未用）
    #[allow(dead_code)]
    #[error("当前平台不支持该功能")]
    UnsupportedPlatform,
    #[error("无效的导出数据")]
    InvalidExportData,
    /// 导出 payload 超过上限（base64 字符串过大，通常是异常/恶意调用）
    #[error("导出数据过大（上限 {0} 字节）")]
    ExportTooLarge(usize),
    /// 导出目录非法（含 `..` 组件或指向已有文件）
    #[error("无效的导出目录: {0}")]
    InvalidExportDir(String),
    /// 未知的绘制工具
    #[error("无效的工具: {0}")]
    InvalidTool(String),
    /// 同一集合内重复的快捷键绑定
    #[error("重复的快捷键: {0}")]
    DuplicateShortcut(String),
    /// 剪贴板写入失败（插件错误）
    #[error("写入剪贴板失败: {0}")]
    Clipboard(String),
}

/// 面向前端的双语文案（Display 恒中文供日志；Serialize 按当前 locale 输出）
impl AppError {
    fn localized(&self) -> String {
        if !error_locale_en() {
            return self.to_string();
        }
        match self {
            AppError::Io(e) => format!("I/O error: {e}"),
            AppError::Serde(e) => format!("Data error: {e}"),
            AppError::Tauri(e) => format!("App error: {e}"),
            AppError::WindowNotFound(w) => format!("Window not found: {w}"),
            AppError::InvalidShortcut(s) => format!("Invalid shortcut: {s}"),
            AppError::Shortcut(e) => format!("Shortcut error: {e}"),
            AppError::Autostart(e) => format!("Autostart error: {e}"),
            AppError::CaptureFailed => "Screen capture failed".into(),
            AppError::UnsupportedPlatform => {
                "This feature is not supported on this platform".into()
            }
            AppError::InvalidExportData => "Invalid export data".into(),
            AppError::ExportTooLarge(n) => format!("Export data too large (limit {n} bytes)"),
            AppError::InvalidExportDir(d) => format!("Invalid export folder: {d}"),
            AppError::InvalidTool(t) => format!("Invalid tool: {t}"),
            AppError::DuplicateShortcut(s) => format!("Duplicate shortcut: {s}"),
            AppError::Clipboard(e) => format!("Failed to write to clipboard: {e}"),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.localized())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localized_switches_with_locale() {
        let err = AppError::CaptureFailed;
        assert_eq!(err.to_string(), "截图失败");
        set_error_locale("en");
        assert_eq!(err.localized(), "Screen capture failed");
        set_error_locale("zh-CN");
        assert_eq!(err.localized(), "截图失败");
    }

    #[test]
    fn dynamic_variants_localize() {
        let err = AppError::InvalidTool("bogus".into());
        set_error_locale("en");
        assert_eq!(err.localized(), "Invalid tool: bogus");
        set_error_locale("zh-CN");
        assert_eq!(err.localized(), "无效的工具: bogus");
    }
}
