//! Minimalist, self-contained Rust green updater for GA-Hub / Gyra portable installs.
//!
//! Replaces the legacy 10 MB PyInstaller updater + Windows Scheduled Task +
//! 60-second countdown ceremony with a ~500 KB native executable supporting:
//! - `--help`: build-time runtime selftest
//! - `--admin-data <dir> launch [--launcher-pid <pid>]`: redirect old shortcuts
//!   to `<admin-data>/updates/current.json`
//! - `--admin-data <dir> switch --plan <id> --wait-pid <pid> --old-exe <path>`:
//!   verify SHA-256 of every staged file, wait for the old desktop to exit,
//!   atomically switch `current.json`, start the new desktop, verify its
//!   startup receipt + `/api/updates/ready` (with nonce), and automatically
//!   roll back to `--old-exe` if health verification fails.
//! - `--admin-data <dir> recover [--plan <id>]`: clear an unresolved update
//!   state after confirming no old/candidate instances are still running.

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
        "ga-hub-update (Gyra / GA-Hub portable green updater)\n\
         Usage:\n\
         \tga-hub-update --help\n\
         \tga-hub-update --admin-data <dir> launch [--launcher-pid <pid>]\n\
         \tga-hub-update --admin-data <dir> switch --plan <id> --wait-pid <pid> --old-exe <path>\n\
         \tga-hub-update --admin-data <dir> recover [--plan <id>]"
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

#[cfg(windows)]
fn replace_file_atomic(tmp: &Path, dst: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let src_w: Vec<u16> = tmp.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let dst_w: Vec<u16> = dst.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let ok = unsafe {
        MoveFileExW(
            src_w.as_ptr(),
            dst_w.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        return Err(format!("MoveFileExW failed: {err}"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file_atomic(tmp: &Path, dst: &Path) -> Result<(), String> {
    fs::rename(tmp, dst).map_err(|e| format!("atomic replace failed: {e}"))
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    let tmp = path.with_extension(format!("{}.tmp", Uuid::new_v4().simple()));
    {
        let mut f = File::create(&tmp).map_err(|e| format!("create tmp failed: {e}"))?;
        f.write_all(bytes)
            .map_err(|e| format!("write tmp failed: {e}"))?;
        let _ = f.sync_all();
    }
    if let Err(err) = replace_file_atomic(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }
    Ok(())
}

fn atomic_write_json(path: &Path, value: &Value) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| format!("json encode failed: {e}"))?;
    atomic_write_bytes(path, &bytes)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read(path).map_err(|e| format!("read {} failed: {e}", path.display()))?;
    serde_json::from_slice(&raw).map_err(|e| format!("parse {} failed: {e}", path.display()))
}

fn record_pre_switch_failure(state_path: &Path, plan: &mut Value, reason: &str) {
    if let Some(obj) = plan.as_object_mut() {
        obj.insert("state".to_string(), json!("failed"));
        obj.insert("switch_started".to_string(), json!(false));
        obj.insert("error".to_string(), json!(reason));
    }
    let _ = atomic_write_json(state_path, plan);
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
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB);
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
                fallback.creation_flags(CREATE_NO_WINDOW);
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

fn http_request_loopback(port: u16, req: &str) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2)).ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    stream.write_all(req.as_bytes()).ok()?;
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    Some(response)
}

fn http_status_is_ok(response: &str) -> bool {
    let Some(status_line) = response.lines().next() else {
        return false;
    };
    status_line.starts_with("HTTP/1.") && status_line.contains(" 200")
}

fn updates_ready_response_ok(response: &str, expected_nonce: &str) -> bool {
    if !http_status_is_ok(response) {
        return false;
    }
    let Some((_, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return false;
    };
    let nonce_ok = value.get("nonce").and_then(Value::as_str) == Some(expected_nonce);
    let ready = value.get("ready").and_then(Value::as_bool).unwrap_or(false);
    let diagnostic_ready = value
        .get("diagnostic_ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    nonce_ok && (ready || diagnostic_ready)
}

fn probe_ready_http(port: u16, expected_nonce: &str) -> bool {
    let req = format!(
        "GET /api/updates/ready HTTP/1.1\r\n\
         Host: 127.0.0.1:{port}\r\n\
         X-Update-Nonce: {expected_nonce}\r\n\
         Connection: close\r\n\r\n"
    );
    http_request_loopback(port, &req)
        .map(|resp| updates_ready_response_ok(&resp, expected_nonce))
        .unwrap_or(false)
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
                if nonce_ok && port > 0 && port <= 65535 && probe_ready_http(port as u16, expected_nonce) {
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

fn cmd_recover(admin_data: &Path, expected_plan_id: Option<&str>) -> Result<(), String> {
    let updates_dir = admin_data.join("updates");
    let state_path = updates_dir.join("state.json");
    let _ = fs::remove_file(updates_dir.join("maintenance.json"));
    if !state_path.is_file() {
        return Ok(());
    }
    let mut plan = read_json(&state_path)?;
    if let Some(expected) = expected_plan_id {
        if plan.get("id").and_then(Value::as_str) != Some(expected) {
            return Err("update plan id mismatch".to_string());
        }
    }
    let state = plan.get("state").and_then(Value::as_str).unwrap_or("");
    if matches!(state, "armed" | "switching" | "verifying" | "failed" | "prepared") {
        if let Some(obj) = plan.as_object_mut() {
            obj.insert("state".to_string(), json!("cancelled"));
            obj.insert("switch_started".to_string(), json!(false));
            obj.insert("error".to_string(), json!("recovered manually via ga-hub-update recover"));
        }
        atomic_write_json(&state_path, &plan)?;
    }
    Ok(())
}

fn cmd_switch_with_timeouts(
    admin_data: &Path,
    plan_id: &str,
    wait_pid: u32,
    old_exe: &Path,
    exit_timeout: Duration,
    health_timeout: Duration,
) -> Result<(), String> {
    let updates_dir = admin_data.join("updates");
    let state_path = updates_dir.join("state.json");
    let current_path = updates_dir.join("current.json");
    let candidate_dir = updates_dir.join("versions").join(plan_id);

    let mut plan = read_json(&state_path)?;
    if plan.get("id").and_then(Value::as_str) != Some(plan_id) {
        return Err("update plan id mismatch".to_string());
    }
    if let Err(reason) = verify_candidate_hashes(&candidate_dir, &plan) {
        record_pre_switch_failure(&state_path, &mut plan, &reason);
        return Err(reason);
    }

    let candidate_exe = candidate_dir.join("ga-hub-desktop.exe");
    if !candidate_exe.is_file() {
        let reason = "candidate ga-hub-desktop.exe missing".to_string();
        record_pre_switch_failure(&state_path, &mut plan, &reason);
        return Err(reason);
    }

    // Ensure state is marked switching (pre-switch) before requesting old desktop closure.
    if let Some(obj) = plan.as_object_mut() {
        obj.insert("state".to_string(), json!("switching"));
        obj.insert("switch_started".to_string(), json!(false));
    }
    atomic_write_json(&state_path, &plan)?;

    if wait_pid > 0 {
        request_close_window(wait_pid);
        if !wait_for_pid_exit(wait_pid, exit_timeout) {
            let reason = format!("old desktop did not exit within {}s", exit_timeout.as_secs());
            record_pre_switch_failure(&state_path, &mut plan, &reason);
            return Err(reason);
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
            let verdict = wait_for_candidate_health(&mut child, &receipt_path, &nonce, health_timeout);
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
            // Roll back current.json atomically and relaunch the known-good old executable.
            if let Some(prev) = previous_current {
                let _ = atomic_write_bytes(&current_path, &prev);
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

fn cmd_switch(admin_data: &Path, plan_id: &str, wait_pid: u32, old_exe: &Path) -> Result<(), String> {
    cmd_switch_with_timeouts(
        admin_data,
        plan_id,
        wait_pid,
        old_exe,
        EXIT_WAIT_TIMEOUT,
        HEALTH_TIMEOUT,
    )
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
        Some("recover") => cmd_recover(&admin, plan_id.as_deref()),
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
    use std::net::TcpListener;

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
    fn parses_updates_ready_response_with_nonce_and_readiness() {
        let nonce = "a".repeat(64);
        let ok_ready = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{{\"ready\":true,\"diagnostic_ready\":false,\"nonce\":\"{nonce}\"}}"
        );
        let ok_diag = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{{\"ready\":false,\"diagnostic_ready\":true,\"nonce\":\"{nonce}\"}}"
        );
        let not_ready = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{{\"ready\":false,\"diagnostic_ready\":false,\"nonce\":\"{nonce}\"}}"
        );
        let wrong_nonce = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ready\":true,\"nonce\":\"wrong\"}";

        assert!(updates_ready_response_ok(&ok_ready, &nonce));
        assert!(updates_ready_response_ok(&ok_diag, &nonce));
        assert!(!updates_ready_response_ok(&not_ready, &nonce));
        assert!(!updates_ready_response_ok(wrong_nonce, &nonce));
        assert!(!updates_ready_response_ok("HTTP/1.1 404 Not Found\r\n\r\n", &nonce));
    }

    #[test]
    fn pre_switch_hash_failure_marks_failed_without_bricking_startup() {
        let admin = env::temp_dir().join(format!("gahub-upd-preswitch-{}", Uuid::new_v4().simple()));
        let updates = admin.join("updates");
        let plan_id = "b".repeat(32);
        let candidate_dir = updates.join("versions").join(&plan_id);
        fs::create_dir_all(&candidate_dir).unwrap();
        let desktop = candidate_dir.join("ga-hub-desktop.exe");
        fs::write(&desktop, b"tampered-bytes").unwrap();

        let state_path = updates.join("state.json");
        atomic_write_json(
            &state_path,
            &json!({
                "id": plan_id,
                "state": "switching",
                "switch_started": false,
                "version": "1.3.0",
                "data_epoch": DATA_EPOCH,
                "sha256": {
                    "ga-hub-desktop.exe": "0".repeat(64),
                }
            }),
        )
        .unwrap();

        let err = cmd_switch_with_timeouts(
            &admin,
            &plan_id,
            0,
            &admin.join("nonexistent-old.exe"),
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(err.contains("SHA-256 mismatch"), "unexpected err: {err}");

        let saved = read_json(&state_path).unwrap();
        assert_eq!(saved["state"], "failed");
        assert_eq!(saved["switch_started"], false);
        assert!(saved["error"].as_str().unwrap_or("").contains("SHA-256 mismatch"));

        let _ = fs::remove_dir_all(&admin);
    }

    #[test]
    fn cmd_switch_rolls_back_and_restores_previous_current_on_candidate_failure() {
        let admin = env::temp_dir().join(format!("gahub-upd-rollback-{}", Uuid::new_v4().simple()));
        let updates = admin.join("updates");
        let plan_id = "c".repeat(32);
        let candidate_dir = updates.join("versions").join(&plan_id);
        fs::create_dir_all(&candidate_dir).unwrap();

        // Non-executable bytes cause spawn_detached to fail cleanly on Windows (ERROR_BAD_EXE_FORMAT),
        // exercising the full rollback path without spawning real processes.
        let desktop = candidate_dir.join("ga-hub-desktop.exe");
        fs::write(&desktop, b"not-a-valid-pe-binary").unwrap();
        let prev_current = json!({
            "plan_id": "prev",
            "version": "1.2.0",
            "executable": "D:/old/ga-hub-desktop.exe"
        });
        let current_path = updates.join("current.json");
        atomic_write_json(&current_path, &prev_current).unwrap();

        let state_path = updates.join("state.json");
        atomic_write_json(
            &state_path,
            &json!({
                "id": plan_id,
                "state": "switching",
                "switch_started": false,
                "version": "1.3.0",
                "data_epoch": DATA_EPOCH,
                "sha256": {
                    "ga-hub-desktop.exe": sha256_file(&desktop).unwrap(),
                }
            }),
        )
        .unwrap();

        let result = cmd_switch_with_timeouts(
            &admin,
            &plan_id,
            0,
            &admin.join("missing-old.exe"),
            Duration::from_secs(1),
            Duration::from_secs(2),
        );
        assert!(result.is_err());

        let saved = read_json(&state_path).unwrap();
        assert_eq!(saved["state"], "rolled_back");
        assert_eq!(saved["switch_started"], true);
        assert_eq!(read_json(&current_path).unwrap(), prev_current);

        let _ = fs::remove_dir_all(&admin);
    }

    #[test]
    fn wait_for_candidate_health_verifies_receipt_and_updates_ready_nonce() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let nonce = "d".repeat(64);
        let expected = nonce.clone();

        let server = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut req = [0u8; 1024];
                let n = stream.read(&mut req).unwrap_or(0);
                let text = String::from_utf8_lossy(&req[..n]);
                let has_nonce = text.to_ascii_lowercase().contains(&format!("x-update-nonce: {expected}"));
                let body = if has_nonce {
                    format!("{{\"ready\":true,\"diagnostic_ready\":false,\"nonce\":\"{expected}\"}}")
                } else {
                    "{\"ready\":false}".to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });

        assert!(probe_ready_http(port, &nonce));
        server.join().unwrap();
    }

    #[test]
    fn cmd_recover_unblocks_unresolved_switching_state() {
        let admin = env::temp_dir().join(format!("gahub-upd-recover-{}", Uuid::new_v4().simple()));
        let updates = admin.join("updates");
        let plan_id = "e".repeat(32);
        let state_path = updates.join("state.json");
        atomic_write_json(
            &state_path,
            &json!({
                "id": plan_id,
                "state": "verifying",
                "switch_started": true,
            }),
        )
        .unwrap();
        fs::write(updates.join("maintenance.json"), "{}").unwrap();

        assert!(cmd_recover(&admin, Some(&plan_id)).is_ok());
        assert!(!updates.join("maintenance.json").exists());
        let saved = read_json(&state_path).unwrap();
        assert_eq!(saved["state"], "cancelled");
        assert_eq!(saved["switch_started"], false);

        let _ = fs::remove_dir_all(&admin);
    }
}
