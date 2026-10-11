//! Owned message windows. All native window mutations run on the UI thread;
//! the mutex only protects data and is never held while calling a window API.
use std::{collections::VecDeque, sync::{mpsc, Mutex}, time::Duration};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

struct Request {
    label: String,
    config: Value,
    reply: mpsc::Sender<Result<Value, String>>,
    ready: bool,
}
#[derive(Default)]
struct Queue {
    pending: VecDeque<Request>,
    active: Option<Request>,
    closing: bool,
}
#[derive(Default)]
pub struct MessageDialogs(Mutex<Queue>);

fn cancelled(config: &Value) -> Value {
    if config["kind"] == "confirm" { json!(false) } else { Value::Null }
}
fn validate(config: &Value) -> Result<(), String> {
    if !matches!(config["kind"].as_str(), Some("alert" | "confirm" | "prompt"))
        || config["title"].as_str().is_none() {
        return Err("Invalid message dialog config".into());
    }
    if let Some(tone) = config.get("tone") {
        if !matches!(tone.as_str(), Some("default" | "danger")) { return Err("Invalid tone".into()); }
    }
    if config.get("multiline").is_some_and(|v| !v.is_boolean()) { return Err("Invalid multiline".into()); }
    for key in ["message", "defaultValue", "placeholder", "confirmText", "cancelText", "detail"] {
        if let Some(value) = config.get(key) {
            if !value.is_null() && !value.is_string() { return Err(format!("Invalid {key}")); }
        }
    }
    if config.to_string().len() > 512 * 1024 { return Err("Message dialog too large".into()); }
    Ok(())
}
fn valid_result(config: &Value, result: &Value) -> bool {
    match config["kind"].as_str() {
        Some("confirm") => result.is_boolean(),
        Some("prompt") => result.is_null() || result.is_string(),
        Some("alert") => result.is_null(),
        _ => false,
    }
}

// Called on the main thread, including timeouts and close handlers.
fn complete(app: &AppHandle, label: &str, result: Option<Result<Value, String>>) {
    let state = app.state::<MessageDialogs>();
    let request = {
        let mut queue = state.0.lock().unwrap();
        if queue.active.as_ref().map(|r| r.label.as_str()) != Some(label) { return; }
        queue.active.take().unwrap()
    };
    // Take before destroy: the Destroyed event cannot settle this request twice.
    if let Some(window) = app.get_webview_window(label) { let _ = window.destroy(); }
    if let Some(parent) = app.get_webview_window("main") {
        let _ = parent.set_enabled(true);
        let closing = state.0.lock().unwrap().closing;
        if !closing { let _ = parent.set_focus(); }
    }
    let result = result.unwrap_or_else(|| Ok(cancelled(&request.config)));
    let _ = request.reply.send(result);
    start_next(app);
}

fn start_next(app: &AppHandle) {
    let state = app.state::<MessageDialogs>();
    let (label, title) = {
        let mut queue = state.0.lock().unwrap();
        if queue.closing || queue.active.is_some() { return; }
        let Some(request) = queue.pending.pop_front() else { return; };
        let label = request.label.clone();
        let title = request.config["title"].as_str().unwrap_or("GA-Hub").to_string();
        queue.active = Some(request);
        (label, title)
    };
    let create = || -> Result<(), String> {
        let parent = app.get_webview_window("main").ok_or("Main window unavailable")?;
        let window = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("dialog.html".into()))
            .title(&title).inner_size(480.0, 240.0).min_inner_size(400.0, 160.0)
            .resizable(false).minimizable(false).maximizable(false)
            .visible(false).skip_taskbar(true).parent(&parent).map_err(|e| e.to_string())?
            .build().map_err(|e| e.to_string())?;
        let handle = app.clone();
        let closed_label = label.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed) {
                complete(&handle, &closed_label, None);
            }
        });
        // Only disable after creating the owned window successfully.
        parent.set_enabled(false).map_err(|e| e.to_string())?;
        window.center().map_err(|e| e.to_string())?;
        Ok(())
    };
    if let Err(error) = create() { complete(app, &label, Some(Err(error))); return; }
    // A load failure must never strand the parent in a disabled state.
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        let timer_app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let timed_out = timer_app.state::<MessageDialogs>().0.lock().unwrap().active
                .as_ref().is_some_and(|r| r.label == label && !r.ready);
            if timed_out { complete(&timer_app, &label, Some(Err("Message window did not load".into()))); }
        });
    });
}

#[tauri::command]
pub async fn show_message_dialog(window: WebviewWindow, app: AppHandle, config: Value) -> Result<Value, String> {
    if window.label() != "main" { return Err("Only main can open a message dialog".into()); }
    validate(&config)?;
    let (tx, rx) = mpsc::channel();
    let request = Request { label: format!("message-{}", uuid::Uuid::new_v4()), config, reply: tx, ready: false };
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<MessageDialogs>();
        {
            let mut queue = state.0.lock().unwrap();
            if queue.closing { let _ = request.reply.send(Ok(cancelled(&request.config))); return; }
            queue.pending.push_back(request);
        }
        start_next(&handle);
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || rx.recv().map_err(|e| e.to_string()))
        .await.map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn message_dialog_config(window: WebviewWindow, state: tauri::State<MessageDialogs>) -> Result<Value, String> {
    let queue = state.0.lock().unwrap();
    queue.active.as_ref().filter(|r| r.label == window.label())
        .map(|r| r.config.clone()).ok_or("Not the active message window".into())
}

#[tauri::command]
pub async fn message_dialog_ready(window: WebviewWindow, app: AppHandle, height: f64) -> Result<(), String> {
    let label = window.label().to_string();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<MessageDialogs>();
        {
            let mut queue = state.0.lock().unwrap();
            let Some(request) = queue.active.as_mut().filter(|r| r.label == label) else { return; };
            if request.ready { return; }
            request.ready = true;
        }
        let reveal = || -> Result<(), String> {
            let window = handle.get_webview_window(&label).ok_or("Message window unavailable")?;
            let max_height = window.current_monitor().ok().flatten()
                .map(|m| m.size().height as f64 / m.scale_factor() - 100.0).unwrap_or(650.0);
            let height = if height.is_finite() { height.clamp(160.0, max_height.clamp(160.0, 650.0)) } else { 240.0 };
            window.set_size(tauri::LogicalSize::new(480.0, height)).map_err(|e| e.to_string())?;
            window.center().map_err(|e| e.to_string())?;
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
            Ok(())
        };
        if let Err(error) = reveal() { complete(&handle, &label, Some(Err(error))); }
    }).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn message_dialog_finish(window: WebviewWindow, app: AppHandle, result: Value) -> Result<(), String> {
    let label = window.label().to_string();
    {
        let state = app.state::<MessageDialogs>();
        let queue = state.0.lock().unwrap();
        let request = queue.active.as_ref().filter(|r| r.label == label).ok_or("Not the active message window")?;
        if !valid_result(&request.config, &result) { return Err("Invalid message result".into()); }
    }
    let handle = app.clone();
    app.run_on_main_thread(move || complete(&handle, &label, Some(Ok(result)))).map_err(|e| e.to_string())
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<MessageDialogs>();
    let (active, pending) = {
        let mut queue = state.0.lock().unwrap();
        queue.closing = true;
        (queue.active.take(), std::mem::take(&mut queue.pending))
    };
    for request in active.into_iter().chain(pending) {
        if let Some(window) = app.get_webview_window(&request.label) { let _ = window.destroy(); }
        let _ = request.reply.send(Ok(cancelled(&request.config)));
    }
    if let Some(parent) = app.get_webview_window("main") { let _ = parent.set_enabled(true); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_preserves_public_contract() {
        assert_eq!(cancelled(&json!({"kind":"confirm"})), json!(false));
        assert_eq!(cancelled(&json!({"kind":"prompt"})), Value::Null);
        assert_eq!(cancelled(&json!({"kind":"alert"})), Value::Null);
    }
    #[test]
    fn validates_optional_fields_and_size_limits() {
        assert!(validate(&json!({"kind":"prompt","title":"编辑","tone":"default","multiline":true,"detail":"详情"})).is_ok());
        assert!(validate(&json!({"kind":"confirm","title":"删除","tone":"danger"})).is_ok());
        for extra in [json!({"tone":"unknown"}), json!({"multiline":"true"}), json!({"detail":3})] {
            let mut config = json!({"kind":"alert","title":"消息"});
            config.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            assert!(validate(&config).is_err());
        }
        assert!(validate(&json!({"kind":"alert","title":"消息","message":"x".repeat(512 * 1024)})).is_err());
        assert!(valid_result(&json!({"kind":"prompt"}), &json!("")));
        assert!(valid_result(&json!({"kind":"prompt"}), &Value::Null));
        assert!(valid_result(&json!({"kind":"confirm"}), &json!(false)));
    }
    #[test]
    fn rejects_malformed_configs_and_wrong_results() {
        assert!(validate(&json!({"kind":"confirm","title":"删除"})).is_ok());
        assert!(validate(&json!({"kind":"execute","title":"x"})).is_err());
        assert!(validate(&json!({"kind":"alert","title":"x","message":3})).is_err());
        assert!(!valid_result(&json!({"kind":"confirm"}), &json!("true")));
        assert!(valid_result(&json!({"kind":"prompt"}), &json!("新名字")));
        assert!(!valid_result(&json!({"kind":"alert"}), &json!(true)));
    }
}
