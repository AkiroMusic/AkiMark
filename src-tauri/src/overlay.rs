use tauri::{AppHandle, Emitter, Manager, State};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crate::config::AppConfig;
use crate::error::AppResult;
use crate::win32;

/// 覆盖层模式状态机：Hidden → Drawing → Penetration
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlayMode {
    Hidden,
    Drawing,
    Penetration,
}

/// 应用级可变状态
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub mode: Mutex<OverlayMode>,
    /// 激活保护：激活后一小段时间内，工具栏抢焦点不触发自动穿透
    pub activation_guard: Arc<AtomicBool>,
    /// 当前注册失败的全局快捷键（被其他程序占用）
    pub shortcut_conflicts: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config: Mutex::new(config),
            mode: Mutex::new(OverlayMode::Hidden),
            activation_guard: Arc::new(AtomicBool::new(false)),
            shortcut_conflicts: Mutex::new(Vec::new()),
        }
    }
}

pub const OVERLAY_LABEL: &str = "overlay";

pub fn set_mode(state: &State<'_, AppState>, mode: OverlayMode) {
    let mut m = state.mode.lock().unwrap();
    *m = mode;
}

pub fn get_mode(state: &State<'_, AppState>) -> OverlayMode {
    *state.mode.lock().unwrap()
}

/// 进入绘制模式：把 overlay 窗口贴到光标所在显示器，显示并聚焦。
pub fn activate_drawing(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;

    // 激活保护窗口：600ms 内忽略失焦自动穿透
    state.activation_guard.store(true, Ordering::SeqCst);
    let guard = state.activation_guard.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(600));
        guard.store(false, Ordering::SeqCst);
    });

    // Windows 快速路径：一次性 SetWindowPos 定位 + 置顶
    #[cfg(target_os = "windows")]
    {
        if let Ok(hwnd) = window.hwnd() {
            if let Some((x, y, w, h)) = win32::get_cursor_monitor_rect() {
                win32::position_window_on_monitor(hwnd.0, x, y, w, h);
                win32::clip_cursor(x, y, w, h);
            }
        }
    }

    window.set_always_on_top(true)?;
    window.set_ignore_cursor_events(false)?;
    window.show()?;
    window.set_focus()?;

    set_mode(state, OverlayMode::Drawing);

    let _ = app.emit("overlay-mode-changed", "drawing");
    Ok(())
}

/// 退出绘制模式：隐藏窗口、释放光标限制。
pub fn deactivate_drawing(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    #[cfg(target_os = "windows")]
    win32::release_cursor();

    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;

    window.set_ignore_cursor_events(true)?;
    window.hide()?;
    set_mode(state, OverlayMode::Hidden);
    let _ = app.emit("overlay-mode-changed", "hidden");
    Ok(())
}

/// 切换标注模式（全局热键入口）。
pub fn toggle_drawing(app: &AppHandle, state: &State<'_, AppState>) {
    let result = match get_mode(state) {
        OverlayMode::Hidden => activate_drawing(app, state),
        _ => deactivate_drawing(app, state),
    };
    if let Err(e) = result {
        eprintln!("[akimark] toggle_drawing 失败: {e}");
    }
}

/// 进入穿透模式：标注保留可见，鼠标事件穿透到下方应用。
pub fn enter_penetration_mode(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    if get_mode(state) == OverlayMode::Hidden {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    win32::release_cursor();

    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    window.set_ignore_cursor_events(true)?;
    set_mode(state, OverlayMode::Penetration);
    let _ = app.emit("overlay-mode-changed", "penetration");
    Ok(())
}

/// 退出穿透模式，回到绘制。
pub fn exit_penetration_mode(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    if get_mode(state) == OverlayMode::Hidden {
        return Ok(());
    }
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    window.set_ignore_cursor_events(false)?;
    set_mode(state, OverlayMode::Drawing);
    // 用独立事件值：前端据此保留已有笔迹（区别于从隐藏激活的 "drawing"）
    let _ = app.emit("overlay-mode-changed", "drawing-return");
    Ok(())
}

pub fn toggle_penetration_mode(app: &AppHandle, state: &State<'_, AppState>) {
    let result = match get_mode(state) {
        OverlayMode::Penetration => exit_penetration_mode(app, state),
        OverlayMode::Drawing => enter_penetration_mode(app, state),
        _ => Ok(()),
    };
    if let Err(e) = result {
        eprintln!("[akimark] toggle_penetration 失败: {e}");
    }
}
