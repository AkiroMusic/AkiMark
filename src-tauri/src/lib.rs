mod capture;
mod commands;
mod config;
mod error;
mod log;
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

/// 面向用户的文案（托盘菜单 / 设置窗口标题），随 config.general.locale
fn tray_labels(
    locale: &str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
) {
    if locale.eq_ignore_ascii_case("en") {
        (
            "AkiMark Settings",
            "Annotate / Exit",
            "Settings",
            "Clear screen",
            "Quit",
        )
    } else {
        ("AkiMark 设置", "标注 / 退出标注", "设置", "清屏", "退出")
    }
}

/// 当前配置语言（供 UI 文案使用）
pub fn current_locale() -> String {
    APP_LOCALE
        .read()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "zh-CN".into())
}

/// 全局 UI locale（启动时设置；save_general 成功后更新，随之重建托盘菜单）
static APP_LOCALE: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

/// 更新全局 UI locale（含面向前端的错误文案语言）。
/// 设置窗口保存语言后调用；托盘菜单随 rebuild_tray_menu 重建。
pub fn update_ui_locale(app: &AppHandle, locale: &str) {
    if let Ok(mut s) = APP_LOCALE.write() {
        *s = locale.to_string();
    }
    crate::error::set_error_locale(locale);
    rebuild_tray_menu(app);
}

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
    .title(tray_labels(&current_locale()).0)
    .inner_size(460.0, 640.0)
    .resizable(false)
    .maximizable(false)
    .center()
    // 必须与 overlay 窗口的 additionalBrowserArgs 完全一致：
    // 同一 user data folder 下 WebView2 以第一个窗口的参数启动浏览器进程，
    // 后续窗口参数不同会导致 ERROR_NOT_READY (0x8007139F) 创建失败。
    // 注意：设置 additional_browser_args 会整体覆盖 wry 默认参数，须带上
    // 默认的 --disable-features（SmartScreen/OLE UI 等）。
    // --disk-cache-size=16MB：应用零网络请求，HTTP 缓存纯属磁盘浪费
    //（托盘常驻数周可膨胀到数百 MB，卸载残留问题的一半来源）。
    .additional_browser_args(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-gpu-compositing --disk-cache-size=16777216",
    )
    .build()
    {
        Ok(w) => w,
        Err(e) => {
            crate::log::log(&format!("open_settings: 创建设置窗口失败: {e}"));
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
            // 第二次启动 → 打开设置窗口（双击图标的多半是想改配置；
            // 标注切换已有全局热键/托盘，不缺这一个入口）
            crate::log::log("single-instance: 二次启动，打开设置窗口");
            open_settings(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .on_window_event(|window, event| {
            commands::handle_window_event(window, event);
            commands::handle_focus_event(window.app_handle(), event);
        })
        .setup(|app| {
            log::init(app.handle());
            crate::log::install_log_facade();
            crate::log::log("setup 开始");

            let config = load_config(app.handle());
            app.manage(AppState::new(config.clone()));

            // UI locale（错误文案语言）与托盘菜单按配置初始化
            let locale = config.general.locale.clone();
            if let Ok(mut s) = APP_LOCALE.write() {
                *s = locale.clone();
            }
            crate::error::set_error_locale(&locale);

            setup_tray(app.handle())?;
            shortcuts::register_shortcuts(app.handle())?;

            // 默认启动后打开设置界面（config 可关）
            let state = app.state::<AppState>();
            let open_on_startup = state
                .config
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .general
                .open_settings_on_startup;
            crate::log::log(&format!(
                "setup: open_settings_on_startup = {open_on_startup}"
            ));
            if open_on_startup {
                open_settings(app.handle());
            }

            crate::log::log("setup 完成");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_config,
            commands::save_general,
            commands::save_drawing_prefs,
            commands::save_shortcuts,
            commands::get_shortcut_conflicts,
            commands::exit_drawing,
            commands::enter_penetration_mode,
            commands::exit_penetration_mode,
            commands::set_board_active,
            commands::capture_screen,
            commands::save_export,
            commands::copy_png_to_clipboard,
            commands::open_settings,
            commands::set_autostart,
            commands::get_autostart,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AkiMark");
}

/// 托盘 id（语言切换后按 id 取回托盘重建菜单）
const TRAY_ID: &str = "main";

/// 用当前 locale 重建托盘菜单（设置窗口保存语言后调用）。
/// 事件 id 不变，handler 无需重绑。
fn rebuild_tray_menu(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    let (_, toggle_text, settings_text, clear_text, quit_text) = tray_labels(&current_locale());
    let menu = match (
        MenuItem::with_id(app, "toggle", toggle_text, true, None::<&str>),
        MenuItem::with_id(app, "settings", settings_text, true, None::<&str>),
        MenuItem::with_id(app, "clear", clear_text, true, None::<&str>),
        MenuItem::with_id(app, "quit", quit_text, true, None::<&str>),
    ) {
        (Ok(t), Ok(s), Ok(c), Ok(q)) => match Menu::with_items(app, &[&t, &s, &c, &q]) {
            Ok(m) => m,
            Err(e) => {
                crate::log::log(&format!("rebuild_tray_menu: 菜单创建失败: {e}"));
                return;
            }
        },
        _ => {
            crate::log::log("rebuild_tray_menu: 菜单项创建失败");
            return;
        }
    };
    if let Err(e) = tray.set_menu(Some(menu)) {
        crate::log::log(&format!("rebuild_tray_menu: set_menu 失败: {e}"));
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let (_, toggle_text, settings_text, clear_text, quit_text) = tray_labels(&current_locale());
    let toggle = MenuItem::with_id(app, "toggle", toggle_text, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", settings_text, true, None::<&str>)?;
    let clear = MenuItem::with_id(app, "clear", clear_text, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_text, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &settings, &clear, &quit])?;

    // 无默认图标时跳过托盘创建（托盘是增强功能，不应阻塞启动）
    let Some(icon) = app.default_window_icon() else {
        crate::log::log("setup_tray: 无默认窗口图标，跳过托盘创建");
        return Ok(());
    };

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon.clone())
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
