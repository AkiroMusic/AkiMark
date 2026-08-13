use std::ffi::c_void;
use windows_sys::Win32::Foundation::{POINT, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromPoint, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    ClipCursor, GetCursorPos, SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_SHOWWINDOW,
};

/// 光标所在显示器的物理像素矩形 (x, y, w, h)
pub fn get_cursor_monitor_rect() -> Option<(i32, i32, u32, u32)> {
    get_monitor_rect(get_cursor_monitor()?)
}

/// 光标所在显示器句柄（HMONITOR）
pub fn get_cursor_monitor() -> Option<HMONITOR> {
    unsafe {
        let mut pt = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut pt) == 0 {
            return None;
        }
        let monitor = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        Some(monitor)
    }
}

fn get_monitor_rect(monitor: HMONITOR) -> Option<(i32, i32, u32, u32)> {
    unsafe {
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let r = info.rcMonitor;
        Some((
            r.left,
            r.top,
            (r.right - r.left) as u32,
            (r.bottom - r.top) as u32,
        ))
    }
}

/// 一次性把窗口移动到光标所在显示器并置顶（混合 DPI 安全：WM_DPICHANGED 几何原子应用）。
pub fn position_window_on_monitor(hwnd: *mut c_void, x: i32, y: i32, w: u32, h: u32) -> bool {
    unsafe {
        let rect = RECT {
            left: x,
            top: y,
            right: x + w as i32,
            bottom: y + h as i32,
        };
        SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ) != 0
    }
}

/// 将光标限制在指定物理像素矩形内。
pub fn clip_cursor(x: i32, y: i32, w: u32, h: u32) -> bool {
    unsafe {
        let rect = RECT {
            left: x,
            top: y,
            right: x + w as i32,
            bottom: y + h as i32,
        };
        ClipCursor(&rect) != 0
    }
}

/// 释放光标限制。
pub fn release_cursor() {
    unsafe {
        ClipCursor(std::ptr::null());
    }
}
