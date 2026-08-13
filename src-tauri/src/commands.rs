use tauri::{AppHandle, Manager, State};

use crate::config::{self, AppConfig, GeneralConfig, LineWidthsConfig, Shortcuts};
use crate::error::{AppError, AppResult};
use crate::overlay::{self, AppState, OVERLAY_LABEL};
use crate::shortcuts;

/// 截取光标所在显示器的画面（PNG base64）。
/// 前端会在调用前隐藏工具栏/光标/聚光灯等 UI；本命令负责隐藏 overlay 窗口本身，
/// 确保截到纯净桌面底图，随后合成标注笔画并保存。
#[tauri::command]
pub fn capture_screen(app: AppHandle, state: State<'_, AppState>) -> AppResult<String> {
    // 截屏期间抑制"失焦自动穿透"：隐藏窗口会导致失焦，避免误触发穿透模式。
    // 用代际计数：若隐藏/显示期间用户又激活过（代际增大），150ms 复位自动失效，
    // 避免清掉更新的激活保护。
    let gen = state.arm_activation_guard();

    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    let _ = window.hide();

    // 给 DWM 一点时间完成隐藏合成，避免截到残留的半透明窗口
    std::thread::sleep(std::time::Duration::from_millis(80));
    let result = crate::capture::capture_cursor_monitor_png();

    let _ = window.show();

    // 延迟复位 guard：隐藏→显示的 Focused(false) 事件是异步派发的，
    // 立即复位可能让"失焦自动穿透"误触发。150ms 后窗口已稳定聚焦。
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        let state = app_for_thread.state::<AppState>();
        state.disarm_activation_guard(gen);
    });

    result
}

/// 把前端合成好的 PNG（base64）保存到导出目录，返回文件完整路径。
/// 目录优先级：配置的 export_dir → 系统图片目录 → 应用数据目录。
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

    // 配置的导出目录优先；为空则回退系统图片目录，再回退应用数据目录
    let configured = state.config.lock().unwrap().general.export_dir.clone();
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
                .picture_dir()
                .or_else(|_| app.path().app_data_dir())
                .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
        })?;
    std::fs::create_dir_all(&dir)?;

    let file_name = format!("AkiMark-{}.png", crate::log::ts_for_file());
    let path = dir.join(file_name);
    std::fs::write(&path, &bytes)?;

    crate::log::log(&format!("导出截图已保存: {}", path.display()));
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_general(
    app: AppHandle,
    state: State<'_, AppState>,
    general: GeneralConfig,
) -> AppResult<()> {
    let mut config = state.config.lock().unwrap();
    config.general = general;
    let config_snapshot = config.clone();
    drop(config);
    config::save_config(&app, &config_snapshot)?;
    config::broadcast_config(&app, &config_snapshot);
    Ok(())
}

#[tauri::command]
pub fn save_line_widths(
    app: AppHandle,
    state: State<'_, AppState>,
    line_widths: LineWidthsConfig,
) -> AppResult<()> {
    let mut config = state.config.lock().unwrap();
    config.general.line_widths = line_widths;
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
    line_widths: LineWidthsConfig,
) -> AppResult<()> {
    let mut config = state.config.lock().unwrap();
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
pub fn save_locale(app: AppHandle, state: State<'_, AppState>, locale: String) -> AppResult<()> {
    let mut config = state.config.lock().unwrap();
    config.general.locale = locale;
    let config_snapshot = config.clone();
    drop(config);
    config::save_config(&app, &config_snapshot)?;
    config::broadcast_config(&app, &config_snapshot);
    Ok(())
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
#[tauri::command]
pub fn set_autostart(app: AppHandle, enabled: bool) -> AppResult<()> {
    use tauri_plugin_autostart::ManagerExt;
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

#[tauri::command]
pub fn toggle_penetration_mode(app: AppHandle, state: State<'_, AppState>) {
    overlay::toggle_penetration_mode(&app, &state);
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
    if state
        .activation_guard
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return;
    }

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let state = app.state::<AppState>();
        let mode = overlay::get_mode(&state);
        if mode == overlay::OverlayMode::Drawing {
            // 确认仍无焦点
            if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
                if !w.is_focused().unwrap_or(false) {
                    let _ = overlay::enter_penetration_mode(&app, &state);
                }
            }
        }
    });
}
