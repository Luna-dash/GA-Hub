//! File references never copy or hash file contents.
// Preview reads are separate, bounded, and never change the path delivered to GA.
fn read_image_preview(path: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    const LIMIT: u64 = 16 * 1024 * 1024;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() { return Err("不是普通文件".into()); }
    if meta.len() > LIMIT { return Err("图片超过16MiB，仅提供文件引用".into()); }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > LIMIT { return Err("图片超过16MiB，仅提供文件引用".into()); }
    let raster = bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
        || (bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"))
        || bytes.starts_with(b"BM");
    if !raster { return Err("不支持的图片格式".into()); }
    Ok(bytes)
}

#[tauri::command]
pub async fn attachment_image_preview(path: String) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || read_image_preview(&path))
        .await.map_err(|e| e.to_string())?
        .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub fn reference_files(paths: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    if paths.len() > 256 { return Err("一次最多添加256个文件".into()); }
    let mut result = Vec::new();
    for raw in paths {
        let path = std::fs::canonicalize(&raw).map_err(|e| format!("{raw}: {e}"))?;
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_file() { return Err(format!("{raw}: 请选择文件")); }
        // Open only to check access; do not read even a single content byte.
        std::fs::File::open(&path).map_err(|e| format!("{raw}: {e}"))?;
        let canonical = path.to_string_lossy();
        let display = if let Some(unc) = canonical.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{}", unc)
        } else {
            canonical.strip_prefix(r"\\?\").unwrap_or(&canonical).to_string()
        };
        if result.iter().any(|v: &serde_json::Value| v["path"] == display) { continue; }
        result.push(serde_json::json!({"file_id": format!("local:{display}"),
            "path": display, "name": path.file_name().unwrap_or_default().to_string_lossy(),
            "size": meta.len(), "url": "", "mime": "application/octet-stream"}));
    }
    Ok(result)
}

#[cfg(windows)]
#[tauri::command]
pub fn clipboard_file_paths() -> Result<Vec<String>, String> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(owner: *mut c_void) -> i32;
        fn CloseClipboard() -> i32;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
        fn GetClipboardData(format: u32) -> *mut c_void;
    }
    #[link(name = "shell32")]
    extern "system" { fn DragQueryFileW(drop: *mut c_void, index: u32, buffer: *mut u16, count: u32) -> u32; }
    unsafe {
        if IsClipboardFormatAvailable(15) == 0 { return Ok(Vec::new()); }
        if OpenClipboard(std::ptr::null_mut()) == 0 { return Err("剪贴板忙，请重新粘贴".into()); }
        struct Guard;
        impl Drop for Guard { fn drop(&mut self) { unsafe { CloseClipboard(); } } }
        let _guard = Guard;
        let drop = GetClipboardData(15);
        if drop.is_null() { return Err("无法读取文件剪贴板".into()); }
        let count = DragQueryFileW(drop, u32::MAX, std::ptr::null_mut(), 0);
        if count > 256 { return Err("一次最多添加256个文件".into()); }
        let mut paths = Vec::new();
        for i in 0..count {
            let len = DragQueryFileW(drop, i, std::ptr::null_mut(), 0);
            let mut buf = vec![0u16; len as usize + 1];
            let actual = DragQueryFileW(drop, i, buf.as_mut_ptr(), buf.len() as u32);
            paths.push(String::from_utf16_lossy(&buf[..actual as usize]));
        }
        Ok(paths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("gahub-preview-{}-{}", std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> String {
            let path = self.0.join(name);
            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    #[test]
    fn reads_raster_signatures_without_modifying_files() {
        let f = Fixture::new();
        for (i, bytes) in [b"\x89PNG\r\n\x1a\n".as_slice(), b"\xff\xd8\xff", b"GIF89a", b"GIF87a", b"RIFF1234WEBP", b"BM"].iter().enumerate() {
            let path = f.write(&format!("图片{i}.bin"), bytes);
            assert_eq!(read_image_preview(&path).unwrap(), *bytes);
            assert_eq!(std::fs::read(&path).unwrap(), *bytes);
            assert_eq!(reference_files(vec![path]).unwrap()[0]["size"], bytes.len());
        }
    }
    #[test]
    fn rejects_non_raster_and_missing_files() {
        let f = Fixture::new();
        for bytes in [b"<svg onload='alert(1)'/>".as_slice(), b"not an image", b""] {
            let path = f.write("fake.png", bytes);
            assert!(read_image_preview(&path).unwrap_err().contains("格式"));
        }
        assert!(read_image_preview(f.0.join("missing.png").to_str().unwrap()).is_err());
        assert!(read_image_preview(f.0.to_str().unwrap()).is_err());
    }
    #[test]
    fn oversized_files_remain_referenceable() {
        let f = Fixture::new();
        let path = f.write("large.png", b"\x89PNG\r\n\x1a\n");
        std::fs::OpenOptions::new().write(true).open(&path).unwrap().set_len(16 * 1024 * 1024 + 1).unwrap();
        assert!(read_image_preview(&path).unwrap_err().contains("16MiB"));
        assert_eq!(reference_files(vec![path]).unwrap().len(), 1);
    }
}

#[cfg(not(windows))]
#[tauri::command]
pub fn clipboard_file_paths() -> Result<Vec<String>, String> { Ok(Vec::new()) }
