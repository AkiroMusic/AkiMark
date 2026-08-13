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
            highlighter: 10.0,
            eraser: 12.0,
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
    /// 默认画笔工具（pen / highlighter / eraser / …）
    pub default_tool: String,
    /// 默认笔色（hex）
    pub default_color: String,
    /// 是否在启动时打开设置窗口（托盘常驻，设置用完即毁）
    pub open_settings_on_startup: bool,
    /// 导出目录；None = 系统图片目录
    pub export_dir: Option<String>,
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
            export_dir: None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let cfg = AppConfig::default();
        assert_eq!(cfg.shortcuts.toggle_drawing, "Ctrl+Shift+R");
        assert_eq!(cfg.shortcuts.clear_drawing, "Ctrl+Shift+C");
        assert_eq!(cfg.shortcuts.toggle_penetration, "Ctrl+Shift+X");
        assert_eq!(cfg.general.default_tool, "pen");
        assert_eq!(cfg.general.default_color, "#6C8CFF");
        assert_eq!(cfg.general.line_widths.stroke, 3.0);
        assert_eq!(cfg.general.line_widths.highlighter, 10.0);
        assert_eq!(cfg.general.line_widths.eraser, 12.0);
        assert!(cfg.general.open_settings_on_startup);
        assert_eq!(cfg.general.export_dir, None);
    }

    #[test]
    fn serde_roundtrip_keeps_values() {
        let cfg = AppConfig {
            shortcuts: Shortcuts {
                toggle_drawing: "Ctrl+Alt+A".into(),
                clear_drawing: "Ctrl+Alt+C".into(),
                toggle_penetration: "Ctrl+Alt+X".into(),
            },
            general: GeneralConfig {
                default_tool: "highlighter".into(),
                default_color: "#F0A0D8".into(),
                line_widths: LineWidthsConfig {
                    stroke: 5.0,
                    highlighter: 22.0,
                    eraser: 30.0,
                },
                export_dir: Some("D:/Screenshots".into()),
                ..GeneralConfig::default()
            },
        };
        let json = serde_json::to_string(&cfg).unwrap();
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
    }

    #[test]
    fn serde_uses_camel_case_field_names() {
        // 前端契约：camelCase。若字段名回归 snake_case，此测试将失败。
        let cfg = AppConfig::default();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(
            json.contains("\"toggleDrawing\""),
            "缺少 toggleDrawing: {json}"
        );
        assert!(json.contains("\"defaultTool\""), "缺少 defaultTool: {json}");
        assert!(
            json.contains("\"openSettingsOnStartup\""),
            "缺少 openSettingsOnStartup: {json}"
        );
        assert!(
            !json.contains("\"toggle_drawing\""),
            "出现了 snake_case 字段名: {json}"
        );
    }

    #[test]
    fn malformed_json_falls_back_to_defaults() {
        // load_config 需要 AppHandle，这里只验证解析层容错逻辑可复用
        let bad = r#"{ not valid json "#;
        assert!(serde_json::from_str::<AppConfig>(bad).is_err());
        // 缺字段的 JSON → 报错（不会静默产生半初始化配置）
        let partial = r#"{"general":{"locale":"en"}}"#;
        assert!(serde_json::from_str::<AppConfig>(partial).is_err());
    }

    #[test]
    fn partial_update_preserves_other_fields() {
        // 前端 save_general 只传 GeneralConfig，验证结构体语义：直接赋值整个字段
        let mut cfg = AppConfig::default();
        cfg.general = GeneralConfig {
            locale: "en".into(),
            ..GeneralConfig::default()
        };
        // shortcuts 应不受影响
        assert_eq!(cfg.shortcuts.toggle_drawing, "Ctrl+Shift+R");
        assert_eq!(cfg.general.locale, "en");
        assert_eq!(cfg.general.default_tool, "pen");
    }
}
