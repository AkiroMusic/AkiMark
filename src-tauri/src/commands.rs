use tauri::{AppHandle, Manager, State};

use crate::config::{self, AppConfig, GeneralConfig, LineWidthsConfig, Shortcuts};
use crate::error::{AppError, AppResult};
use crate::overlay::{self, AppState, OVERLAY_LABEL};
use crate::shortcuts;

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

#[tauri::command]
pub fn save_shortcuts(
    app: AppHandle,
    shortcuts: Shortcuts,
) -> Result<Vec<String>, AppError> {
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
    if state.activation_guard.load(std::sync::atomic::Ordering::SeqCst) {
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
