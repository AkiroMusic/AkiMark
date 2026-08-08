use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;

use crate::error::AppResult;

/// 线宽配置（按工具分组）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LineWidthsConfig {
    pub stroke: f64,
    pub highlighter: f64,
    pub eraser: f64,
}

impl Default for LineWidthsConfig {
    fn default() -> Self {
        Self {
            stroke: 3.0,
            highlighter: 18.0,
            eraser: 24.0,
        }
    }
}

/// 全局快捷键
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shortcuts {
    pub toggle_drawing: String,
    pub clear_drawing: String,
    pub toggle_penetration: String,
}

impl Default for Shortcuts {
    fn default() -> Self {
        Self {
            toggle_drawing: "Ctrl+Shift+R".into(),
            clear_drawing: "Ctrl+Shift+C".into(),
            toggle_penetration: "Ctrl+Shift+X".into(),
        }
    }
}

/// 常规设置
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneralConfig {
    pub locale: String,
    pub theme: String,
    pub preserve_drawings: bool,
    pub line_widths: LineWidthsConfig,
    /// 默认画笔工具（pen / highlighter / eraser）
    pub default_tool: String,
    /// 默认笔色（hex）
    pub default_color: String,
    /// 是否在启动时打开设置窗口（托盘常驻，设置用完即毁）
    pub open_settings_on_startup: bool,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            locale: "zh-CN".into(),
            theme: "dark".into(),
            preserve_drawings: false,
            line_widths: LineWidthsConfig::default(),
            default_tool: "pen".into(),
            default_color: "#6C8CFF".into(),
            open_settings_on_startup: true,
        }
    }
}

/// 顶层配置
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub shortcuts: Shortcuts,
    pub general: GeneralConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            shortcuts: Shortcuts::default(),
            general: GeneralConfig::default(),
        }
    }
}

/// 配置存取：JSON 文件，位于应用配置目录。
pub fn config_path(app: &tauri::AppHandle) -> AppResult<std::path::PathBuf> {
    let dir = app.path().app_config_dir()?;
    Ok(dir.join("config.json"))
}

pub fn load_config(app: &tauri::AppHandle) -> AppConfig {
    match config_path(app) {
        Ok(path) => match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<AppConfig>(&content) {
                Ok(cfg) => cfg,
                Err(e) => {
                    eprintln!("[akimark] config.json 解析失败，使用默认值: {e}");
                    AppConfig::default()
                }
            },
            Err(_) => AppConfig::default(),
        },
        Err(_) => AppConfig::default(),
    }
}

pub fn save_config(app: &tauri::AppHandle, config: &AppConfig) -> AppResult<()> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let content = serde_json::to_string_pretty(config)?;
    std::fs::write(&path, content)?;
    Ok(())
}

/// 广播配置变更给所有窗口
pub fn broadcast_config(app: &tauri::AppHandle, config: &AppConfig) {
    let _ = app.emit("config-changed", config.clone());
}
