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

/// 注册单个快捷键，返回是否成功（用于保存时判断冲突）。
fn register_one(
    app: &AppHandle,
    accel: &str,
    handler: impl Fn(&AppHandle, &State<'_, AppState>) + Send + Sync + 'static,
) -> bool {
    if accel.trim().is_empty() {
        return true; // 空 = 未绑定，不算冲突
    }
    let Ok(shortcut) = accel.parse::<Shortcut>() else {
        eprintln!("[akimark] 无效快捷键: {accel}");
        return false;
    };

    let result = app
        .global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                let state = app.state::<AppState>();
                handler(app, &state);
            }
        });
    match result {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[akimark] 注册快捷键 {accel} 失败（可能被其他程序占用）: {e}");
            false
        }
    }
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

/// 保存快捷键并重注册；返回注册失败的快捷键列表（被其他程序占用）。
/// 失败的快捷键不会写入配置，其余正常生效。
pub fn save_shortcuts(app: &AppHandle, shortcuts: ShortcutConfig) -> AppResult<Vec<String>> {
    // 校验全部
    validate_shortcut(&shortcuts.toggle_drawing)?;
    validate_shortcut(&shortcuts.clear_drawing)?;
    validate_shortcut(&shortcuts.toggle_penetration)?;

    let state = app.state::<AppState>();
    let mut config = state.config.lock().unwrap();

    // 尝试注册：先注销旧的，再逐个注册新的
    let _ = app.global_shortcut().unregister_all();

    let mut conflicts: Vec<String> = Vec::new();
    let mut ok_drawing = register_one(app, &shortcuts.toggle_drawing, |app, state| {
        overlay::toggle_drawing(app, state)
    });
    let ok_clear = register_one(app, &shortcuts.clear_drawing, |app, _state| {
        let _ = app.emit("clear-drawing", true);
    });
    let ok_penetration = register_one(app, &shortcuts.toggle_penetration, |app, state| {
        overlay::toggle_penetration_mode(app, state)
    });

    if !ok_drawing {
        conflicts.push(shortcuts.toggle_drawing.clone());
        // 尝试回退到旧值
        let old = &config.shortcuts.toggle_drawing;
        if old != &shortcuts.toggle_drawing {
            ok_drawing = register_one(app, old, |app, state| {
                overlay::toggle_drawing(app, state)
            });
        }
    }
    if !ok_clear {
        conflicts.push(shortcuts.clear_drawing.clone());
        let old = &config.shortcuts.clear_drawing;
        if old != &shortcuts.clear_drawing {
            register_one(app, old, |app, _state| {
                let _ = app.emit("clear-drawing", true);
            });
        }
    }
    if !ok_penetration {
        conflicts.push(shortcuts.toggle_penetration.clone());
        let old = &config.shortcuts.toggle_penetration;
        if old != &shortcuts.toggle_penetration {
            register_one(app, old, |app, state| {
                overlay::toggle_penetration_mode(app, state)
            });
        }
    }

    // 应用新配置（冲突项保留旧值）
    if ok_drawing {
        config.shortcuts.toggle_drawing = shortcuts.toggle_drawing.clone();
    }
    if ok_clear {
        config.shortcuts.clear_drawing = shortcuts.clear_drawing.clone();
    }
    if ok_penetration {
        config.shortcuts.toggle_penetration = shortcuts.toggle_penetration.clone();
    }

    let config_snapshot = config.clone();
    drop(config);
    crate::config::save_config(app, &config_snapshot)?;
    crate::config::broadcast_config(app, &config_snapshot);

    Ok(conflicts)
}
