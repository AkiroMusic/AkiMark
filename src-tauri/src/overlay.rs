use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

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

/// 激活保护时长：激活后这段时间内忽略失焦自动穿透（ms）
pub const ACTIVATION_GUARD_MS: u64 = 600;
/// 截屏隐藏窗口后等待 DWM 完成合成的时长（ms）
pub const CAPTURE_HIDE_SETTLE_MS: u64 = 80;
/// 截屏后延迟复位激活保护的时长（ms）
pub const CAPTURE_GUARD_RESET_MS: u64 = 150;
/// 失焦后自动穿透的延迟（ms）
pub const AUTO_PENETRATION_DELAY_MS: u64 = 120;

/// 应用级可变状态
pub struct AppState {
    pub config: Mutex<AppConfig>,
    pub mode: Mutex<OverlayMode>,
    /// 激活保护：激活后一小段时间内，工具栏抢焦点不触发自动穿透。
    /// 用活跃臂计数器实现：arm 时 +1，disarm 时 -1，>0 即激活。
    /// 计数语义保证短臂复位不会清掉长臂（旧 bool+代际方案存在此缺陷）。
    pub activation_guard: Arc<AtomicU32>,
    /// 板书模式激活中（前端在板书开关时同步）：板书期间穿透不可用，
    /// 手动切换、全局热键、失焦自动穿透一律拒绝。
    pub board_active: Arc<AtomicBool>,
    /// 失焦自动穿透线程是否已挂起（防 alt-tab 连按导致线程风暴）
    pub penetration_pending: Arc<AtomicBool>,
    /// 当前注册失败的全局快捷键（被其他程序占用）
    pub shortcut_conflicts: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new(config: AppConfig) -> Self {
        Self {
            config: Mutex::new(config),
            mode: Mutex::new(OverlayMode::Hidden),
            activation_guard: Arc::new(AtomicU32::new(0)),
            board_active: Arc::new(AtomicBool::new(false)),
            penetration_pending: Arc::new(AtomicBool::new(false)),
            shortcut_conflicts: Mutex::new(Vec::new()),
        }
    }

    /// 置位激活保护（活跃臂 +1）。可重叠：多次置位需对应多次复位。
    pub fn arm_activation_guard(&self) {
        self.activation_guard.fetch_add(1, Ordering::SeqCst);
    }

    /// 复位激活保护（活跃臂 -1，饱和到 0，不会下溢）。
    pub fn disarm_activation_guard(&self) {
        let _ = self
            .activation_guard
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| {
                if v > 0 {
                    Some(v - 1)
                } else {
                    None
                }
            });
    }

    /// 激活保护是否生效（活跃臂 > 0）。
    pub fn activation_guard_active(&self) -> bool {
        self.activation_guard.load(Ordering::SeqCst) > 0
    }
}

pub const OVERLAY_LABEL: &str = "overlay";

pub fn set_mode(state: &State<'_, AppState>, mode: OverlayMode) {
    let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
    *m = mode;
}

pub fn get_mode(state: &State<'_, AppState>) -> OverlayMode {
    *state.mode.lock().unwrap_or_else(|e| e.into_inner())
}

/// 进入绘制模式：把 overlay 窗口贴到光标所在显示器，显示并聚焦。
pub fn activate_drawing(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;

    // 激活保护窗口：600ms 内忽略失焦自动穿透。
    // 计数语义：若期间 capture_screen 又置位过，短臂复位不会清掉本臂。
    state.arm_activation_guard();
    let app_for_thread = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(ACTIVATION_GUARD_MS));
        let state = app_for_thread.state::<AppState>();
        state.disarm_activation_guard();
    });

    // Windows 快速路径：一次性 SetWindowPos 定位 + 置顶；失败回退 Tauri API
    #[cfg(target_os = "windows")]
    {
        match window.hwnd() {
            Ok(hwnd) => match win32::get_cursor_monitor_rect() {
                Some((x, y, w, h)) => {
                    if win32::position_window_on_monitor(hwnd.0, x, y, w, h) {
                        win32::clip_cursor(x, y, w, h);
                    } else {
                        crate::log::log(
                            "activate_drawing: position_window_on_monitor 失败，回退 Tauri API",
                        );
                        fallback_position(&window);
                    }
                }
                None => {
                    crate::log::log(
                        "activate_drawing: get_cursor_monitor_rect 失败，回退 Tauri API",
                    );
                    fallback_position(&window);
                }
            },
            Err(e) => {
                crate::log::log(&format!(
                    "activate_drawing: hwnd() 失败: {e}，回退 Tauri API"
                ));
                fallback_position(&window);
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

/// Tauri API 兜底定位：把窗口移到当前显示器并铺满（Win32 快速路径失败时）。
fn fallback_position(window: &tauri::WebviewWindow) {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let pos = monitor.position();
    let size = monitor.size();
    if let Err(e) = window.set_position(tauri::PhysicalPosition::new(pos.x, pos.y)) {
        crate::log::log(&format!("activate_drawing: set_position 回退失败: {e}"));
    }
    if let Err(e) = window.set_size(tauri::PhysicalSize::new(size.width, size.height)) {
        crate::log::log(&format!("activate_drawing: set_size 回退失败: {e}"));
    }
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
    // 离开绘制模式即结束板书模式（webview 重载后前端标志可能丢失，后端兜底复位）
    state.board_active.store(false, Ordering::SeqCst);
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
    // 检查-设置原子化（持模式锁），并保证幂等：已在穿透模式直接返回。
    let blocked = {
        let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
        if *m == OverlayMode::Penetration {
            return Ok(());
        }
        if *m == OverlayMode::Hidden {
            return Ok(());
        }
        // 板书模式期间穿透不可用：手动切换、全局热键、失焦自动穿透统一拒绝。
        let blocked = state.board_active.load(Ordering::SeqCst);
        if !blocked {
            *m = OverlayMode::Penetration;
        }
        blocked
    };
    if blocked {
        // 通知前端弹提示（前端自身也会在板书模式下拦截 X/M 快捷键，这里兜底热键/自动穿透路径）
        let _ = app.emit("penetration-blocked", ());
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    win32::release_cursor();

    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    window.set_ignore_cursor_events(true)?;
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
    // 回到绘制模式：重新限制光标到当前显示器（穿透期间光标可能已移出）
    #[cfg(target_os = "windows")]
    if let Ok(_hwnd) = window.hwnd() {
        if let Some((x, y, w, h)) = win32::get_cursor_monitor_rect() {
            win32::clip_cursor(x, y, w, h);
        }
    }
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

/// 同步板书模式标志（前端在板书开关时调用）：板书期间穿透不可用。
pub fn set_board_active(state: &State<'_, AppState>, active: bool) {
    state.board_active.store(active, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activation_guard_counter_overlap() {
        // 长臂（600ms）先置位，短臂（150ms）后置位：
        // 短臂复位不得清掉长臂，全部复位后才解除。
        let state = AppState::new(AppConfig::default());
        state.arm_activation_guard();
        state.arm_activation_guard();
        state.disarm_activation_guard();
        assert!(
            state.activation_guard_active(),
            "短臂复位不应清掉长臂的激活保护"
        );
        state.disarm_activation_guard();
        assert!(!state.activation_guard_active());
    }

    #[test]
    fn activation_guard_disarm_below_zero_is_saturated() {
        // 未置位就复位：不得下溢成负数（否则会永久激活）
        let state = AppState::new(AppConfig::default());
        state.disarm_activation_guard();
        assert!(!state.activation_guard_active());
        state.arm_activation_guard();
        state.disarm_activation_guard();
        state.disarm_activation_guard(); // 多复位一次：仍为 0
        assert!(!state.activation_guard_active());
    }
}
