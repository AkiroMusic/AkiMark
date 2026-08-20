use tauri::{AppHandle, Manager, State};

use crate::config::{self, AppConfig, GeneralConfig, LineWidthsConfig, Shortcuts};
use crate::error::{AppError, AppResult};
use crate::overlay::{self, AppState, OverlayMode, OVERLAY_LABEL};
use crate::shortcuts;

/// 已知工具集合（与前端 src/constants/tools.ts 的 id 一致）
const KNOWN_TOOLS: &[&str] = &[
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
];

/// 线宽钳制到合理范围（stroke 1-40，highlighter 1-80，eraser 1-120）
fn clamp_line_widths(lw: &mut LineWidthsConfig) {
    lw.stroke = lw.stroke.clamp(1.0, 40.0);
    lw.highlighter = lw.highlighter.clamp(1.0, 80.0);
    lw.eraser = lw.eraser.clamp(1.0, 120.0);
}

/// 后端校验 save_general 的输入：工具集合、线宽范围、导出目录合法性。
fn validate_general(general: &mut GeneralConfig) -> AppResult<()> {
    if !KNOWN_TOOLS.contains(&general.default_tool.as_str()) {
        return Err(AppError::InvalidTool(general.default_tool.clone()));
    }
    clamp_line_widths(&mut general.line_widths);
    if let Some(dir) = &general.export_dir {
        if !dir.trim().is_empty() {
            let p = std::path::Path::new(dir);
            // 拒绝 `..` 组件：防止导出目录逃逸到任意位置
            if p.components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err(AppError::InvalidExportDir(dir.clone()));
            }
            // 拒绝指向已有文件的路径（导出目录必须是目录）
            if p.is_file() {
                return Err(AppError::InvalidExportDir(dir.clone()));
            }
        }
    }
    Ok(())
}

/// 截取光标所在显示器的画面（PNG base64）。
/// 前端会在调用前隐藏工具栏/光标/聚光灯等 UI；本命令负责隐藏 overlay 窗口本身，
/// 确保截到纯净桌面底图，随后合成标注笔画并保存。
#[tauri::command]
pub fn capture_screen(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    // 截屏期间抑制"失焦自动穿透"：隐藏窗口会导致失焦，避免误触发穿透模式。
    // 计数语义：若隐藏/显示期间用户又激活过，短臂复位不会清掉长臂。
    state.arm_activation_guard();

    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    if let Err(e) = window.hide() {
        crate::log::log(&format!("capture_screen: 隐藏窗口失败: {e}"));
    }

    // 给 DWM 一点时间完成隐藏合成，避免截到残留的半透明窗口
    std::thread::sleep(std::time::Duration::from_millis(
        overlay::CAPTURE_HIDE_SETTLE_MS,
    ));
    let result = crate::capture::capture_cursor_monitor_png();

    // 截屏期间用户可能按 Esc 退出（mode=Hidden）：此时不再重新显示窗口，
    // 否则会重新弹出一个卡住的透明窗口。
    let mode = overlay::get_mode(&state);
    if mode == OverlayMode::Hidden {
        crate::log::log("capture_screen: 截屏期间已退出标注模式，不重新显示窗口");
    } else if let Err(e) = window.show() {
        crate::log::log(&format!("capture_screen: 重新显示窗口失败: {e}"));
    }

    // 延迟复位 guard：隐藏→显示的 Focused(false) 事件是异步派发的，
    // 立即复位可能让"失焦自动穿透"误触发。150ms 后窗口已稳定聚焦。
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            overlay::CAPTURE_GUARD_RESET_MS,
        ));
        let state = app_for_thread.state::<AppState>();
        state.disarm_activation_guard();
    });

    result
}

/// 把前端合成好的 PNG（base64）保存到导出目录，返回文件完整路径。
/// 目录优先级：配置的 export_dir → 桌面 → 应用数据目录。
#[tauri::command]
pub fn save_export(
    app: AppHandle,
    state: State<'_, AppState>,
    png_base64: String,
) -> AppResult<String> {
    use base64::Engine;

    // 上限 50MB base64（≈37.5MB PNG）。4K 多屏全屏截图远小于此，
    // 仅拦截异常/恶意超大 payload。
    const MAX_B64_LEN: usize = 50 * 1024 * 1024;
    if png_base64.len() > MAX_B64_LEN {
        return Err(AppError::ExportTooLarge(MAX_B64_LEN));
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|_| AppError::InvalidExportData)?;

    // 配置的导出目录优先；为空则回退桌面目录，再回退应用数据目录
    let configured = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .general
        .export_dir
        .clone();
    let dir = configured
        .filter(|d| !d.trim().is_empty())
        .map(|d| {
            // 规范化：解析相对路径/`..`/多余分隔符，避免写穿到意外位置
            let path = std::path::PathBuf::from(d);
            if path.is_absolute() {
                path
            } else {
                // 相对路径一律以用户主目录为基准解析，防止依赖进程 CWD
                app.path()
                    .home_dir()
                    .map(|home| home.join(&path))
                    .unwrap_or(path)
            }
        })
        .map(Ok)
        .unwrap_or_else(|| {
            app.path()
                .desktop_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
        })?;
    std::fs::create_dir_all(&dir)?;
    // 规范化目录路径：PathBuf 保留 `..`，join 文件名前先解析真实路径，
    // 防止 `..` 组件把文件写到目录之外。
    let dir = std::fs::canonicalize(&dir)?;

    let file_name = format!("AkiMark-{}.png", crate::log::ts_for_file());
    let path = dir.join(file_name);
    std::fs::write(&path, &bytes)?;

    crate::log::log(&format!("导出截图已保存: {}", path.display()));
    // 返回给前端的路径用 to_string_lossy：Windows 上路径几乎总是 UTF-8；
    // 非 UTF-8 路径只会替换为 U+FFFD，不会 panic（仅显示层面失真）。
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

#[tauri::command]
pub fn save_general(
    app: AppHandle,
    state: State<'_, AppState>,
    mut general: GeneralConfig,
) -> AppResult<()> {
    validate_general(&mut general)?;
    let mut config = state.config.lock().unwrap_or_else(|e| e.into_inner());
    config.general = general;
    let config_snapshot = config.clone();
    drop(config);
    config::save_config(&app, &config_snapshot)?;
    config::broadcast_config(&app, &config_snapshot);
    Ok(())
}

/// 保存"上次使用的绘制预设"（工具/颜色/线宽），下次启动沿用。
/// 由 overlay 在用户改动工具/颜色/线宽时（防抖后）调用。
#[tauri::command]
pub fn save_drawing_prefs(
    app: AppHandle,
    state: State<'_, AppState>,
    tool: String,
    color: String,
    mut line_widths: LineWidthsConfig,
) -> AppResult<()> {
    // 后端校验：工具必须在已知集合内，线宽钳制到合理范围
    if !KNOWN_TOOLS.contains(&tool.as_str()) {
        return Err(AppError::InvalidTool(tool));
    }
    clamp_line_widths(&mut line_widths);
    let mut config = state.config.lock().unwrap_or_else(|e| e.into_inner());
    config.general.default_tool = tool;
    config.general.default_color = color;
    config.general.line_widths = line_widths;
    let config_snapshot = config.clone();
    drop(config);
    config::save_config(&app, &config_snapshot)?;
    config::broadcast_config(&app, &config_snapshot);
    Ok(())
}

#[tauri::command]
pub fn save_shortcuts(app: AppHandle, shortcuts: Shortcuts) -> Result<Vec<String>, AppError> {
    shortcuts::save_shortcuts(&app, shortcuts)
}

/// 查询当前注册失败的全局快捷键（被其他程序占用）。
#[tauri::command]
pub fn get_shortcut_conflicts(app: AppHandle) -> Vec<String> {
    shortcuts::get_shortcut_conflicts(&app)
}

#[tauri::command]
pub fn exit_drawing(app: AppHandle, state: State<'_, AppState>) {
    let _ = overlay::deactivate_drawing(&app, &state);
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    crate::open_settings(&app);
}

/// 开机自启动（Windows: HKCU Run 注册表项，后台零进程开销）
///
/// 幂等处理：目标状态已达成时直接返回成功。
/// 关键：auto-launch 的 disable() 会删除注册表值，若该值本就不存在
/// （从未启用过自启动），删除会返回 ERROR_FILE_NOT_FOUND（os error 2），
/// 因此必须先查询 is_enabled() 再决定是否真正执行 enable/disable。
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
    let current = app.autolaunch().is_enabled()?;
    if current == enabled {
        return Ok(());
    }
    if enabled {
        app.autolaunch().enable()?;
    } else {
        app.autolaunch().disable()?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_autostart(app: AppHandle) -> AppResult<bool> {
    use tauri_plugin_autostart::ManagerExt;
    Ok(app.autolaunch().is_enabled()?)
}

#[tauri::command]
pub fn enter_penetration_mode(app: AppHandle, state: State<'_, AppState>) {
    let _ = overlay::enter_penetration_mode(&app, &state);
}

#[tauri::command]
pub fn exit_penetration_mode(app: AppHandle, state: State<'_, AppState>) {
    let _ = overlay::exit_penetration_mode(&app, &state);
}

/// 同步板书模式标志（前端在板书开关时调用）：板书期间穿透不可用，
/// 全局热键/失焦自动穿透/手动切换一律被后端拒绝。
#[tauri::command]
pub fn set_board_active(state: State<'_, AppState>, active: bool) {
    overlay::set_board_active(&state, active);
}

/// 窗口关闭请求：
/// - overlay：阻止销毁，改为隐藏（常驻后台，毫秒级激活的前提）
/// - settings：允许关闭并销毁（用后即毁，不占资源）
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == OVERLAY_LABEL {
            api.prevent_close();
            let _ = window.hide();
        }
        // settings 窗口默认行为：关闭即销毁
    }
}

/// 失焦自动穿透：绘制中失去焦点 → 120ms 后若仍无焦点且非激活保护期，进入穿透模式。
pub fn handle_focus_event(app: &AppHandle, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::Focused(focused) = event else {
        return;
    };
    if *focused {
        return;
    }
    let state = app.state::<AppState>();
    if state.activation_guard_active() {
        return;
    }
    // 板书模式期间禁止失焦自动穿透：板书是"专注书写"场景，
    // 用户点击其他窗口是为了参考而非操作，不应自动把鼠标放行。
    if state.board_active.load(std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    // 应用自己的设置窗口获得焦点不算"失焦"：不触发自动穿透
    if app
        .get_webview_window(crate::SETTINGS_LABEL)
        .is_some_and(|w| w.is_focused().unwrap_or(false))
    {
        return;
    }
    // 单挂起标志：alt-tab 连按只挂起一个穿透线程，避免线程风暴
    if state
        .penetration_pending
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            overlay::AUTO_PENETRATION_DELAY_MS,
        ));
        let state = app.state::<AppState>();
        // 消费挂起标志（允许后续失焦再次挂起）
        state
            .penetration_pending
            .store(false, std::sync::atomic::Ordering::SeqCst);
        // 醒来后重新检查激活保护与板书标志：等待期间可能已重新激活/进入板书
        if state.activation_guard_active() {
            return;
        }
        if state.board_active.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let mode = overlay::get_mode(&state);
        if mode == OverlayMode::Drawing {
            // 确认仍无焦点；查询失败时保守跳过（不进入穿透）
            if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
                match w.is_focused() {
                    Ok(false) => {
                        let _ = overlay::enter_penetration_mode(&app, &state);
                    }
                    Ok(true) => {}
                    Err(e) => {
                        crate::log::log(&format!(
                            "handle_focus_event: is_focused 查询失败，跳过自动穿透: {e}"
                        ));
                    }
                }
            }
        }
    });
}
