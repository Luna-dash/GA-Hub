use std::{
    env,
    io::{BufRead, BufReader, Write},
    fs,
    net::TcpStream,
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

const READY_TIMEOUT: Duration = Duration::from_secs(40);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);

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
    let mut command = sidecar_command()?;
    command
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--instance-token",
            &token,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command
        .spawn()
        .map_err(|e| format!("sidecar spawn failed: {e}"))?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    while Instant::now() < deadline {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => {
                return Err(format!(
                    "sidecar exited before ready: {:?}",
                    child.try_wait()
                ))
            }
            Ok(_) => {
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                    if event["event"] == "starting" && event["instance_token"] == token {
                        let port = event["port"]
                            .as_u64()
                            .and_then(|v| u16::try_from(v).ok())
                            .ok_or("invalid sidecar port")?;
                        child.stdout = Some(reader.into_inner());
                        return Ok((child, port, token));
                    }
                    if event["event"] == "failed" {
                        return Err(format!("sidecar failed: {line}"));
                    }
                }
            }
            Err(e) => return Err(format!("sidecar protocol read failed: {e}")),
        }
    }
    let _ = child.kill();
    Err("sidecar startup protocol timed out".into())
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
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"\n");
    }
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => thread::sleep(Duration::from_millis(100)),
            Err(_) => break,
        }
    }
    eprintln!(
        "[desktop] graceful sidecar stop timed out; killing owned pid {}",
        child.id()
    );
    let _ = child.kill();
    let _ = child.wait();
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
            stop_owned(&handle.state::<OwnedSidecar>());
            handle.exit(0);
        }
        RunEvent::ExitRequested { .. } => stop_owned(&handle.state::<OwnedSidecar>()),
        _ => {}
    });
}
