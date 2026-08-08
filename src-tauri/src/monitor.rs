/// 显示器相关工具：MVP 仅需光标所在显示器 + 逻辑边界（供前端换算坐标）。
use tauri::Manager;

use crate::error::AppResult;

/// 逻辑边界（缩放后 CSS 像素），供前端坐标系换算。MVP 阶段暂由前端直接取窗口尺寸。
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorLogicalBounds {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// 光标所在显示器的逻辑边界（缩放后 CSS 像素），供前端坐标系换算。
/// MVP 阶段暂未从前端调用，保留备用。
#[allow(dead_code)]
pub fn get_cursor_monitor_logical_bounds(app: &tauri::AppHandle) -> AppResult<Option<MonitorLogicalBounds>> {
    let window = app
        .get_webview_window("overlay")
        .ok_or(crate::error::AppError::WindowNotFound("overlay".into()))?;

    let monitor = window
        .current_monitor()?
        .or_else(|| {
            // 兜底：用光标位置
            let pt = app.cursor_position().ok()?;
            window.monitor_from_point(pt.x as f64, pt.y as f64).ok().flatten()
        });

    let Some(monitor) = monitor else {
        return Ok(None);
    };

    let pos = monitor.position();
    let size = monitor.size();
    let scale = monitor.scale_factor();
    Ok(Some(MonitorLogicalBounds {
        left: pos.x as f64 / scale,
        top: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    }))
}
