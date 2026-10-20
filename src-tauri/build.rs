fn main() {
    // App commands otherwise bypass capability checks by default.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "reference_files", "clipboard_file_paths", "save_text_export", "desktop_backend_ready", "restart_backend",
            "show_message_dialog", "message_dialog_config", "message_dialog_ready",
            "message_dialog_finish",
        ]),
    )).expect("Tauri build/ACL generation failed")
}
