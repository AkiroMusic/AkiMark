use std::sync::atomic::{AtomicU32, Ordering};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tauri::Manager;

use crate::error::AppResult;

/// 已知工具集合（与前端 src/constants/tools.ts 的 id 一致）
pub const KNOWN_TOOLS: &[&str] = &[
    "pen",
    "fading",
    "highlighter",
    "eraser",
    "line",
    "rect",
    "circle",
    "arrow",
    "text",
    "blur",
    "counter",
];

/// 线宽钳制到合理范围（stroke 1-40，highlighter 1-80，eraser 1-120）。
/// 非 finite 值先回退默认：JSON 本身编码不了 NaN/Inf（serde_json 会直接
/// 拒绝），此处是防御性兜底——f64::clamp 对 NaN 返回 NaN，不设防会穿透。
pub fn clamp_line_widths(lw: &mut LineWidthsConfig) {
    if !lw.stroke.is_finite() {
        lw.stroke = 3.0;
    }
    if !lw.highlighter.is_finite() {
        lw.highlighter = 10.0;
    }
    if !lw.eraser.is_finite() {
        lw.eraser = 12.0;
    }
    lw.stroke = lw.stroke.clamp(1.0, 40.0);
    lw.highlighter = lw.highlighter.clamp(1.0, 80.0);
    lw.eraser = lw.eraser.clamp(1.0, 120.0);
}

/// 线宽配置（按工具分组）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
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
#[serde(rename_all = "camelCase", default)]
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
#[serde(rename_all = "camelCase", default)]
pub struct GeneralConfig {
    pub locale: String,
    pub preserve_drawings: bool,
    pub line_widths: LineWidthsConfig,
    /// 默认画笔工具（pen / highlighter / eraser / …）
    pub default_tool: String,
    /// 默认笔色（hex）
    pub default_color: String,
    /// 默认板书底色（white / black，对应白板 / 黑板模式）
    pub board_default: String,
    /// 最近使用的自定义颜色（工具栏取色器加入，最多 4 个，hex）
    pub recent_colors: Vec<String>,
    /// 是否在启动时打开设置窗口（托盘常驻，设置用完即毁）
    pub open_settings_on_startup: bool,
    /// 导出目录；None = 桌面
    pub export_dir: Option<String>,
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            locale: "zh-CN".into(),
            preserve_drawings: false,
            line_widths: LineWidthsConfig::default(),
            default_tool: "pen".into(),
            default_color: "#6C8CFF".into(),
            board_default: "white".into(),
            recent_colors: Vec::new(),
            open_settings_on_startup: true,
            export_dir: None,
        }
    }
}

/// 顶层配置
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub shortcuts: Shortcuts,
    pub general: GeneralConfig,
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
                // serde 只保证类型正确，不校验业务取值（手改的 defaultTool 等
                // 非法字符串照样解析成功）→ 字段级归一，非法值回退默认
                Ok(mut cfg) => {
                    normalize_config(&mut cfg);
                    cfg
                }
                Err(e) => {
                    // 配置损坏：先把原文件改名留证（.bak），再回退默认值。
                    // 否则下次 save_config 会直接用默认配置覆盖，用户再无找回机会。
                    let bak = path.with_extension("json.bak");
                    match std::fs::rename(&path, &bak) {
                        Ok(()) => {
                            eprintln!(
                                "[akimark] config.json 解析失败，已备份到 {} 并回退默认值: {e}",
                                bak.display()
                            );
                        }
                        Err(re) => {
                            eprintln!(
                                "[akimark] config.json 解析失败且回退默认值（备份失败: {re}）: {e}"
                            );
                        }
                    }
                    AppConfig::default()
                }
            },
            Err(e) => {
                eprintln!("[akimark] config.json 读取失败，使用默认值: {e}");
                AppConfig::default()
            }
        },
        Err(e) => {
            eprintln!("[akimark] config 路径获取失败，使用默认值: {e}");
            AppConfig::default()
        }
    }
}

pub fn save_config(app: &tauri::AppHandle, config: &AppConfig) -> AppResult<()> {
    let path = config_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let content = serde_json::to_string_pretty(config)?;
    // 原子写入：先写临时文件再 rename，避免写入中途崩溃损坏配置。
    // 临时名带进程 id + 进程内自增序号：两个窗口并发保存时共用一个固定
    // tmp 名会互相覆盖（A 写 tmp → B 覆写 tmp → A rename 成功 → B rename
    // 找不到 tmp）。当前所有保存命令都在主线程串行执行，并发是理论场景，
    // 唯一后缀让正确性不依赖这一隐式事实。
    static TMP_SEQ: AtomicU32 = AtomicU32::new(0);
    let tmp = path.with_extension(format!(
        "json.tmp.{}.{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// 严格 HEX 颜色校验：仅 #RGB / #RRGGBB / #RRGGBBAA
pub fn is_hex_color(s: &str) -> bool {
    matches!(s.len(), 4 | 7 | 9)
        && s.starts_with('#')
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// 业务字段级修复（不含 defaultTool——它由调用方按场景决定报错还是回退）。
/// 两个消费方：normalize_config（启动加载，静默回退）与 validate_general
///（保存入口，工具字段报错后其余字段同样修复）。
pub fn normalize_general_fields(g: &mut GeneralConfig) {
    if !is_hex_color(&g.default_color) {
        g.default_color = "#6C8CFF".into();
    }
    if g.board_default != "white" && g.board_default != "black" {
        g.board_default = "white".into();
    }
    if g.locale != "zh-CN" && g.locale != "en" {
        g.locale = "zh-CN".into();
    }
    clamp_line_widths(&mut g.line_widths);
    g.recent_colors = g
        .recent_colors
        .drain(..)
        .filter(|c| is_hex_color(c))
        .map(|c| c.chars().take(32).collect::<String>())
        .take(4)
        .collect();
}

/// 手改配置的字段级归一：非法值回退默认，而不是丢掉整份配置。
/// load_config 反序列化成功后调用。
pub fn normalize_config(cfg: &mut AppConfig) {
    let g = &mut cfg.general;
    if !KNOWN_TOOLS.contains(&g.default_tool.as_str()) {
        g.default_tool = "pen".into();
    }
    normalize_general_fields(g);
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
        assert_eq!(cfg.general.board_default, "white");
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
                board_default: "black".into(),
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
            json.contains("\"boardDefault\""),
            "缺少 boardDefault: {json}"
        );
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
    }

    #[test]
    fn missing_fields_merge_with_defaults() {
        // 缺字段的 JSON → 用默认值补齐（serde(default)），已提供的字段保留
        let partial = r#"{"general":{"locale":"en"}}"#;
        let cfg: AppConfig = serde_json::from_str(partial).unwrap();
        assert_eq!(cfg.general.locale, "en");
        assert_eq!(cfg.general.default_tool, "pen");
        assert_eq!(cfg.general.line_widths.stroke, 3.0);
        assert_eq!(cfg.shortcuts.toggle_drawing, "Ctrl+Shift+R");
    }

    #[test]
    fn config_with_one_field_removed_still_loads() {
        // 从完整配置中删掉 lineWidths 字段：仍能加载，缺失字段用默认值
        let json = r##"{
            "shortcuts": {"toggleDrawing": "Ctrl+Alt+A", "clearDrawing": "Ctrl+Shift+C", "togglePenetration": "Ctrl+Shift+X"},
            "general": {"locale": "en", "theme": "dark", "preserveDrawings": false, "defaultTool": "pen", "defaultColor": "#6C8CFF", "boardDefault": "white", "openSettingsOnStartup": true, "exportDir": null}
        }"##;
        let cfg: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.shortcuts.toggle_drawing, "Ctrl+Alt+A");
        assert_eq!(cfg.general.locale, "en");
        assert_eq!(cfg.general.line_widths.stroke, 3.0);
        assert_eq!(cfg.general.line_widths.highlighter, 10.0);
    }

    #[test]
    fn partial_update_preserves_other_fields() {
        // 前端 save_general 只传 GeneralConfig，验证结构体语义：直接赋值整个字段
        let cfg = AppConfig {
            general: GeneralConfig {
                locale: "en".into(),
                ..GeneralConfig::default()
            },
            ..AppConfig::default()
        };
        // shortcuts 应不受影响
        assert_eq!(cfg.shortcuts.toggle_drawing, "Ctrl+Shift+R");
        assert_eq!(cfg.general.locale, "en");
        assert_eq!(cfg.general.default_tool, "pen");
        assert_eq!(cfg.general.board_default, "white");
    }

    #[test]
    fn normalize_repairs_invalid_fields() {
        // 手改配置的非法业务值：字段级回退默认，合法字段保留
        let json = r##"{"general":{"defaultTool":"bogus","boardDefault":"purple","locale":"fr","defaultColor":"notahex","recentColors":["#abc","zzz","#123456"]}}"##;
        let mut cfg: AppConfig = serde_json::from_str(json).unwrap();
        normalize_config(&mut cfg);
        assert_eq!(cfg.general.default_tool, "pen");
        assert_eq!(cfg.general.board_default, "white");
        assert_eq!(cfg.general.locale, "zh-CN");
        assert_eq!(cfg.general.default_color, "#6C8CFF");
        assert_eq!(cfg.general.recent_colors, vec!["#abc", "#123456"]);
    }

    #[test]
    fn normalize_keeps_valid_fields() {
        let mut cfg = AppConfig::default();
        cfg.general.default_tool = "highlighter".into();
        cfg.general.locale = "en".into();
        normalize_config(&mut cfg);
        assert_eq!(cfg.general.default_tool, "highlighter");
        assert_eq!(cfg.general.locale, "en");
        assert_eq!(cfg.general.line_widths.stroke, 3.0);
    }

    #[test]
    fn normalize_clamps_out_of_range_widths() {
        let mut cfg = AppConfig::default();
        cfg.general.line_widths.stroke = 999.0;
        cfg.general.line_widths.eraser = -5.0;
        normalize_config(&mut cfg);
        assert_eq!(cfg.general.line_widths.stroke, 40.0);
        assert_eq!(cfg.general.line_widths.eraser, 1.0);
    }

    #[test]
    fn hex_color_validation_bounds() {
        assert!(is_hex_color("#abc"));
        assert!(is_hex_color("#6C8CFF"));
        assert!(is_hex_color("#6C8CFFAA"));
        assert!(!is_hex_color("6C8CFF")); // 缺 #
        assert!(!is_hex_color("#"));
        assert!(!is_hex_color("#zzzzzz")); // 非 hex 字符
        assert!(!is_hex_color("#12345")); // 非法长度（5）
        assert!(!is_hex_color("#1234567")); // 非法长度（7 位数字）
        assert!(!is_hex_color("#123456789")); // 非法长度（9 位数字）
    }

    #[test]
    fn normalize_general_fields_repairs_without_tool() {
        // 与 normalize_config 共用的字段修复：defaultTool 之外的字段
        let mut cfg = AppConfig::default();
        cfg.general.default_tool = "pen".into(); // 调用方负责工具字段
        cfg.general.default_color = "notahex".into();
        cfg.general.board_default = "purple".into();
        cfg.general.locale = "fr".into();
        cfg.general.recent_colors = vec!["#abc".into(), "zzz".into()];
        normalize_general_fields(&mut cfg.general);
        assert_eq!(cfg.general.default_tool, "pen");
        assert_eq!(cfg.general.default_color, "#6C8CFF");
        assert_eq!(cfg.general.board_default, "white");
        assert_eq!(cfg.general.locale, "zh-CN");
        assert_eq!(cfg.general.recent_colors, vec!["#abc"]);
    }
}
