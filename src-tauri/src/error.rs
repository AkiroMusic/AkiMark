use thiserror::Error;

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
}

pub type AppResult<T> = Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
