mod commands;
mod config;
mod error;
mod monitor;
mod overlay;
mod shortcuts;
mod win32;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewWindowBuilder,
};

use crate::config::load_config;
use crate::overlay::AppState;

/// 设置窗口 label（与 tauri.conf.json 一致）
pub const SETTINGS_LABEL: &str = "settings";

/// 打开设置窗口：已存在则聚焦，否则创建（用后即毁，不常驻）。
pub fn open_settings(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let Ok(win) = WebviewWindowBuilder::new(app, SETTINGS_LABEL, tauri::WebviewUrl::App(
        "settings.html".into(),
    ))
    .title("AkiMark 设置")
    .inner_size(460.0, 640.0)
    .resizable(false)
    .maximizable(false)
    .center()
    .build()
    else {
        eprintln!("[akimark] 创建设置窗口失败");
        return;
    };
    let _ = win.show();
    let _ = win.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二次启动 → 切换标注模式
            let state = app.state::<AppState>();
            overlay::toggle_drawing(app, &state);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .on_window_event(|window, event| {
            commands::handle_window_event(window, event);
            commands::handle_focus_event(window.app_handle(), event);
        })
        .setup(|app| {
            let config = load_config(&app.handle());
            app.manage(AppState::new(config));

            setup_tray(&app.handle())?;
            shortcuts::register_shortcuts(&app.handle())?;

            // 默认启动后打开设置界面（config 可关）
            let state = app.state::<AppState>();
            if state.config.lock().unwrap().general.open_settings_on_startup {
                open_settings(&app.handle());
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_general,
            commands::save_line_widths,
            commands::save_shortcuts,
            commands::save_locale,
            commands::exit_drawing,
            commands::enter_penetration_mode,
            commands::exit_penetration_mode,
            commands::toggle_penetration_mode,
            commands::open_settings,
            commands::set_autostart,
            commands::get_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AkiMark");
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "标注 / 退出标注", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear", "清屏", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &clear, &quit])?;

    let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                let state = app.state::<AppState>();
                overlay::toggle_drawing(app, &state);
            }
            "settings" => {
                open_settings(app);
            }
            "clear" => {
                let _ = app.emit("clear-drawing", true);
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let state = app.state::<AppState>();
                overlay::toggle_drawing(app, &state);
            }
        })
        .build(app)?;

    Ok(())
}
