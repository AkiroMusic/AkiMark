use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::config::Shortcuts as ShortcutConfig;
use crate::error::{AppError, AppResult};
use crate::overlay::{self, AppState};

/// 注册全部全局快捷键（先注销再注册，支持配置变更）。
/// 单个热键被系统占用时不中断启动，仅打印警告。
pub fn register_shortcuts(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let shortcuts = config.shortcuts;

    // 先注销所有已注册的
    let _ = app.global_shortcut().unregister_all();

    register_one(app, &shortcuts.toggle_drawing, |app, state| {
        overlay::toggle_drawing(app, state)
    });
    register_one(app, &shortcuts.clear_drawing, |app, _state| {
        let _ = app.emit("clear-drawing", true);
    });
    register_one(app, &shortcuts.toggle_penetration, |app, state| {
        overlay::toggle_penetration_mode(app, state)
    });

    Ok(())
}

fn register_one(
    app: &AppHandle,
    accel: &str,
    handler: impl Fn(&AppHandle, &State<'_, AppState>) + Send + Sync + 'static,
) {
    if accel.trim().is_empty() {
        return; // 空 = 未绑定
    }
    let Ok(shortcut) = accel.parse::<Shortcut>() else {
        eprintln!("[akimark] 无效快捷键: {accel}");
        return;
    };

    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let state = app.state::<AppState>();
                handler(app, &state);
            }
        });
    if let Err(e) = result {
        eprintln!("[akimark] 注册快捷键 {accel} 失败（可能被其他程序占用）: {e}");
    }
}

/// 从配置重新注册（保存快捷键后调用）。
pub fn reapply_shortcuts(app: &AppHandle) -> AppResult<()> {
    register_shortcuts(app)
}

/// 校验快捷键字符串可解析（保存前校验）。
pub fn validate_shortcut(accel: &str) -> AppResult<()> {
    if accel.trim().is_empty() {
        return Ok(());
    }
    accel
        .parse::<Shortcut>()
        .map_err(|_| AppError::InvalidShortcut(accel.into()))?;
    Ok(())
}

/// 保存快捷键并重注册。
pub fn save_shortcuts(app: &AppHandle, shortcuts: ShortcutConfig) -> AppResult<()> {
    // 校验全部
    validate_shortcut(&shortcuts.toggle_drawing)?;
    validate_shortcut(&shortcuts.clear_drawing)?;
    validate_shortcut(&shortcuts.toggle_penetration)?;

    let state = app.state::<AppState>();
    {
        let mut config = state.config.lock().unwrap();
        config.shortcuts = shortcuts.clone();
    }
    let config = state.config.lock().unwrap().clone();
    crate::config::save_config(app, &config)?;
    reapply_shortcuts(app)?;
    Ok(())
}
