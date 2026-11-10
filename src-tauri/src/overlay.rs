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
    /// 兼容性说明：新版 Rust 将 AtomicU32::fetch_update 更名为 try_update
    ///（旧名 deprecated，CI -D warnings 下视为错误），旧工具链（< 更名版本）
    /// 尚无 try_update。两端兼容的做法：保留旧名 + allow(deprecated)，
    /// 待最低工具链跨过更名版本后改名并移除 allow。
    #[allow(deprecated)]
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

pub fn get_mode(state: &State<'_, AppState>) -> OverlayMode {
    *state.mode.lock().unwrap_or_else(|e| e.into_inner())
}

/// 转换核心约定：调用方已持有 `state.mode` 锁，临界区覆盖从第一个窗口 API
/// 到模式提交、事件广播的**完整系统状态转换**。锁内只做窗口查找、窗口 API、
/// Win32 调用、日志与 emit——不回调本项目代码、不二次加锁（emit 是异步广播，
/// 前端事件处理器里的 invoke 会排队等锁，不阻塞）。事件在提交后、锁释放前
/// 发出：事件顺序 = 提交顺序，先完成的转换不会被后完成者的迟到事件覆盖。
///
/// 此前 activate 全程无锁、toggle 在锁外读模式再分发、exit 的光标钳制与事件
/// 落在锁外：并发交错可造成"后端模式、窗口实际行为、前端状态"三方不一致
///（三轮审查 P1-01）。
///
/// 并发测试边界：tauri 窗口 API 无法在单测中 mock（需 trait 抽象大重构），
/// 交错正确性由"单锁贯穿 + 判定在锁内"的结构性保证 + 真机 QA 覆盖。
///
/// 进入绘制模式核心：定位 → 置顶 → 可交互 → 显示 → 聚焦 → 钳制 → 提交。
fn activate_drawing_locked(app: &AppHandle, m: &mut OverlayMode) -> AppResult<()> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;

    // Windows 快速路径：一次性 SetWindowPos 定位 + 置顶；失败回退 Tauri API。
    // 光标钳制推迟到 show/set_focus 全部成功之后执行（见下）：
    // 若在定位阶段就 ClipCursor，激活序列任一步失败（? 提前返回）会留下
    // "光标被钳制但窗口不可见、模式仍是 Hidden"的卡死态。
    #[cfg(target_os = "windows")]
    let clip_rect: Option<(i32, i32, u32, u32)> = {
        match window.hwnd() {
            Ok(hwnd) => match win32::get_cursor_monitor_rect() {
                Some((x, y, w, h)) => {
                    if win32::position_window_on_monitor(hwnd.0, x, y, w, h) {
                        Some((x, y, w, h))
                    } else {
                        crate::log::log(
                            "activate_drawing: position_window_on_monitor 失败，回退 Tauri API",
                        );
                        fallback_position(&window);
                        None
                    }
                }
                None => {
                    crate::log::log(
                        "activate_drawing: get_cursor_monitor_rect 失败，回退 Tauri API",
                    );
                    fallback_position(&window);
                    None
                }
            },
            Err(e) => {
                crate::log::log(&format!(
                    "activate_drawing: hwnd() 失败: {e}，回退 Tauri API"
                ));
                fallback_position(&window);
                None
            }
        }
    };

    window.set_always_on_top(true)?;
    window.set_ignore_cursor_events(false)?;
    window.show()?;
    if let Err(e) = window.set_focus() {
        // 部分失败回滚：窗口已可见但无法聚焦，尽力恢复一致的 Hidden 形态
        //（模式保持 Hidden；本函数尚未执行 ClipCursor，故不调 release_cursor
        // ——ClipCursor(NULL) 会误清其他程序设置的钳制）
        let _ = window.hide();
        let _ = window.set_ignore_cursor_events(true);
        crate::log::log(&format!(
            "activate_drawing: set_focus 失败，已回滚隐藏: {e}"
        ));
        return Err(e.into());
    }

    // 窗口已可见且聚焦，此时钳制光标才安全（见上）
    #[cfg(target_os = "windows")]
    if let Some((x, y, w, h)) = clip_rect {
        win32::clip_cursor(x, y, w, h);
    }

    *m = OverlayMode::Drawing;
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

/// 退出绘制模式：隐藏窗口、释放光标限制（模式锁贯穿完整转换）。
pub fn deactivate_drawing(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
    deactivate_drawing_locked(app, state, &mut m)
}

/// 退出绘制模式核心（锁已持有）。
fn deactivate_drawing_locked(
    app: &AppHandle,
    state: &State<'_, AppState>,
    m: &mut OverlayMode,
) -> AppResult<()> {
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;

    window.set_ignore_cursor_events(true)?;
    if let Err(e) = window.hide() {
        // 部分失败回滚：窗口已置穿透但仍在屏上，尽力恢复可交互；
        // 模式保持 Drawing，与窗口实际状态一致，错误传回调用方
        let _ = window.set_ignore_cursor_events(false);
        crate::log::log(&format!("deactivate_drawing: hide 失败，已恢复可交互: {e}"));
        return Err(e.into());
    }
    // 隐藏成功后才释放光标钳制：失败早退时钳制保持原状
    #[cfg(target_os = "windows")]
    win32::release_cursor();
    *m = OverlayMode::Hidden;
    // 离开绘制模式即结束板书模式（webview 重载后前端标志可能丢失，后端兜底复位）。
    // 直接写原子量：set_board_active 也取模式锁，锁内不得再入。
    state.board_active.store(false, Ordering::SeqCst);
    let _ = app.emit("overlay-mode-changed", "hidden");
    Ok(())
}

/// 切换标注模式（全局热键入口）。判定与执行在同一临界区内：
/// 两次并发 toggle 不可能都读到 Hidden 而双双执行 activate。
pub fn toggle_drawing(app: &AppHandle, state: &State<'_, AppState>) {
    let result = {
        let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
        match *m {
            OverlayMode::Hidden => {
                // 激活保护窗口：600ms 内忽略失焦自动穿透。
                // 计数语义：若期间 capture_screen 又置位过，短臂复位不会清掉本臂。
                // （持锁 spawn 是安全的：延迟线程 600ms 后才 disarm，不取模式锁）
                state.arm_activation_guard();
                let app_for_thread = app.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(ACTIVATION_GUARD_MS));
                    let state = app_for_thread.state::<AppState>();
                    state.disarm_activation_guard();
                });
                activate_drawing_locked(app, &mut m)
            }
            _ => deactivate_drawing_locked(app, state, &mut m),
        }
    };
    if let Err(e) = result {
        crate::log::log(&format!("toggle_drawing 失败: {e}"));
    }
}

/// 进入穿透模式：标注保留可见，鼠标事件穿透到下方应用。
pub fn enter_penetration_mode(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
    enter_penetration_locked(app, state, &mut m)
}

/// 进入穿透核心（锁已持有）：检查-执行-提交原子化。
/// 持锁跨 OS 调用是安全的：锁内只做窗口查找与 Win32 风格切换，
/// 不会回调本项目代码、不会二次加锁。
/// 此前"先提交 Penetration 再执行 OS 操作"在 set_ignore_cursor_events
/// 失败时会把模式卡死在 Penetration（窗口实际仍拦截鼠标）。
fn enter_penetration_locked(
    app: &AppHandle,
    state: &State<'_, AppState>,
    m: &mut OverlayMode,
) -> AppResult<()> {
    // 幂等：已在穿透模式 / 隐藏状态直接返回
    if *m == OverlayMode::Penetration || *m == OverlayMode::Hidden {
        return Ok(());
    }
    // 板书模式期间穿透不可用：手动切换、全局热键、失焦自动穿透统一拒绝。
    // board_active 的写入方（set_board_active）同样持有模式锁，此检查-执行
    // 与板书置位作为两个业务转换互斥（三轮审查 P2-01）。
    if state.board_active.load(Ordering::SeqCst) {
        // 通知前端弹提示（前端自身也会在板书模式下拦截 X/M 快捷键，这里兜底热键/自动穿透路径）
        let _ = app.emit("penetration-blocked", ());
        return Ok(());
    }
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    // 失败时经 `?` 返回：锁随调用方释放，模式保持 Drawing，
    // 错误传回调用方（前端据此回滚乐观状态）
    window.set_ignore_cursor_events(true)?;
    // OS 切换成功后再释放光标钳制：此前先释放后切换，切换失败会留下
    // "模式仍是 Drawing 但光标钳制已丢"的中间态（无需回滚逻辑）
    #[cfg(target_os = "windows")]
    win32::release_cursor();
    *m = OverlayMode::Penetration;
    let _ = app.emit("overlay-mode-changed", "penetration");
    Ok(())
}

/// 退出穿透模式，回到绘制。
pub fn exit_penetration_mode(app: &AppHandle, state: &State<'_, AppState>) -> AppResult<()> {
    let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
    exit_penetration_locked(app, &mut m)
}

/// 退出穿透核心（锁已持有）：可交互 → 提交 → 钳制 → 广播全部在同一临界区。
/// 此前光标钳制与事件在锁外执行：与并发的进入穿透交错会留下"后端已穿透、
/// 光标却被重新钳制、前端收到迟到 drawing-return"的三方不一致
///（三轮审查 P1-01A）。
fn exit_penetration_locked(app: &AppHandle, m: &mut OverlayMode) -> AppResult<()> {
    // 幂等：隐藏状态无需退出穿透
    if *m == OverlayMode::Hidden {
        return Ok(());
    }
    let window = app
        .get_webview_window(OVERLAY_LABEL)
        .ok_or(crate::error::AppError::WindowNotFound(OVERLAY_LABEL.into()))?;
    window.set_ignore_cursor_events(false)?;
    *m = OverlayMode::Drawing;
    // 回到绘制模式：重新限制光标到 overlay 窗口（画布）所在显示器。
    // 不能按光标所在屏钳制：穿透期间光标可能已移到其他显示器，
    // 钳在光标屏会把用户困在没有画布的屏上（点击无响应）。
    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = window.hwnd() {
        if let Some((x, y, w, h)) = win32::get_window_monitor_rect(hwnd.0) {
            win32::clip_cursor(x, y, w, h);
        }
    }
    // 用独立事件值：前端据此保留已有笔迹（区别于从隐藏激活的 "drawing"）
    let _ = app.emit("overlay-mode-changed", "drawing-return");
    Ok(())
}

/// 切换穿透模式（全局热键入口）。判定与执行在同一临界区内，
/// 与 toggle_drawing 同理避免锁外读-判-行竞态。
pub fn toggle_penetration_mode(app: &AppHandle, state: &State<'_, AppState>) {
    let result = {
        let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
        match *m {
            OverlayMode::Penetration => exit_penetration_locked(app, &mut m),
            OverlayMode::Drawing => enter_penetration_locked(app, state, &mut m),
            _ => Ok(()),
        }
    };
    if let Err(e) = result {
        crate::log::log(&format!("toggle_penetration 失败: {e}"));
    }
}

/// 同步板书模式标志（前端在板书开关时调用）：板书期间穿透不可用。
/// 与模式转换共用同一把模式锁：板书置位与"进入穿透"作为两个业务状态
/// 转换互斥——若并发交错使带锁的进入穿透在标志置位前读取，此处收尾保证
/// `board_active=true` 与 `OverlayMode::Penetration` 不会同时成立
///（原子退出穿透后再置位，三轮审查 P2-01）。
/// 退出穿透失败时整体失败且标志不提交（四轮审查 P2-01），错误传回前端。
pub fn set_board_active(
    app: &AppHandle,
    state: &State<'_, AppState>,
    active: bool,
) -> AppResult<()> {
    let mut m = state.mode.lock().unwrap_or_else(|e| e.into_inner());
    set_board_active_locked(&mut m, &state.board_active, active, |m| {
        exit_penetration_locked(app, m)
    })
}

/// 板书置位协调核心（纯逻辑，测试可注入退出穿透闭包，无需 mock tauri）。
/// 置位 true 且已处于穿透时先原子退出穿透：退出失败则整体失败，
/// 板书标志不得提交（否则 `board_active=true ∧ Penetration` 同时成立，
/// 与 enter_penetration_locked 的拒绝检查合起来构成完整互斥）。
fn set_board_active_locked(
    mode: &mut OverlayMode,
    board_active: &AtomicBool,
    active: bool,
    exit_penetration: impl FnOnce(&mut OverlayMode) -> AppResult<()>,
) -> AppResult<()> {
    if active && *mode == OverlayMode::Penetration {
        exit_penetration(mode)?;
    }
    board_active.store(active, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;

    #[test]
    fn board_activation_requires_penetration_exit_success() {
        // 置位板书时已处于穿透：退出穿透失败 → 整体失败，
        // 模式保持 Penetration、标志不得提交（board_active=true ∧
        // Penetration 不得同时成立，四轮审查 P2-01）
        let mode = &mut OverlayMode::Penetration;
        let flag = AtomicBool::new(false);
        let err = set_board_active_locked(mode, &flag, true, |_| Err(AppError::CaptureFailed));
        assert!(err.is_err(), "退出穿透失败应整体失败");
        assert_eq!(*mode, OverlayMode::Penetration, "模式不得被改动");
        assert!(!flag.load(Ordering::SeqCst), "失败时标志不得置位");

        // 成功路径：模式先转为 Drawing，标志才置位
        set_board_active_locked(mode, &flag, true, |m| {
            *m = OverlayMode::Drawing;
            Ok(())
        })
        .unwrap();
        assert_eq!(*mode, OverlayMode::Drawing);
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn board_deactivation_does_not_attempt_penetration_exit() {
        // 退板书（active=false）与穿透无交互：不触发退出穿透闭包，
        // 仅复位标志（后端竞态下退板书到达时可能已是 Penetration）
        let mode = &mut OverlayMode::Penetration;
        let flag = AtomicBool::new(true);
        set_board_active_locked(mode, &flag, false, |_| -> AppResult<()> {
            panic!("deactivate 不应触发退出穿透");
        })
        .unwrap();
        assert!(!flag.load(Ordering::SeqCst));
        assert_eq!(*mode, OverlayMode::Penetration);
    }

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
