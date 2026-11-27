//! Minimalist, self-contained Rust green updater for GA-Hub portable installs.
//!
//! Replaces the legacy 10 MB PyInstaller updater + Windows Scheduled Task +
//! 60-second countdown ceremony with a ~500 KB native executable supporting:
//! - `--help`: build-time runtime selftest
//! - `--admin-data <dir> launch [--launcher-pid <pid>]`: redirect old shortcuts
//!   to `<admin-data>/updates/current.json`
//! - `--admin-data <dir> switch --plan <id> --wait-pid <pid> --old-exe <path>`:
//!   verify SHA-256 of every staged file, wait for the old desktop to exit,
//!   atomically switch `current.json`, start the new desktop, verify its
//!   startup receipt + `/api/desktop/ready`, and automatically roll back to
//!   `--old-exe` if health verification fails.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const DATA_EPOCH: u64 = 2;
const EXIT_WAIT_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

fn print_usage() {
    println!(
        "ga-hub-update (GA-Hub portable green updater)\n\
         Usage:\n\
         \tga-hub-update --help\n\
         \tga-hub-update --admin-data <dir> launch [--launcher-pid <pid>]\n\
         \tga-hub-update --admin-data <dir> switch --plan <id> --wait-pid <pid> --old-exe <path>"
    );
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let tmp = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("json encode failed: {e}"))?;
    {
        let mut f = File::create(&tmp).map_err(|e| format!("create tmp failed: {e}"))?;
        f.write_all(&bytes)
            .map_err(|e| format!("write tmp failed: {e}"))?;
        let _ = f.sync_all();
    }
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("atomic replace failed: {e}")
    })
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
    serde_json::from_slice(&raw).map_err(|e| format!("parse {} failed: {e}", path.display()))
}

fn verify_candidate_hashes(candidate_dir: &Path, plan: &Value) -> Result<(), String> {
    let epoch = plan
        .get("data_epoch")
        .and_then(Value::as_u64)
        .ok_or_else(|| "missing data_epoch in update plan".to_string())?;
    if epoch != DATA_EPOCH {
        return Err(format!("unsupported data_epoch {epoch}, expected {DATA_EPOCH}"));
    }
    let hashes = plan
        .get("sha256")
        .and_then(Value::as_object)
        .ok_or_else(|| "missing sha256 map in update plan".to_string())?;
    if hashes.is_empty() {
        return Err("empty sha256 map in update plan".to_string());
    }
    for (rel, expected_val) in hashes {
        if rel.contains("..") || rel.starts_with('/') || rel.starts_with('\\') {
            return Err(format!("unsafe manifest path: {rel}"));
        }
        let expected = expected_val
            .as_str()
            .ok_or_else(|| format!("non-string hash for {rel}"))?;
        let target = candidate_dir.join(rel);
        let meta = fs::symlink_metadata(&target)
            .map_err(|e| format!("missing candidate file {rel}: {e}"))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(format!("invalid candidate file type: {rel}"));
        }
        let actual = sha256_file(&target)?;
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!("SHA-256 mismatch for {rel}"));
        }
    }
    Ok(())
}

fn spawn_detached(exe: &Path, extra_envs: &[(&str, String)]) -> Result<Child, String> {
    let mut cmd = Command::new(exe);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(parent) = exe.parent() {
        cmd.current_dir(parent);
    }
    for (k, v) in extra_envs {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                let mut fallback = Command::new(exe);
                fallback
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
                if let Some(parent) = exe.parent() {
                    fallback.current_dir(parent);
                }
                for (k, v) in extra_envs {
                    fallback.env(k, v);
                }
                fallback.creation_flags(DETACHED_PROCESS);
                return fallback
                    .spawn()
                    .map_err(|e| format!("spawn {} failed: {e}", exe.display()));
            }
            Err(err) => return Err(format!("spawn {} failed: {err}", exe.display())),
        }
    }
    #[cfg(not(windows))]
    {
        cmd.spawn()
            .map_err(|e| format!("spawn {} failed: {e}", exe.display()))
    }
}

#[cfg(windows)]
fn request_close_window(pid: u32) {
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE,
    };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let target_pid = lparam as u32;
        let mut window_pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, &mut window_pid);
        if window_pid == target_pid {
            let _ = PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        1
    }

    unsafe {
        let _ = EnumWindows(Some(enum_proc), pid as LPARAM);
    }
}

#[cfg(not(windows))]
fn request_close_window(_pid: u32) {}

#[cfg(windows)]
fn wait_for_pid_exit(pid: u32, timeout: Duration) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // Already exited or not openable.
        return true;
    }
    let ms = timeout.as_millis().min(u32::MAX as u128) as u32;
    let wait = unsafe { WaitForSingleObject(handle, ms) };
    unsafe {
        let _ = CloseHandle(handle);
    }
    wait == WAIT_OBJECT_0
}

#[cfg(not(windows))]
fn wait_for_pid_exit(_pid: u32, _timeout: Duration) -> bool {
    true
}

fn probe_ready_http(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!(
        "GET /api/desktop/ready HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    http_status_is_ok(&response)
}

fn http_status_is_ok(response: &str) -> bool {
    let Some(status_line) = response.lines().next() else {
        return false;
    };
    status_line.starts_with("HTTP/1.") && status_line.contains(" 200")
}

fn wait_for_candidate_health(
    child: &mut Child,
    receipt_path: &Path,
    expected_nonce: &str,
    timeout: Duration,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("candidate desktop exited early ({status})"));
        }
        if receipt_path.is_file() {
            if let Ok(receipt) = read_json(receipt_path) {
                let nonce_ok = receipt.get("nonce").and_then(Value::as_str) == Some(expected_nonce);
                let port = receipt.get("port").and_then(Value::as_u64).unwrap_or(0);
                if nonce_ok && port > 0 && port <= 65535 && probe_ready_http(port as u16) {
                    return Ok(());
                }
            }
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err("candidate desktop failed to become ready before timeout".to_string())
}

fn prune_old_versions(versions_dir: &Path, keep_id: &str) {
    let Ok(entries) = fs::read_dir(versions_dir) else {
        return;
    };
    let mut others: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == keep_id {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        others.push((mtime, path));
    }
    others.sort_by(|a, b| b.0.cmp(&a.0));
    // Keep at most 1 previous version for safety, clean older ones.
    for (_, stale) in others.into_iter().skip(1) {
        let _ = fs::remove_dir_all(stale);
    }
}

fn cmd_launch(admin_data: &Path) -> Result<(), String> {
    let pointer = admin_data.join("updates").join("current.json");
    let data = read_json(&pointer)?;
    let target = data
        .get("executable")
        .and_then(Value::as_str)
        .ok_or_else(|| "invalid current.json: missing executable".to_string())?;
    let exe = PathBuf::from(target);
    if !exe.is_file() {
        return Err(format!("current target missing: {}", exe.display()));
    }
    let _ = spawn_detached(&exe, &[("GA_ADMIN_DATA", admin_data.to_string_lossy().into_owned())])?;
    Ok(())
}

fn cmd_switch(admin_data: &Path, plan_id: &str, wait_pid: u32, old_exe: &Path) -> Result<(), String> {
    let updates_dir = admin_data.join("updates");
    let state_path = updates_dir.join("state.json");
    let current_path = updates_dir.join("current.json");
    let candidate_dir = updates_dir.join("versions").join(plan_id);

    let mut plan = read_json(&state_path)?;
    if plan.get("id").and_then(Value::as_str) != Some(plan_id) {
        return Err("update plan id mismatch".to_string());
    }
    verify_candidate_hashes(&candidate_dir, &plan)?;

    let candidate_exe = candidate_dir.join("ga-hub-desktop.exe");
    if !candidate_exe.is_file() {
        return Err("candidate ga-hub-desktop.exe missing".to_string());
    }

    // Mark switching before closing the old desktop.
    if let Some(obj) = plan.as_object_mut() {
        obj.insert("state".to_string(), json!("switching"));
        obj.insert("switch_started".to_string(), json!(false));
    }
    atomic_write_json(&state_path, &plan)?;

    if wait_pid > 0 {
        request_close_window(wait_pid);
        if !wait_for_pid_exit(wait_pid, EXIT_WAIT_TIMEOUT) {
            if let Some(obj) = plan.as_object_mut() {
                obj.insert("state".to_string(), json!("failed"));
                obj.insert("switch_started".to_string(), json!(false));
                obj.insert(
                    "error".to_string(),
                    json!("old desktop did not exit within 15s"),
                );
            }
            let _ = atomic_write_json(&state_path, &plan);
            return Err("old desktop did not exit within timeout".to_string());
        }
    }

    let previous_current = if current_path.is_file() {
        fs::read(&current_path).ok()
    } else {
        None
    };

    if let Some(obj) = plan.as_object_mut() {
        obj.insert("state".to_string(), json!("verifying"));
        obj.insert("switch_started".to_string(), json!(true));
    }
    atomic_write_json(&state_path, &plan)?;

    atomic_write_json(
        &current_path,
        &json!({
            "plan_id": plan_id,
            "version": plan.get("version").cloned().unwrap_or(Value::Null),
            "executable": candidate_exe.to_string_lossy(),
        }),
    )?;

    let nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let receipt_path = updates_dir.join("receipts").join(format!("{plan_id}.json"));
    let _ = fs::remove_file(&receipt_path);

    let envs = vec![
        ("GA_ADMIN_DATA", admin_data.to_string_lossy().into_owned()),
        ("GA_HUB_UPDATE_NONCE", nonce.clone()),
        (
            "GA_HUB_UPDATE_RECEIPT",
            receipt_path.to_string_lossy().into_owned(),
        ),
    ];

    let spawn_res = spawn_detached(&candidate_exe, &envs);
    let health_res = match spawn_res {
        Ok(mut child) => {
            let verdict = wait_for_candidate_health(&mut child, &receipt_path, &nonce, HEALTH_TIMEOUT);
            if verdict.is_err() {
                let _ = child.kill();
                let _ = child.wait();
            }
            verdict
        }
        Err(err) => Err(err),
    };

    let _ = fs::remove_file(&receipt_path);

    match health_res {
        Ok(()) => {
            if let Some(obj) = plan.as_object_mut() {
                obj.insert("state".to_string(), json!("succeeded"));
                obj.remove("error");
            }
            atomic_write_json(&state_path, &plan)?;
            prune_old_versions(&updates_dir.join("versions"), plan_id);
            Ok(())
        }
        Err(reason) => {
            // Roll back current.json and relaunch the known-good old executable.
            if let Some(prev) = previous_current {
                let _ = fs::write(&current_path, prev);
            } else {
                let _ = fs::remove_file(&current_path);
            }
            if let Some(obj) = plan.as_object_mut() {
                obj.insert("state".to_string(), json!("rolled_back"));
                obj.insert("error".to_string(), json!(reason.clone()));
            }
            let _ = atomic_write_json(&state_path, &plan);

            if old_exe.is_file() {
                let rollback_nonce = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let _ = spawn_detached(
                    old_exe,
                    &[
                        ("GA_ADMIN_DATA", admin_data.to_string_lossy().into_owned()),
                        ("GA_HUB_UPDATE_NONCE", rollback_nonce),
                    ],
                );
            }
            Err(reason)
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "--help" || a == "-h") {
        print_usage();
        return Ok(());
    }

    let mut admin_data: Option<PathBuf> = None;
    let mut cmd: Option<String> = None;
    let mut plan_id: Option<String> = None;
    let mut wait_pid: u32 = 0;
    let mut old_exe: Option<PathBuf> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--admin-data" => {
                i += 1;
                admin_data = args.get(i).map(PathBuf::from);
            }
            "--plan" => {
                i += 1;
                plan_id = args.get(i).cloned();
            }
            "--wait-pid" => {
                i += 1;
                wait_pid = args
                    .get(i)
                    .and_then(|s| s.parse::<u32>().ok())
                    .unwrap_or(0);
            }
            "--launcher-pid" => {
                i += 1;
            }
            "--old-exe" => {
                i += 1;
                old_exe = args.get(i).map(PathBuf::from);
            }
            other if !other.starts_with('-') && cmd.is_none() => {
                cmd = Some(other.to_string());
            }
            other => return Err(format!("unknown argument: {other}")),
        }
        i += 1;
    }

    let admin = admin_data.ok_or_else(|| "--admin-data is required".to_string())?;
    match cmd.as_deref() {
        Some("launch") => cmd_launch(&admin),
        Some("switch") => {
            let id = plan_id.ok_or_else(|| "--plan is required".to_string())?;
            let old = old_exe.unwrap_or_default();
            cmd_switch(&admin, &id, wait_pid, &old)
        }
        other => Err(format!("unknown subcommand: {:?}", other)),
    }
}

fn main() {
    if let Err(err) = run() {
        eprintln!("ga-hub-update error: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifies_candidate_hashes_and_rejects_tampering() {
        let dir = env::temp_dir().join(format!("gahub-upd-test-{}", Uuid::new_v4().simple()));
        let sidecar = dir.join("sidecar");
        fs::create_dir_all(&sidecar).unwrap();
        let desktop = dir.join("ga-hub-desktop.exe");
        let sc = sidecar.join("ga-hub-sidecar.exe");
        fs::write(&desktop, b"desktop-bytes").unwrap();
        fs::write(&sc, b"sidecar-bytes").unwrap();

        let plan = json!({
            "id": "a".repeat(32),
            "data_epoch": DATA_EPOCH,
            "sha256": {
                "ga-hub-desktop.exe": sha256_file(&desktop).unwrap(),
                "sidecar/ga-hub-sidecar.exe": sha256_file(&sc).unwrap(),
            }
        });
        assert!(verify_candidate_hashes(&dir, &plan).is_ok());

        fs::write(&sc, b"tampered").unwrap();
        assert!(verify_candidate_hashes(&dir, &plan).is_err());

        let bad_path = json!({
            "id": "a".repeat(32),
            "data_epoch": DATA_EPOCH,
            "sha256": { "../escape.exe": "0".repeat(64) }
        });
        assert!(verify_candidate_hashes(&dir, &bad_path).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn parses_http_200_status_line() {
        assert!(http_status_is_ok("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{}"));
        assert!(!http_status_is_ok("HTTP/1.1 503 Service Unavailable\r\n\r\n"));
        assert!(!http_status_is_ok(""));
    }
}
