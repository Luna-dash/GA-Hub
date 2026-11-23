//! Set both native window icons for Explorer, independently of Tauri's single-frame icon.

use std::ptr::null;
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::GetModuleHandleW,
    UI::{
        HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
        WindowsAndMessaging::{
            LoadImageW, SendMessageW, ICON_BIG, ICON_SMALL, IMAGE_ICON, SM_CXICON, SM_CXSMICON,
            SM_CYICON, SM_CYSMICON, WM_SETICON,
        },
    },
};

// tauri-build embeds the multi-frame app icon under this integer resource ID.
const APP_ICON_RESOURCE: u16 = 32512;

pub(crate) fn install(hwnd: HWND) {
    // Called once for the main HWND on its UI thread. Keep the two loaded icons
    // alive until process exit. Do not use LR_SHARED: its cache ignores size.
    unsafe {
        let module = GetModuleHandleW(null());
        let dpi = GetDpiForWindow(hwnd);
        if module.is_null() || dpi == 0 {
            return;
        }
        for (kind, width, height) in [
            (ICON_BIG, SM_CXICON, SM_CYICON),
            (ICON_SMALL, SM_CXSMICON, SM_CYSMICON),
        ] {
            let icon = LoadImageW(
                module,
                APP_ICON_RESOURCE as usize as *const u16,
                IMAGE_ICON,
                GetSystemMetricsForDpi(width, dpi),
                GetSystemMetricsForDpi(height, dpi),
                0,
            );
            if !icon.is_null() {
                SendMessageW(hwnd, WM_SETICON, kind as usize, icon as isize);
            }
        }
    }
}
