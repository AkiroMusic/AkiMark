use windows_sys::Win32::Foundation::{BOOL, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    EnumDisplayMonitors, GetDIBits, SelectObject, BITMAPINFO, BI_RGB, DIB_RGB_COLORS, HDC,
    HMONITOR, SRCCOPY,
};

use crate::error::{AppError, AppResult};

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    /// 截取光标所在显示器的画面，编码为 PNG 的 base64 字符串。
    ///
    /// 调用前提：overlay 窗口已隐藏（由命令层处理），确保截到纯净桌面底图。
    pub fn capture_cursor_monitor_png() -> AppResult<String> {
        let monitor = crate::win32::get_cursor_monitor().ok_or(AppError::CaptureFailed)?;
        let (_, _, w, h) =
            crate::win32::get_cursor_monitor_rect().ok_or(AppError::CaptureFailed)?;

        // 关键约束：EnumDisplayMonitors 回调传入的 hdc 只在回调执行期间有效，
        // 且该 DC 的坐标原点就是对应显示器的左上角（监视器局部坐标）。
        // 因此建兼容 DC/位图、BitBlt、GetDIBits 等全部 GDI 工作都必须放在
        // 回调内完成，源坐标固定为 (0,0)，与虚拟屏幕坐标（可能为负）无关。
        let mut ctx = MonitorEnumCtx {
            target: monitor,
            width: w,
            height: h,
            pixels: None,
        };
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(enum_display_monitor_proc),
                &mut ctx as *mut _ as LPARAM,
            );
        }

        let pixels = ctx.pixels.take().ok_or(AppError::CaptureFailed)?;

        // BGRA → RGBA（PNG 需要）
        let mut pixels = pixels;
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

    /// EnumDisplayMonitors 回调上下文：目标显示器 + 截取尺寸 + 输出像素
    struct MonitorEnumCtx {
        target: HMONITOR,
        width: u32,
        height: u32,
        pixels: Option<Vec<u8>>,
    }

    /// 枚举显示器：命中光标所在显示器时，趁 hdc 有效立即完成截取并停止枚举。
    unsafe extern "system" fn enum_display_monitor_proc(
        hmonitor: HMONITOR,
        hdc: HDC,
        _lprc: *mut RECT,
        lparam: LPARAM,
    ) -> BOOL {
        let ctx = unsafe { &mut *(lparam as *mut MonitorEnumCtx) };
        if hmonitor != ctx.target {
            return 1; // TRUE：继续枚举
        }

        let w = ctx.width as i32;
        let h = ctx.height as i32;
        let hdc_mem = unsafe { CreateCompatibleDC(hdc) };
        if hdc_mem.is_null() {
            return 0; // FALSE：停止枚举
        }
        let hbmp = unsafe { CreateCompatibleBitmap(hdc, w, h) };
        if hbmp.is_null() {
            unsafe { DeleteDC(hdc_mem) };
            return 0;
        }
        let old = unsafe { SelectObject(hdc_mem, hbmp) };
        // 源坐标 (0,0)：该 DC 的原点即显示器左上角
        let copied = unsafe { BitBlt(hdc_mem, 0, 0, w, h, hdc, 0, 0, SRCCOPY) != 0 };
        if copied {
            // 提取 32bpp 像素（top-down，BGRA）
            let mut bmi: BITMAPINFO = unsafe { std::mem::zeroed() };
            bmi.bmiHeader.biSize = std::mem::size_of_val(&bmi.bmiHeader) as u32;
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;

            let mut pixels = vec![0u8; (ctx.width as usize) * (ctx.height as usize) * 4];
            let lines = unsafe {
                GetDIBits(
                    hdc_mem,
                    hbmp,
                    0,
                    ctx.height,
                    pixels.as_mut_ptr() as _,
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            };
            if lines != 0 {
                ctx.pixels = Some(pixels);
            }
        }
        unsafe {
            SelectObject(hdc_mem, old);
            DeleteObject(hbmp);
            DeleteDC(hdc_mem);
        }
        0 // FALSE：停止枚举
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
