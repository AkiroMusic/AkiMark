use windows_sys::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR, SRCCOPY,
};

use crate::error::{AppError, AppResult};

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    /// 用 BitBlt 截取光标所在显示器的画面，编码为 PNG 的 base64 字符串。
    ///
    /// 调用前提：overlay 窗口已隐藏（由命令层处理），确保截到纯净桌面底图。
    pub fn capture_cursor_monitor_png() -> AppResult<String> {
        let monitor = crate::win32::get_cursor_monitor().ok_or(AppError::CaptureFailed)?;
        let (x, y, w, h) = crate::win32::get_cursor_monitor_rect().ok_or(AppError::CaptureFailed)?;

        // GetDC(NULL) 只覆盖主屏；光标在副屏（尤其负坐标区域）时必须用该显示器的 DC。
        // EnumDisplayMonitors 回调会为每个显示器给出对应的屏幕 DC。
        let hdc_screen = unsafe {
            let mut found: Option<HDC> = None;
            let ctx = MonitorEnumCtx {
                target: monitor,
                found: &mut found as *mut Option<HDC>,
            };
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(enum_display_monitor_proc),
                &ctx as *const _ as LPARAM,
            );
            found.ok_or(AppError::CaptureFailed)?
        };

        unsafe {
            let hdc_mem = CreateCompatibleDC(hdc_screen);
            if hdc_mem.is_null() {
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err(AppError::CaptureFailed);
            }
            let hbmp = CreateCompatibleBitmap(hdc_screen, w as i32, h as i32);
            if hbmp.is_null() {
                DeleteDC(hdc_mem);
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err(AppError::CaptureFailed);
            }

            let old = SelectObject(hdc_mem, hbmp);
            let copied = BitBlt(hdc_mem, 0, 0, w as i32, h as i32, hdc_screen, x, y, SRCCOPY) != 0;
            if !copied {
                SelectObject(hdc_mem, old);
                DeleteObject(hbmp);
                DeleteDC(hdc_mem);
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return Err(AppError::CaptureFailed);
            }

            // 提取 32bpp 像素（top-down，BGRA）
            let mut bmi: BITMAPINFO = std::mem::zeroed();
            bmi.bmiHeader.biSize = std::mem::size_of_val(&bmi.bmiHeader) as u32;
            bmi.bmiHeader.biWidth = w as i32;
            bmi.bmiHeader.biHeight = -(h as i32);
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;

            let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
            let lines = GetDIBits(
                hdc_mem,
                hbmp,
                0,
                h,
                pixels.as_mut_ptr() as _,
                &mut bmi,
                DIB_RGB_COLORS,
            );

            SelectObject(hdc_mem, old);
            DeleteObject(hbmp);
            DeleteDC(hdc_mem);
            ReleaseDC(std::ptr::null_mut(), hdc_screen);

            if lines == 0 {
                return Err(AppError::CaptureFailed);
            }

            // BGRA → RGBA（PNG 需要）
            for px in pixels.chunks_exact_mut(4) {
                px.swap(0, 2);
            }

            let img = image::RgbaImage::from_raw(w, h, pixels).ok_or(AppError::CaptureFailed)?;
            let mut cursor = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgba8(img)
                .write_to(&mut cursor, image::ImageFormat::Png)
                .map_err(|_| AppError::CaptureFailed)?;

            use base64::Engine;
            Ok(base64::engine::general_purpose::STANDARD.encode(cursor.into_inner()))
        }
    }

    /// EnumDisplayMonitors 回调上下文
    struct MonitorEnumCtx {
        target: HMONITOR,
        found: *mut Option<HDC>,
    }

    /// 枚举显示器：命中光标所在显示器时记录其 DC 并停止。
    unsafe extern "system" fn enum_display_monitor_proc(
        hmonitor: HMONITOR,
        hdc: HDC,
        _lprc: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let ctx = &*(lparam as *const MonitorEnumCtx);
        if hmonitor == ctx.target {
            unsafe {
                *ctx.found = Some(hdc);
            }
            return 0; // FALSE：停止枚举
        }
        1
    }
}

/// 截取光标所在显示器的画面，编码为 PNG 的 base64 字符串。
///
/// 调用前提：overlay 窗口已隐藏（由命令层处理），确保截到纯净桌面底图。
pub fn capture_cursor_monitor_png() -> AppResult<String> {
    #[cfg(target_os = "windows")]
    {
        return imp::capture_cursor_monitor_png();
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err(AppError::UnsupportedPlatform)
    }
}
