#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env,
    fs,
    io::Write,
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use url::Url;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const READY_TIMEOUT: Duration = Duration::from_secs(600);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct OwnedSidecar(Mutex<Option<Child>>);

#[tauri::command]
fn save_text_export(target: String, contents: String) -> Result<(), String> {
    fs::write(&target, contents).map_err(|e| format!("export write failed: {e}"))
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn sidecar_command() -> Result<Command, String> {
    if let Some(value) = env::var_os("GA_HUB_SIDECAR") {
        return Ok(Command::new(value));
    }
    if cfg!(debug_assertions) {
        let python = env::var_os("GA_HUB_PYTHON").unwrap_or_else(|| "python".into());
        let mut command = Command::new(python);
        command.args(["-m", "server.desktop_sidecar"]);
        command.current_dir(repo_root());
        return Ok(command);
    }
    let mut path = env::current_exe().map_err(|e| format!("cannot locate executable: {e}"))?;
    path.set_file_name(if cfg!(windows) {
        "ga-hub-sidecar.exe"
    } else {
        "ga-hub-sidecar"
    });
    if !path.is_file() {
        return Err(format!("packaged sidecar missing: {}", path.display()));
    }
    Ok(Command::new(path))
}

fn spawn_sidecar() -> Result<(Child, u16, String), String> {
    let token = format!("{}-{}", std::process::id(), env!("CARGO_PKG_VERSION"));
    let probe = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("sidecar port allocation failed: {e}"))?;
    let port = probe
        .local_addr()
        .map_err(|e| format!("sidecar port lookup failed: {e}"))?
        .port();
    drop(probe);

    let mut command = sidecar_command()?;
    let port_arg = port.to_string();
    command
        .current_dir(repo_root())
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port_arg,
            "--instance-token",
            &token,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = command
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;
    Ok((child, port, token))
}

fn wait_http_ready(port: u16, token: &str) -> bool {
    let deadline = Instant::now() + READY_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}").parse().unwrap(),
            Duration::from_millis(500),
        ) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let request = format!("GET /api/desktop/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(request.as_bytes());
            let mut response = String::new();
            let _ = std::io::Read::read_to_string(&mut stream, &mut response);
            if response.starts_with("HTTP/1.1 200") && response.contains(token) {
                return true;
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    false
}

fn stop_owned(sidecar: &OwnedSidecar) {
    let Some(mut child) = sidecar.0.lock().unwrap().take() else {
        return;
    };
    #[cfg(windows)]
    {
        // Do not block the UI thread on PyInstaller's parent/worker teardown.
        // CREATE_NO_WINDOW also prevents taskkill from flashing a console.
        let pid = child.id().to_string();
        let result = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
        if result.is_err() {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    let quitting = Arc::new(AtomicBool::new(false));
    let quitting_setup = quitting.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(OwnedSidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![save_text_export])
        .setup(move |app| {
            let (child, port, token) =
                spawn_sidecar().map_err(|e| format!("GA-Hub desktop startup: {e}"))?;
            *app.state::<OwnedSidecar>().0.lock().unwrap() = Some(child);
            if !wait_http_ready(port, &token) {
                stop_owned(&app.state::<OwnedSidecar>());
                return Err("GA-Hub desktop backend readiness timed out".into());
            }
            let url = Url::parse(&format!("http://127.0.0.1:{port}"))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("GA-Hub")
                .inner_size(1320.0, 860.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .build()?;
            quitting_setup.store(false, Ordering::SeqCst);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build GA-Hub desktop shell");

    app.run(move |handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" && !quitting.swap(true, Ordering::SeqCst) => {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.hide();
            }
            stop_owned(&handle.state::<OwnedSidecar>());
            handle.exit(0);
        }
        RunEvent::ExitRequested { .. } => stop_owned(&handle.state::<OwnedSidecar>()),
        _ => {}
    });
}
