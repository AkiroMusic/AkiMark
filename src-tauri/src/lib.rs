mod capture;
mod commands;
mod config;
mod error;
mod log;
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
        crate::log::log("open_settings: 复用已有设置窗口");
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let win = match WebviewWindowBuilder::new(
        app,
        SETTINGS_LABEL,
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("AkiMark 设置")
    .inner_size(460.0, 640.0)
    .resizable(false)
    .maximizable(false)
    .center()
    // 必须与 overlay 窗口的 additionalBrowserArgs 完全一致：
    // 同一 user data folder 下 WebView2 以第一个窗口的参数启动浏览器进程，
    // 后续窗口参数不同会导致 ERROR_NOT_READY (0x8007139F) 创建失败。
    .additional_browser_args("--disable-gpu-compositing")
    .build()
    {
        Ok(w) => w,
        Err(e) => {
            crate::log::log(&format!("open_settings: 创建设置窗口失败: {e}"));
            eprintln!("[akimark] 创建设置窗口失败: {e}");
            return;
        }
    };
    crate::log::log("open_settings: 新建设置窗口成功");
    let _ = win.show();
    let _ = win.set_focus();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    eprintln!("[akimark] run() 开始");
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
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            commands::handle_window_event(window, event);
            commands::handle_focus_event(window.app_handle(), event);
        })
        .setup(|app| {
            log::init(&app.handle());
            crate::log::install_log_facade();
            crate::log::log("setup 开始");

            let config = load_config(&app.handle());
            app.manage(AppState::new(config));

            setup_tray(&app.handle())?;
            shortcuts::register_shortcuts(&app.handle())?;

            // 默认启动后打开设置界面（config 可关）
            let state = app.state::<AppState>();
            let open_on_startup = state
                .config
                .lock()
                .unwrap()
                .general
                .open_settings_on_startup;
            crate::log::log(&format!(
                "setup: open_settings_on_startup = {open_on_startup}"
            ));
            if open_on_startup {
                open_settings(&app.handle());
            }

            crate::log::log("setup 完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_general,
            commands::save_line_widths,
            commands::save_drawing_prefs,
            commands::save_shortcuts,
            commands::get_shortcut_conflicts,
            commands::save_locale,
            commands::exit_drawing,
            commands::enter_penetration_mode,
            commands::exit_penetration_mode,
            commands::toggle_penetration_mode,
            commands::capture_screen,
            commands::save_export,
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
