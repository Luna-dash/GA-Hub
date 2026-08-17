#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    io::{Read, Write},
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

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct OwnedSidecar(Mutex<Option<Child>>);

#[tauri::command]
fn save_text_export(target: String, contents: String) -> Result<(), String> {
    fs::write(&target, contents).map_err(|e| format!("export write failed: {e}"))
}

#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

fn sidecar_working_dir() -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        Ok(repo_root())
    }
    #[cfg(not(debug_assertions))]
    {
        env::current_exe()
            .map_err(|e| format!("cannot locate executable: {e}"))?
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "desktop executable has no parent directory".to_string())
    }
}

fn sidecar_command() -> Result<Command, String> {
    if let Some(value) = env::var_os("GA_HUB_SIDECAR") {
        return Ok(Command::new(value));
    }
    #[cfg(debug_assertions)]
    {
        let python = env::var_os("GA_HUB_PYTHON").unwrap_or_else(|| "python".into());
        let mut command = Command::new(python);
        command.args(["-m", "server.desktop_sidecar"]);
        Ok(command)
    }
    #[cfg(not(debug_assertions))]
    {
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
        .current_dir(sidecar_working_dir()?)
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port_arg,
            "--instance-token",
            &token,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;
    Ok((child, port, token))
}

fn wait_http_ready(child: &mut Child, port: u16, token: &str) -> Result<(), String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let address = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("invalid sidecar address: {e}"))?;
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("sidecar status check failed: {e}"))?
        {
            return Err(format!(
                "sidecar exited before readiness with status {status}"
            ));
        }
        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let request = format!("GET /api/desktop/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(request.as_bytes());
            let mut response = String::new();
            let _ = stream.read_to_string(&mut response);
            if response.starts_with("HTTP/1.1 200") && response.contains(token) {
                return Ok(());
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "sidecar readiness timed out after {} seconds",
        READY_TIMEOUT.as_secs()
    ))
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let _ = child.wait();
                return true;
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(None) | Err(_) => return false,
        }
    }
}

fn force_stop_child(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let stopped = Command::new("taskkill")
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !stopped {
            let _ = child.kill();
        }
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn stop_child(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
    }
    if !wait_for_child_exit(child, STOP_TIMEOUT) {
        force_stop_child(child);
    }
}

fn stop_owned(sidecar: &OwnedSidecar) {
    let Some(mut child) = sidecar.0.lock().unwrap().take() else {
        return;
    };
    stop_child(&mut child);
}

fn spawn_background_shutdown(handle: tauri::AppHandle) {
    thread::spawn(move || {
        stop_owned(&handle.state::<OwnedSidecar>());
        handle.exit(0);
    });
}

fn main() {
    let quitting = Arc::new(AtomicBool::new(false));
    let quitting_setup = quitting.clone();
    let quitting_single_instance = quitting.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(move |app, _, _| {
            if quitting_single_instance.load(Ordering::SeqCst) {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .manage(OwnedSidecar(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![save_text_export])
        .setup(move |app| {
            let (mut child, port, token) =
                spawn_sidecar().map_err(|e| format!("GA-Hub desktop startup: {e}"))?;
            if let Err(error) = wait_http_ready(&mut child, port, &token) {
                stop_child(&mut child);
                return Err(format!("GA-Hub desktop startup: {error}").into());
            }
            let url = Url::parse(&format!("http://127.0.0.1:{port}"))?;
            if let Err(error) = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("GA-Hub")
                .inner_size(1320.0, 860.0)
                .min_inner_size(960.0, 600.0)
                .resizable(true)
                .build()
            {
                stop_child(&mut child);
                return Err(error.into());
            }
            *app.state::<OwnedSidecar>().0.lock().unwrap() = Some(child);
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
        } if label == "main" => {
            api.prevent_close();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.hide();
            }
            if !quitting.swap(true, Ordering::SeqCst) {
                spawn_background_shutdown(handle.clone());
            }
        }
        RunEvent::ExitRequested { api, .. } if !quitting.swap(true, Ordering::SeqCst) => {
            api.prevent_exit();
            if let Some(window) = handle.get_webview_window("main") {
                let _ = window.hide();
            }
            spawn_background_shutdown(handle.clone());
        }
        _ => {}
    });
}
