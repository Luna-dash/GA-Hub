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
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum BackendReadiness {
    Starting,
    Ready,
    Failed(String),
}

#[derive(Clone)]
struct OwnedSidecar {
    child: Arc<Mutex<Option<Child>>>,
    readiness: Arc<Mutex<BackendReadiness>>,
}

impl OwnedSidecar {
    fn new() -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            readiness: Arc::new(Mutex::new(BackendReadiness::Starting)),
        }
    }

    fn store_child(&self, mut child: Child) -> Result<(), String> {
        let mut slot = self.child.lock().unwrap_or_else(|e| e.into_inner());
        if slot.is_some() {
            drop(slot);
            stop_child(&mut child);
            return Err("desktop shell already owns a sidecar".to_string());
        }
        *slot = Some(child);
        *self.readiness.lock().unwrap_or_else(|e| e.into_inner()) = BackendReadiness::Starting;
        Ok(())
    }

    fn take_child(&self) -> Option<Child> {
        self.child.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    fn set_ready(&self) {
        *self.readiness.lock().unwrap_or_else(|e| e.into_inner()) = BackendReadiness::Ready;
    }

    fn set_failed(&self, error: String) {
        *self.readiness.lock().unwrap_or_else(|e| e.into_inner()) = BackendReadiness::Failed(error);
    }

    fn ready(&self) -> Result<bool, String> {
        match &*self.readiness.lock().unwrap_or_else(|e| e.into_inner()) {
            BackendReadiness::Starting => Ok(false),
            BackendReadiness::Ready => Ok(true),
            BackendReadiness::Failed(error) => Err(error.clone()),
        }
    }
}

#[tauri::command]
fn save_text_export(target: String, contents: String) -> Result<(), String> {
    fs::write(&target, contents).map_err(|e| format!("export write failed: {e}"))
}

#[tauri::command]
fn desktop_backend_ready(sidecar: tauri::State<'_, OwnedSidecar>) -> Result<bool, String> {
    sidecar.ready()
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
    let token = Uuid::new_v4().to_string();
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

fn ready_response_matches(response: &str, token: &str) -> bool {
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let mut status = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    if !matches!(status.next(), Some("HTTP/1.0") | Some("HTTP/1.1")) || status.next() != Some("200")
    {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("instance_token")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .as_deref()
        == Some(token)
}

enum ReadinessWait {
    Ready,
    Cancelled,
}

fn wait_http_ready(
    sidecar: &OwnedSidecar,
    port: u16,
    token: &str,
    quitting: &AtomicBool,
) -> Result<ReadinessWait, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let address = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("invalid sidecar address: {e}"))?;
    while Instant::now() < deadline {
        if quitting.load(Ordering::SeqCst) {
            return Ok(ReadinessWait::Cancelled);
        }

        // Never retain the child mutex while connecting, reading, or sleeping.
        // Window shutdown can therefore take ownership of the child immediately,
        // even while the packaged one-file sidecar is still extracting.
        let child_status = {
            let mut slot = sidecar.child.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_mut() {
                Some(child) => Some(
                    child
                        .try_wait()
                        .map_err(|e| format!("sidecar status check failed: {e}"))?,
                ),
                None => None,
            }
        };
        match child_status {
            Some(Some(status)) => {
                return Err(format!(
                    "sidecar exited before readiness with status {status}"
                ));
            }
            Some(None) => {}
            None if quitting.load(Ordering::SeqCst) => return Ok(ReadinessWait::Cancelled),
            None => return Err("owned sidecar disappeared before readiness".to_string()),
        }

        if let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let request = format!("GET /api/desktop/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
            let _ = stream.write_all(request.as_bytes());
            let mut response = String::new();
            if stream.read_to_string(&mut response).is_ok()
                && ready_response_matches(&response, token)
            {
                return Ok(ReadinessWait::Ready);
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!(
        "sidecar readiness timed out after {} seconds",
        READY_TIMEOUT.as_secs()
    ))
}

fn request_owned_shutdown(sidecar: &OwnedSidecar) {
    let stdin = {
        let mut slot = sidecar.child.lock().unwrap_or_else(|e| e.into_inner());
        slot.as_mut().and_then(|child| child.stdin.take())
    };
    if let Some(mut stdin) = stdin {
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
    }
}

fn spawn_background_readiness(
    sidecar: OwnedSidecar,
    port: u16,
    token: String,
    quitting: Arc<AtomicBool>,
) {
    thread::spawn(
        move || match wait_http_ready(&sidecar, port, &token, &quitting) {
            Ok(ReadinessWait::Ready) if !quitting.load(Ordering::SeqCst) => sidecar.set_ready(),
            Ok(ReadinessWait::Ready | ReadinessWait::Cancelled) => {}
            Err(error) if !quitting.load(Ordering::SeqCst) => {
                sidecar.set_failed(format!("GA-Hub desktop startup: {error}"));
                // Keep the Child in the shared owner slot so CloseRequested can
                // still take it immediately. This quick request handles the usual
                // timeout case without transferring ownership to this worker.
                request_owned_shutdown(&sidecar);
            }
            Err(_) => {}
        },
    );
}

fn runtime_config_json(port: u16, token: &str) -> String {
    serde_json::json!({
        "apiOrigin": format!("http://127.0.0.1:{port}"),
        "wsOrigin": format!("ws://127.0.0.1:{port}"),
        "instanceToken": token,
        "desktop": true,
    })
    .to_string()
}

fn runtime_initialization_script(port: u16, token: &str) -> String {
    let runtime = runtime_config_json(port, token);
    format!(
        r#"(() => {{
  const location = new URL(window.location.href);
  const noCredentials = location.username === "" && location.password === "";
  const appOrigin =
    noCredentials && (
      (location.protocol === "tauri:" && location.hostname === "localhost" && location.port === "") ||
      ((location.protocol === "http:" || location.protocol === "https:") &&
        location.hostname === "tauri.localhost" && location.port === "") ||
      location.origin === "http://127.0.0.1:5173"
    );
  if (appOrigin && !Object.prototype.hasOwnProperty.call(window, "__GA_HUB_RUNTIME__")) {{
    Object.defineProperty(window, "__GA_HUB_RUNTIME__", {{
      value: Object.freeze({runtime}),
      writable: false,
      configurable: false,
      enumerable: false
    }});
  }}
}})();"#
    )
}

fn is_allowed_main_navigation(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let tauri_app =
        (url.scheme() == "tauri" && url.host_str() == Some("localhost") && url.port().is_none())
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")
                && url.port().is_none());
    let vite_dev = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.port_or_known_default() == Some(5173);
    tauri_app || vite_dev
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
    let Some(mut child) = sidecar.take_child() else {
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
        .manage(OwnedSidecar::new())
        .invoke_handler(tauri::generate_handler![
            save_text_export,
            desktop_backend_ready
        ])
        .setup(move |app| {
            let (child, port, token) =
                spawn_sidecar().map_err(|e| format!("GA-Hub desktop startup: {e}"))?;
            let owned = app.state::<OwnedSidecar>().inner().clone();
            owned
                .store_child(child)
                .map_err(|e| format!("GA-Hub desktop startup: {e}"))?;
            let runtime_script = runtime_initialization_script(port, &token);
            if let Err(error) =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .initialization_script(runtime_script)
                    .on_navigation(is_allowed_main_navigation)
                    .title("GA-Hub")
                    .inner_size(1320.0, 860.0)
                    .min_inner_size(960.0, 600.0)
                    .resizable(true)
                    .build()
            {
                stop_owned(&owned);
                return Err(error.into());
            }
            quitting_setup.store(false, Ordering::SeqCst);
            spawn_background_readiness(owned, port, token, quitting_setup.clone());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_response_requires_an_exact_json_token() {
        let token = "expected-token";
        let ok = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"instance_token\":\"expected-token\"}";
        assert!(ready_response_matches(ok, token));

        let token_elsewhere =
            "HTTP/1.1 200 OK\r\n\r\n{\"instance_token\":\"other\",\"message\":\"expected-token\"}";
        assert!(!ready_response_matches(token_elsewhere, token));
        assert!(!ready_response_matches(
            "HTTP/1.1 503 Service Unavailable\r\n\r\n{\"instance_token\":\"expected-token\"}",
            token,
        ));
        assert!(!ready_response_matches(
            "HTTP/1.1 200 OK\r\n\r\nnot-json",
            token,
        ));
    }

    #[test]
    fn runtime_config_is_json_encoded_and_complete() {
        let token = "token-with-\"quote";
        let value: serde_json::Value =
            serde_json::from_str(&runtime_config_json(43123, token)).unwrap();
        assert_eq!(value["apiOrigin"], "http://127.0.0.1:43123");
        assert_eq!(value["wsOrigin"], "ws://127.0.0.1:43123");
        assert_eq!(value["instanceToken"], token);
        assert_eq!(value["desktop"], true);

        let script = runtime_initialization_script(43123, token);
        assert!(script.contains("Object.freeze"));
        assert!(script.contains("Object.defineProperty"));
    }

    #[test]
    fn main_navigation_is_limited_to_app_and_dev_origins() {
        assert!(is_allowed_main_navigation(
            &Url::parse("tauri://localhost/chat").unwrap()
        ));
        assert!(is_allowed_main_navigation(
            &Url::parse("http://tauri.localhost/conversations/abc").unwrap()
        ));
        assert!(is_allowed_main_navigation(
            &Url::parse("https://tauri.localhost/conversations/abc").unwrap()
        ));
        assert_eq!(
            is_allowed_main_navigation(&Url::parse("http://127.0.0.1:5173/chat").unwrap()),
            cfg!(debug_assertions),
        );
        for rejected in [
            "https://evil.example",
            "http://tauri.localhost.evil.example",
            "https://tauri.localhost.evil.example",
            "tauri://localhost:43123/chat",
            "http://tauri.localhost:43123/chat",
            "https://tauri.localhost:43123/chat",
            "http://127.0.0.1:43123/api/status",
            "http://user@tauri.localhost",
            "https://user:secret@tauri.localhost",
            "file:///tmp/index.html",
        ] {
            assert!(!is_allowed_main_navigation(&Url::parse(rejected).unwrap()));
        }
    }

    #[test]
    fn readiness_state_has_stable_command_semantics() {
        let sidecar = OwnedSidecar::new();
        assert_eq!(sidecar.ready(), Ok(false));
        sidecar.set_ready();
        assert_eq!(sidecar.ready(), Ok(true));
        sidecar.set_failed("failed".to_string());
        assert_eq!(sidecar.ready(), Err("failed".to_string()));
    }
}
