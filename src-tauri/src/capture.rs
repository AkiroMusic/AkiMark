use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BI_RGB, DIB_RGB_COLORS, SRCCOPY,
};

use crate::error::{AppError, AppResult};

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

#[cfg(target_os = "windows")]
mod imp {
    use super::*;

    /// 截取光标所在显示器的画面，编码为 PNG 的 base64 字符串。
    ///
    /// 调用前提：overlay 窗口已隐藏（由命令层处理），确保截到纯净桌面底图。
    pub fn capture_cursor_monitor_png() -> AppResult<String> {
        // 光标所在显示器在虚拟屏幕中的物理像素矩形（主屏左上角为原点，
        // 位于主屏左侧/上方的显示器坐标为负值）。
        let (x, y, w, h) =
            crate::win32::get_cursor_monitor_rect().ok_or(AppError::CaptureFailed)?;

        let pixels = capture_monitor(x, y, w, h).ok_or(AppError::CaptureFailed)?;

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

    /// 截取虚拟屏幕坐标 (x, y) 处 w×h 的 32bpp 像素（top-down，BGRA）。
    ///
    /// 屏幕 DC（GetDC(NULL)）覆盖整个虚拟屏幕，原点在主显示器左上角，
    /// 因此负坐标显示器也能用其虚拟坐标正确 BitBlt。全部 GDI 对象
    /// 在函数内创建并释放，不依赖任何回调生命周期。
    fn capture_monitor(x: i32, y: i32, w: u32, h: u32) -> Option<Vec<u8>> {
        unsafe {
            let hdc_screen = GetDC(std::ptr::null_mut());
            if hdc_screen.is_null() {
                return None;
            }
            let hdc_mem = CreateCompatibleDC(hdc_screen);
            if hdc_mem.is_null() {
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return None;
            }
            let hbmp = CreateCompatibleBitmap(hdc_screen, w as i32, h as i32);
            if hbmp.is_null() {
                DeleteDC(hdc_mem);
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return None;
            }
            let old = SelectObject(hdc_mem, hbmp);
            let copied = BitBlt(hdc_mem, 0, 0, w as i32, h as i32, hdc_screen, x, y, SRCCOPY) != 0;
            if !copied {
                SelectObject(hdc_mem, old);
                DeleteObject(hbmp);
                DeleteDC(hdc_mem);
                ReleaseDC(std::ptr::null_mut(), hdc_screen);
                return None;
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
                return None;
            }
            Some(pixels)
        }
    }
}
