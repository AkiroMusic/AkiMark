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
