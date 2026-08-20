use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::config::Shortcuts as ShortcutConfig;
use crate::error::{AppError, AppResult};
use crate::overlay::{self, AppState};

/// 注册全部全局快捷键（先注销再注册，支持配置变更）。
/// 单个热键被系统占用时不中断启动，收集冲突并广播给前端（设置窗口显示）。
pub fn register_shortcuts(app: &AppHandle) -> AppResult<()> {
    let state = app.state::<AppState>();
    let config = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let shortcuts = config.shortcuts;

    // 先注销所有已注册的
    if let Err(e) = app.global_shortcut().unregister_all() {
        crate::log::log(&format!("register_shortcuts: unregister_all 失败: {e}"));
    }

    let mut conflicts: Vec<String> = Vec::new();
    if !register_one(app, &shortcuts.toggle_drawing, |app, state| {
        overlay::toggle_drawing(app, state)
    }) {
        conflicts.push(shortcuts.toggle_drawing.clone());
    }
    if !register_one(app, &shortcuts.clear_drawing, |app, _state| {
        let _ = app.emit("clear-drawing", true);
    }) {
        conflicts.push(shortcuts.clear_drawing.clone());
    }
    if !register_one(app, &shortcuts.toggle_penetration, |app, state| {
        overlay::toggle_penetration_mode(app, state)
    }) {
        conflicts.push(shortcuts.toggle_penetration.clone());
    }

    if !conflicts.is_empty() {
        // 记录冲突状态（供 get_shortcut_conflicts 查询）
        *state
            .shortcut_conflicts
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = conflicts.clone();
        // 广播冲突给前端（设置窗口 / 覆盖层均可监听）
        let _ = app.emit("shortcut-conflict", conflicts.clone());
    } else {
        state
            .shortcut_conflicts
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }

    Ok(())
}

/// 查询当前注册失败的全局快捷键（被其他程序占用）。
pub fn get_shortcut_conflicts(app: &AppHandle) -> Vec<String> {
    let state = app.state::<AppState>();
    let conflicts = state
        .shortcut_conflicts
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    conflicts
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

/// 校验提交的快捷键集合内无重复绑定（重复无意义，且会误报"与其他程序冲突"）。
pub fn validate_no_duplicates(shortcuts: &ShortcutConfig) -> AppResult<()> {
    let mut seen = std::collections::HashSet::new();
    for s in [
        &shortcuts.toggle_drawing,
        &shortcuts.clear_drawing,
        &shortcuts.toggle_penetration,
    ] {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            continue; // 空 = 未绑定
        }
        if !seen.insert(trimmed.to_string()) {
            return Err(AppError::DuplicateShortcut(trimmed.into()));
        }
    }
    Ok(())
}

/// 保存快捷键并重注册；返回注册失败的快捷键列表（被其他程序占用）。
/// 失败的快捷键不会写入配置，其余正常生效。
pub fn save_shortcuts(app: &AppHandle, shortcuts: ShortcutConfig) -> AppResult<Vec<String>> {
    // 集合内去重校验
    validate_no_duplicates(&shortcuts)?;
    // 校验全部
    validate_shortcut(&shortcuts.toggle_drawing)?;
    validate_shortcut(&shortcuts.clear_drawing)?;
    validate_shortcut(&shortcuts.toggle_penetration)?;

    let state = app.state::<AppState>();
    // 先克隆旧配置并释放锁，再执行 FFI 注册（避免持锁跨 FFI 调用）
    let old_config = state
        .config
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let old_shortcuts = old_config.shortcuts.clone();

    // 先落盘新配置，再注册；注册失败回滚内存配置（磁盘与内存保持一致）
    let mut new_config = old_config.clone();
    new_config.shortcuts = shortcuts.clone();
    crate::config::save_config(app, &new_config)?;

    if let Err(e) = app.global_shortcut().unregister_all() {
        crate::log::log(&format!("save_shortcuts: unregister_all 失败: {e}"));
    }

    let mut conflicts: Vec<String> = Vec::new();
    let ok_drawing = register_one(app, &shortcuts.toggle_drawing, |app, state| {
        overlay::toggle_drawing(app, state)
    });
    let ok_clear = register_one(app, &shortcuts.clear_drawing, |app, _state| {
        let _ = app.emit("clear-drawing", true);
    });
    let ok_penetration = register_one(app, &shortcuts.toggle_penetration, |app, state| {
        overlay::toggle_penetration_mode(app, state)
    });

    // 冲突项回滚到旧值；旧值重新注册也失败时，加入冲突并清空配置
    if !ok_drawing {
        conflicts.push(shortcuts.toggle_drawing.clone());
        let old = &old_shortcuts.toggle_drawing;
        if old != &shortcuts.toggle_drawing {
            if !register_one(app, old, overlay::toggle_drawing) {
                // 旧值也被占用：加入冲突并清空配置
                conflicts.push(old.clone());
                new_config.shortcuts.toggle_drawing = String::new();
            }
        } else {
            // 新旧相同但注册失败（外部占用）：清空配置
            conflicts.push(old.clone());
            new_config.shortcuts.toggle_drawing = String::new();
        }
    }
    if !ok_clear {
        conflicts.push(shortcuts.clear_drawing.clone());
        let old = &old_shortcuts.clear_drawing;
        if old != &shortcuts.clear_drawing {
            if !register_one(app, old, |app, _state| {
                let _ = app.emit("clear-drawing", true);
            }) {
                conflicts.push(old.clone());
                new_config.shortcuts.clear_drawing = String::new();
            }
        } else {
            conflicts.push(old.clone());
            new_config.shortcuts.clear_drawing = String::new();
        }
    }
    if !ok_penetration {
        conflicts.push(shortcuts.toggle_penetration.clone());
        let old = &old_shortcuts.toggle_penetration;
        if old != &shortcuts.toggle_penetration {
            if !register_one(app, old, |app, state| {
                overlay::toggle_penetration_mode(app, state)
            }) {
                conflicts.push(old.clone());
                new_config.shortcuts.toggle_penetration = String::new();
            }
        } else {
            conflicts.push(old.clone());
            new_config.shortcuts.toggle_penetration = String::new();
        }
    }

    // 若有回滚（冲突项恢复旧值/清空），重新落盘保持磁盘与内存一致
    if !conflicts.is_empty() {
        crate::config::save_config(app, &new_config)?;
    }

    // 更新内存配置并广播
    *state.config.lock().unwrap_or_else(|e| e.into_inner()) = new_config.clone();
    crate::config::broadcast_config(app, &new_config);

    // 同步冲突状态
    *state
        .shortcut_conflicts
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = conflicts.clone();

    Ok(conflicts)
}

#[cfg(test)]
mod tests {
    use super::{validate_no_duplicates, validate_shortcut};
    use crate::error::AppError;

    #[test]
    fn valid_shortcuts_pass() {
        for accel in [
            "Ctrl+Shift+R",
            "Ctrl+Alt+C",
            "Ctrl+Shift+X",
            "Alt+F4",
            "F12",
            "Ctrl+1",
            "CmdOrCtrl+Shift+P",
            "Super+L",
            "Shift+Alt+Insert",
        ] {
            assert!(
                validate_shortcut(accel).is_ok(),
                "应接受合法快捷键: {accel}"
            );
        }
    }

    #[test]
    fn empty_shortcut_is_allowed() {
        // 空 = 未绑定，合法（register_one 也按此处理）
        assert!(validate_shortcut("").is_ok());
        assert!(validate_shortcut("   ").is_ok());
    }

    #[test]
    fn invalid_shortcuts_are_rejected() {
        for accel in [
            "Ctrl+",
            "+R",
            "Ctrl++Shift",
            "NOT_A_KEY",
            "123",
            "Ctrl Ctrl+R",
        ] {
            let err = validate_shortcut(accel).unwrap_err();
            assert!(
                matches!(err, AppError::InvalidShortcut(_)),
                "应拒绝非法快捷键 {accel:?}，得到 {err:?}"
            );
        }
    }

    #[test]
    fn shortcut_parse_rejects_unknown_modifiers() {
        assert!(validate_shortcut("Hyper+Shift+R").is_err());
    }

    #[test]
    fn duplicate_shortcuts_are_rejected() {
        use crate::config::Shortcuts as ShortcutConfig;
        // 同一集合内重复绑定：无意义，且会误报"与其他程序冲突"
        let dup = ShortcutConfig {
            toggle_drawing: "Ctrl+Shift+R".into(),
            clear_drawing: "Ctrl+Shift+R".into(),
            toggle_penetration: "Ctrl+Shift+X".into(),
        };
        let err = validate_no_duplicates(&dup).unwrap_err();
        assert!(
            matches!(err, AppError::DuplicateShortcut(_)),
            "应拒绝重复快捷键，得到 {err:?}"
        );
        // 空白值不算重复（空 = 未绑定）
        let ok = ShortcutConfig {
            toggle_drawing: "".into(),
            clear_drawing: "".into(),
            toggle_penetration: "Ctrl+Shift+X".into(),
        };
        assert!(validate_no_duplicates(&ok).is_ok());
    }
}
