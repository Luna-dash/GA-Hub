#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    env, fs,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    Manager, RunEvent, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use url::Url;
use uuid::Uuid;

#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::{
    io::{AsRawHandle, FromRawHandle, OwnedHandle},
    process::CommandExt,
};

#[cfg(windows)]
use windows_sys::Win32::{
    Foundation::{HANDLE, INVALID_HANDLE_VALUE},
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
    },
};

#[cfg(all(windows, test))]
use windows_sys::Win32::System::JobObjects::{
    JobObjectBasicAccountingInformation, QueryInformationJobObject,
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
};

const READY_TIMEOUT: Duration = Duration::from_secs(120);
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
const FORCE_REAP_TIMEOUT: Duration = Duration::from_secs(2);
#[cfg(unix)]
const GROUP_TERM_TIMEOUT: Duration = Duration::from_secs(1);
const PROCESS_POLL_INTERVAL: Duration = Duration::from_millis(50);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, PartialEq, Eq)]
enum SidecarPhase {
    Spawning,
    Running,
    Ready,
    Failed(String),
    Stopping,
    Stopped,
}

struct SidecarLifecycle<P> {
    phase: SidecarPhase,
    process: Option<P>,
}

enum ShutdownClaim<P> {
    Owner(Option<P>),
    InProgress,
    Complete,
}

impl<P> SidecarLifecycle<P> {
    fn new() -> Self {
        Self {
            phase: SidecarPhase::Spawning,
            process: None,
        }
    }

    fn commit_spawn(&mut self, process: P) -> Result<(), P> {
        if self.phase == SidecarPhase::Spawning && self.process.is_none() {
            self.process = Some(process);
            self.phase = SidecarPhase::Running;
            Ok(())
        } else {
            Err(process)
        }
    }

    fn mark_ready(&mut self) -> bool {
        if self.phase == SidecarPhase::Running && self.process.is_some() {
            self.phase = SidecarPhase::Ready;
            true
        } else {
            false
        }
    }

    fn mark_failed(&mut self, error: String) -> bool {
        if matches!(self.phase, SidecarPhase::Spawning | SidecarPhase::Running) {
            self.phase = SidecarPhase::Failed(error);
            true
        } else {
            false
        }
    }

    fn readiness(&self) -> Result<bool, String> {
        match &self.phase {
            SidecarPhase::Ready => Ok(true),
            SidecarPhase::Failed(error) => Err(error.clone()),
            SidecarPhase::Spawning
            | SidecarPhase::Running
            | SidecarPhase::Stopping
            | SidecarPhase::Stopped => Ok(false),
        }
    }

    fn begin_shutdown(&mut self) -> ShutdownClaim<P> {
        match self.phase {
            SidecarPhase::Stopping => ShutdownClaim::InProgress,
            SidecarPhase::Stopped => ShutdownClaim::Complete,
            _ => {
                self.phase = SidecarPhase::Stopping;
                ShutdownClaim::Owner(self.process.take())
            }
        }
    }

    fn finish_shutdown(&mut self) {
        if self.phase == SidecarPhase::Stopping {
            self.phase = SidecarPhase::Stopped;
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitPhase {
    Running = 0,
    Cleaning = 1,
    AllowExit = 2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExitAction {
    StartCleanup,
    WaitForCleanup,
    AllowExit,
}

#[derive(Clone)]
struct ExitCoordinator {
    phase: Arc<AtomicU8>,
}

impl ExitCoordinator {
    fn new() -> Self {
        Self {
            phase: Arc::new(AtomicU8::new(ExitPhase::Running as u8)),
        }
    }

    fn phase(&self) -> ExitPhase {
        match self.phase.load(Ordering::Acquire) {
            value if value == ExitPhase::Running as u8 => ExitPhase::Running,
            value if value == ExitPhase::Cleaning as u8 => ExitPhase::Cleaning,
            value if value == ExitPhase::AllowExit as u8 => ExitPhase::AllowExit,
            _ => ExitPhase::Cleaning,
        }
    }

    fn is_running(&self) -> bool {
        self.phase() == ExitPhase::Running
    }

    fn request_exit(&self) -> ExitAction {
        loop {
            match self.phase() {
                ExitPhase::Running => {
                    if self
                        .phase
                        .compare_exchange(
                            ExitPhase::Running as u8,
                            ExitPhase::Cleaning as u8,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        )
                        .is_ok()
                    {
                        return ExitAction::StartCleanup;
                    }
                }
                ExitPhase::Cleaning => return ExitAction::WaitForCleanup,
                ExitPhase::AllowExit => return ExitAction::AllowExit,
            }
        }
    }

    fn allow_exit(&self) {
        self.phase
            .store(ExitPhase::AllowExit as u8, Ordering::Release);
    }
}

#[cfg(windows)]
struct KillOnCloseJob(OwnedHandle);

#[cfg(windows)]
impl KillOnCloseJob {
    fn new() -> Result<Self, String> {
        let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if raw.is_null() {
            return Err(format!(
                "CreateJobObjectW failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        // OwnedHandle closes the job on every return path. The kill-on-close
        // limit then tears down any descendant still attached to the job.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw as _) };
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle.as_raw_handle() as HANDLE,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            return Err(format!(
                "SetInformationJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self(handle))
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        let assigned = unsafe {
            AssignProcessToJobObject(
                self.0.as_raw_handle() as HANDLE,
                child.as_raw_handle() as HANDLE,
            )
        };
        if assigned == 0 {
            return Err(format!(
                "AssignProcessToJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn terminate(&self) -> bool {
        unsafe { TerminateJobObject(self.0.as_raw_handle() as HANDLE, 1) != 0 }
    }

    #[cfg(test)]
    fn active_processes(&self) -> Result<u32, String> {
        let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe {
            QueryInformationJobObject(
                self.0.as_raw_handle() as HANDLE,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if queried == 0 {
            return Err(format!(
                "QueryInformationJobObject failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(accounting.ActiveProcesses)
    }
}

#[cfg(windows)]
fn resume_suspended_main_thread(process_id: u32) -> Result<(), String> {
    let snapshot_raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot_raw == INVALID_HANDLE_VALUE {
        return Err(format!(
            "CreateToolhelp32Snapshot failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot_raw as _) };
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut has_entry =
        unsafe { Thread32First(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
    while has_entry {
        if entry.th32OwnerProcessID == process_id {
            let thread_raw = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread_raw.is_null() {
                return Err(format!(
                    "OpenThread failed for suspended sidecar: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let thread = unsafe { OwnedHandle::from_raw_handle(thread_raw as _) };
            let previous_count = unsafe { ResumeThread(thread.as_raw_handle() as HANDLE) };
            if previous_count == u32::MAX {
                return Err(format!(
                    "ResumeThread failed for suspended sidecar: {}",
                    std::io::Error::last_os_error()
                ));
            }
            if previous_count != 1 {
                return Err(format!(
                    "suspended sidecar had unexpected thread suspend count {previous_count}"
                ));
            }
            return Ok(());
        }
        has_entry = unsafe { Thread32Next(snapshot.as_raw_handle() as HANDLE, &mut entry) } != 0;
    }
    Err(format!(
        "suspended sidecar main thread was not found for process {process_id}"
    ))
}

struct OwnedProcess {
    // Keep the Windows job before the Child handle so field teardown closes
    // the kill-on-close job first, while the root process handle is still live.
    #[cfg(windows)]
    job: KillOnCloseJob,
    #[cfg(unix)]
    process_group: libc::pid_t,
    #[cfg(unix)]
    group_swept: bool,
    child: Child,
    cleanup_complete: bool,
}

impl OwnedProcess {
    fn spawn(mut command: Command) -> Result<Self, String> {
        #[cfg(unix)]
        command.process_group(0);

        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);

        #[cfg(windows)]
        let job = KillOnCloseJob::new()?;

        let mut child = command
            .spawn()
            .map_err(|e| format!("sidecar spawn failed: {e}"))?;

        #[cfg(windows)]
        {
            if let Err(error) = job.assign(&child) {
                // Assignment is performed immediately after CreateProcess. If
                // it fails, use the platform fallback before dropping the job;
                // the child was never owned by the kill-on-close handle.
                force_stop_unmanaged_child(&mut child);
                return Err(error);
            }
            if let Err(error) = resume_suspended_main_thread(child.id()) {
                let _ = job.terminate();
                let _ = child.kill();
                let _ = wait_for_raw_child_exit(&mut child, FORCE_REAP_TIMEOUT);
                return Err(error);
            }
            Ok(Self {
                job,
                child,
                cleanup_complete: false,
            })
        }

        #[cfg(unix)]
        {
            let process_group = libc::pid_t::try_from(child.id())
                .map_err(|_| "sidecar pid cannot be represented as a process group".to_string());
            let process_group = match process_group {
                Ok(value) if value > 0 => value,
                Ok(_) | Err(_) => {
                    let _ = child.kill();
                    let _ = wait_for_raw_child_exit(&mut child, FORCE_REAP_TIMEOUT);
                    return Err("sidecar process group allocation failed".to_string());
                }
            };
            return Ok(Self {
                process_group,
                group_swept: false,
                child,
                cleanup_complete: false,
            });
        }
    }

    #[cfg(windows)]
    fn root_has_exited(&mut self) -> std::io::Result<bool> {
        self.child.try_wait().map(|status| status.is_some())
    }

    #[cfg(unix)]
    fn root_has_exited(&mut self) -> std::io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                self.process_group as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { info.si_pid() } != 0)
    }

    fn finish_exited_tree(&mut self) -> bool {
        #[cfg(windows)]
        let _ = self.job.terminate();

        #[cfg(unix)]
        {
            // waitid(WNOWAIT) left the exited group leader unreaped, so its
            // PID/PGID cannot be reused before this final descendant sweep.
            if !self.group_swept {
                let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
                self.group_swept = true;
            }
        }

        let reaped = matches!(self.child.try_wait(), Ok(Some(_)));
        self.cleanup_complete = reaped;
        reaped
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        if self.cleanup_complete {
            return;
        }

        // Drop cannot wait without risking a destructor-time deadlock. It does
        // make one last non-blocking tree/root termination request. On Windows,
        // OwnedHandle then closes the kill-on-close job before Child is dropped.
        #[cfg(windows)]
        {
            let _ = self.job.terminate();
            let _ = self.child.kill();
        }
        #[cfg(unix)]
        {
            if self.group_swept {
                return;
            }
            let _ = unsafe { libc::kill(-self.process_group, libc::SIGKILL) };
            self.group_swept = true;
            let _ = self.child.kill();
        }
    }
}

#[derive(Clone)]
struct OwnedSidecar {
    lifecycle: Arc<Mutex<SidecarLifecycle<OwnedProcess>>>,
}

impl OwnedSidecar {
    fn new() -> Self {
        Self {
            lifecycle: Arc::new(Mutex::new(SidecarLifecycle::new())),
        }
    }

    fn commit_spawn(
        &self,
        process: OwnedProcess,
        exit: &ExitCoordinator,
    ) -> Result<(), OwnedProcess> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if !exit.is_running() {
            return Err(process);
        }
        lifecycle.commit_spawn(process)
    }

    fn set_ready(&self, exit: &ExitCoordinator) -> bool {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        exit.is_running() && lifecycle.mark_ready()
    }

    fn set_failed(&self, error: String, exit: &ExitCoordinator) -> bool {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        exit.is_running() && lifecycle.mark_failed(error)
    }

    fn child_root_has_exited(&self) -> std::io::Result<Option<bool>> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let Some(process) = lifecycle.process.as_mut() else {
            return Ok(None);
        };
        let exited = process.root_has_exited()?;
        if exited {
            let _ = process.finish_exited_tree();
        }
        Ok(Some(exited))
    }

    fn take_owner_stdin(&self) -> Option<std::process::ChildStdin> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .process
            .as_mut()
            .and_then(|process| process.child.stdin.take())
    }

    fn begin_shutdown(&self) -> ShutdownClaim<OwnedProcess> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .begin_shutdown()
    }

    fn finish_shutdown(&self) {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .finish_shutdown();
    }

    fn ready(&self) -> Result<bool, String> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .readiness()
    }

    /// Discard the finished lifecycle so a fresh supervisor can spawn again.
    /// Only valid right after `finish_shutdown`.
    fn reset(&self) {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        *lifecycle = SidecarLifecycle::new();
    }

    /// Claim the current owner for a user-requested restart.
    ///
    /// Only Ready and Failed phases are restartable: Spawning/Running still
    /// have a live supervisor thread that owns the next transition, and
    /// Stopping/Stopped belong to shutdown coordination. The claim mirrors
    /// `begin_shutdown`, so the regular close path stays mutually exclusive
    /// with an in-flight restart.
    fn try_begin_restart(&self) -> Result<ShutdownClaim<OwnedProcess>, String> {
        let mut lifecycle = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if !restartable(&lifecycle.phase) {
            return Err("后端还在启动中，请稍候再试".to_string());
        }
        Ok(lifecycle.begin_shutdown())
    }
}

/// Whether a user-requested restart may claim this phase.
fn restartable(phase: &SidecarPhase) -> bool {
    matches!(phase, SidecarPhase::Ready | SidecarPhase::Failed(_))
}

/// Port/token pair the shell allocated for the owning sidecar. Kept in managed
/// state so `restart_backend` can respawn with the identical identity — the
/// frontend's injected runtime config therefore survives a restart untouched.
#[derive(Default)]
struct SidecarIdentity(Mutex<Option<(u16, String)>>);

#[tauri::command]
fn save_text_export(target: String, contents: String) -> Result<(), String> {
    fs::write(&target, contents).map_err(|e| format!("export write failed: {e}"))
}

#[tauri::command]
fn desktop_backend_ready(sidecar: tauri::State<'_, OwnedSidecar>) -> Result<bool, String> {
    sidecar.ready()
}

/// Stop the owning sidecar and respawn it with the identical port/token.
///
/// The claim/stop/respawn runs on a worker thread because the graceful stop
/// can block for several seconds. The frontend keeps polling
/// `desktop_backend_ready` meanwhile and reloads once the new process is live.
#[tauri::command]
fn restart_backend(
    sidecar: tauri::State<'_, OwnedSidecar>,
    identity: tauri::State<'_, SidecarIdentity>,
    exit: tauri::State<'_, ExitCoordinator>,
) -> Result<(), String> {
    if !exit.is_running() {
        return Err("应用正在关闭，无法重启后端".to_string());
    }
    let (port, token) = identity
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "后端运行信息缺失，请重启应用后再试".to_string())?;
    let claim = sidecar.try_begin_restart()?;
    let worker_sidecar = sidecar.inner().clone();
    let worker_exit = exit.inner().clone();
    let spawn_result = std::thread::Builder::new()
        .name("backend-restart".to_string())
        .spawn(move || {
            if let ShutdownClaim::Owner(Some(mut process)) = claim {
                stop_owned_process(&mut process);
            }
            worker_sidecar.finish_shutdown();
            worker_sidecar.reset();
            if let Err(error) =
                spawn_background_supervisor(worker_sidecar.clone(), port, token, worker_exit.clone())
            {
                eprintln!("backend restart respawn failed: {error}");
                let _ = worker_sidecar.set_failed(
                    format!("GA-Hub desktop restart: {error}"),
                    &worker_exit,
                );
            }
        });
    if let Err(error) = spawn_result {
        // Roll the claim back into a coherent, diagnosable state instead of
        // leaving the lifecycle stuck in Stopping forever.
        sidecar.finish_shutdown();
        sidecar.reset();
        let _ = sidecar.set_failed(format!("GA-Hub desktop restart: {error}"), exit.inner());
        return Err(format!("无法创建重启任务：{error}"));
    }
    Ok(())
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

fn allocate_sidecar_identity() -> Result<(u16, String), String> {
    let token = Uuid::new_v4().to_string();
    let probe = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("sidecar port allocation failed: {e}"))?;
    let port = probe
        .local_addr()
        .map_err(|e| format!("sidecar port lookup failed: {e}"))?
        .port();
    drop(probe);
    Ok((port, token))
}

fn spawn_sidecar(port: u16, token: &str) -> Result<OwnedProcess, String> {
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
            token,
            "--owned-stdin",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    OwnedProcess::spawn(command)
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
    exit: &ExitCoordinator,
) -> Result<ReadinessWait, String> {
    let deadline = Instant::now() + READY_TIMEOUT;
    let address = format!("127.0.0.1:{port}")
        .parse()
        .map_err(|e| format!("invalid sidecar address: {e}"))?;
    while Instant::now() < deadline {
        if !exit.is_running() {
            return Ok(ReadinessWait::Cancelled);
        }

        // Never retain the lifecycle lock while connecting, reading, or sleeping.
        // Window shutdown can therefore take ownership of the child immediately,
        // even while the packaged one-file sidecar is still extracting.
        let child_status = sidecar
            .child_root_has_exited()
            .map_err(|e| format!("sidecar status check failed: {e}"))?;
        match child_status {
            Some(true) => return Err("sidecar exited before readiness".to_string()),
            Some(false) => {}
            None if !exit.is_running() => return Ok(ReadinessWait::Cancelled),
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
    if let Some(mut stdin) = sidecar.take_owner_stdin() {
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
    }
}

fn run_sidecar_supervisor<F>(
    sidecar: OwnedSidecar,
    port: u16,
    token: String,
    exit: ExitCoordinator,
    spawn: F,
) where
    F: FnOnce(u16, &str) -> Result<OwnedProcess, String>,
{
    if !exit.is_running() {
        return;
    }

    let process = match spawn(port, &token) {
        Ok(process) => process,
        Err(error) => {
            let _ = sidecar.set_failed(format!("GA-Hub desktop startup: {error}"), &exit);
            return;
        }
    };

    // The lifecycle lock and ExitCoordinator check form one commit point with
    // shutdown. If close won first, this process never enters shared ownership
    // and is stopped locally. If commit won first, shutdown must observe and
    // take the process from the same lock.
    if let Err(mut process) = sidecar.commit_spawn(process, &exit) {
        stop_owned_process(&mut process);
        return;
    }

    match wait_http_ready(&sidecar, port, &token, &exit) {
        Ok(ReadinessWait::Ready) => {
            let _ = sidecar.set_ready(&exit);
        }
        Ok(ReadinessWait::Cancelled) => {}
        Err(error) => {
            if sidecar.set_failed(format!("GA-Hub desktop startup: {error}"), &exit) {
                // Keep the Child in the shared owner slot so CloseRequested can
                // still take it immediately. This quick request handles the usual
                // timeout case without transferring ownership to this worker.
                request_owned_shutdown(&sidecar);
            }
        }
    }
}

fn spawn_background_supervisor(
    sidecar: OwnedSidecar,
    port: u16,
    token: String,
    exit: ExitCoordinator,
) -> Result<(), String> {
    thread::Builder::new()
        .name("desktop-sidecar-supervisor".to_string())
        .spawn(move || run_sidecar_supervisor(sidecar, port, token, exit, spawn_sidecar))
        .map(|_| ())
        .map_err(|error| format!("sidecar supervisor thread failed: {error}"))
}

// ── Browser debug bridge ────────────────────────────────────────────────────
// The desktop sidecar binds a random loopback port, which makes browser
// debugging awkward. The shell therefore also binds a FIXED loopback port
// (default 8765) and forwards raw TCP to the sidecar port. HTTP and WebSocket
// are both plain TCP streams at this layer, so byte-level forwarding needs no
// protocol awareness. The bridge is purely additive: a bind failure only
// disables it, and the port's occupant is never attached to or terminated.

const DEBUG_BRIDGE_DEFAULT_PORT: u16 = 8765;
const BRIDGE_CONNECT_ATTEMPTS: u32 = 10;
const BRIDGE_CONNECT_DELAY: Duration = Duration::from_millis(200);
const BRIDGE_POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Resolve the debug bridge port from `GA_HUB_BRIDGE_PORT`:
/// unset/empty → default, "0" → disabled, valid → that port, garbage → disabled.
fn parse_debug_bridge_port(value: Option<String>) -> Option<u16> {
    let Some(raw) = value else {
        return Some(DEBUG_BRIDGE_DEFAULT_PORT);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Some(DEBUG_BRIDGE_DEFAULT_PORT);
    }
    if trimmed == "0" {
        return None;
    }
    match trimmed.parse::<u16>() {
        Ok(port) if port >= 1 => Some(port),
        _ => {
            eprintln!(
                "GA_HUB_BRIDGE_PORT={trimmed:?} is not a valid port; \
                 the browser debug bridge stays disabled"
            );
            None
        }
    }
}

fn configured_debug_bridge_port() -> Option<u16> {
    parse_debug_bridge_port(env::var("GA_HUB_BRIDGE_PORT").ok())
}

fn spawn_debug_bridge(exit: ExitCoordinator, sidecar_port: u16, bridge_port: u16) {
    let spawned = thread::Builder::new()
        .name("debug-bridge".to_string())
        .spawn(move || run_debug_bridge(exit, sidecar_port, bridge_port));
    if let Err(error) = spawned {
        eprintln!("debug bridge thread failed to start: {error}");
    }
}

fn run_debug_bridge(exit: ExitCoordinator, sidecar_port: u16, bridge_port: u16) {
    match TcpListener::bind(("127.0.0.1", bridge_port)) {
        Ok(listener) => run_debug_bridge_on(listener, sidecar_port, exit),
        Err(error) => eprintln!(
            "browser debug bridge disabled: 127.0.0.1:{bridge_port} is unavailable ({error}); \
             its current occupant was left untouched"
        ),
    }
}

fn run_debug_bridge_on(listener: TcpListener, sidecar_port: u16, exit: ExitCoordinator) {
    let _ = listener.set_nonblocking(true);
    while exit.is_running() {
        match listener.accept() {
            Ok((client, _)) => {
                if !exit.is_running() {
                    drop(client);
                    break;
                }
                let spawned = thread::Builder::new()
                    .name("debug-bridge-conn".to_string())
                    .spawn(move || handle_bridge_client(client, sidecar_port));
                if let Err(error) = spawned {
                    eprintln!("debug bridge connection thread failed: {error}");
                }
            }
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(BRIDGE_POLL_INTERVAL);
            }
            Err(error) => {
                eprintln!("debug bridge accept failed: {error}");
                thread::sleep(BRIDGE_POLL_INTERVAL);
            }
        }
    }
}

fn handle_bridge_client(client: TcpStream, sidecar_port: u16) {
    let _ = client.set_nodelay(true);
    // The sidecar port is stable across restart_backend, but the process may
    // be between spawns; retry briefly, then just drop the connection.
    let Some(upstream) =
        connect_with_retry(sidecar_port, BRIDGE_CONNECT_ATTEMPTS, BRIDGE_CONNECT_DELAY)
    else {
        return;
    };
    forward_between(client, upstream);
}

fn connect_with_retry(port: u16, attempts: u32, delay: Duration) -> Option<TcpStream> {
    for _ in 0..attempts {
        match TcpStream::connect(("127.0.0.1", port)) {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Some(stream);
            }
            Err(_) => thread::sleep(delay),
        }
    }
    None
}

/// Full-duplex raw forwarding between two established streams. When either
/// direction ends, the peer's write half is shut down so the other pump sees
/// EOF and both halves finish promptly.
fn forward_between(client: TcpStream, upstream: TcpStream) {
    let Ok(client_read) = client.try_clone() else {
        return;
    };
    let Ok(upstream_read) = upstream.try_clone() else {
        return;
    };
    let client_to_sidecar = thread::spawn(move || pump(client_read, upstream));
    pump(upstream_read, client);
    let _ = client_to_sidecar.join();
}

fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(size) => {
                if to.write_all(&buffer[..size]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = to.shutdown(Shutdown::Write);
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

fn wait_for_raw_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(None) | Err(_) => return false,
        }
    }
}

fn wait_for_child_exit(process: &mut OwnedProcess, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match process.root_has_exited() {
            Ok(true) => return process.finish_exited_tree(),
            Ok(false) if Instant::now() < deadline => thread::sleep(PROCESS_POLL_INTERVAL),
            Ok(false) | Err(_) => return false,
        }
    }
}

#[cfg(windows)]
fn force_stop_unmanaged_child(child: &mut Child) {
    let pid = child.id().to_string();
    if let Ok(mut killer) = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
    {
        if !wait_for_raw_child_exit(&mut killer, FORCE_REAP_TIMEOUT) {
            let _ = killer.kill();
        }
    }
    let _ = child.kill();
    let _ = wait_for_raw_child_exit(child, FORCE_REAP_TIMEOUT);
}

fn force_stop_owned_process(process: &mut OwnedProcess) -> bool {
    #[cfg(windows)]
    {
        let _ = process.job.terminate();
        // TerminateJobObject can fail (for example if the job is already being
        // torn down). Always target the root child as an independent fallback.
        let _ = process.child.kill();
    }

    #[cfg(unix)]
    {
        // The group leader is deliberately left unreaped during this grace
        // period, so its process-group id cannot be reused before SIGKILL.
        let _ = unsafe { libc::kill(-process.process_group, libc::SIGTERM) };
        thread::sleep(GROUP_TERM_TIMEOUT);
        let _ = unsafe { libc::kill(-process.process_group, libc::SIGKILL) };
        process.group_swept = true;
        // A process-group signal can fail or race with group teardown. The root
        // Child handle remains an independent, owned fallback.
        let _ = process.child.kill();
    }
    wait_for_child_exit(process, FORCE_REAP_TIMEOUT)
}

fn stop_owned_process(process: &mut OwnedProcess) {
    if process.cleanup_complete {
        return;
    }
    #[cfg(unix)]
    if process.group_swept {
        process.cleanup_complete = matches!(process.child.try_wait(), Ok(Some(_)));
        return;
    }
    if let Some(mut stdin) = process.child.stdin.take() {
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
    }
    let stopped = wait_for_child_exit(process, STOP_TIMEOUT) || force_stop_owned_process(process);
    process.cleanup_complete = stopped;
}

fn stop_owned(sidecar: &OwnedSidecar) {
    let ShutdownClaim::Owner(process) = sidecar.begin_shutdown() else {
        return;
    };
    if let Some(mut process) = process {
        stop_owned_process(&mut process);
    }
    sidecar.finish_shutdown();
}

fn spawn_background_shutdown(handle: tauri::AppHandle, exit: ExitCoordinator) {
    thread::spawn(move || {
        stop_owned(&handle.state::<OwnedSidecar>());
        exit.allow_exit();
        handle.exit(0);
    });
}

/// 自适应屏幕：设计基准 1320×860 逻辑客户区。所有尺寸/位置约束都作用在
/// **外框**上——客户区贴边通过 ≠ 外框入界（200% 缩放屏 860 客户区 + 36
/// 装饰 = 896 外框 > 864 工作区，底部压进任务栏）。装饰增量建窗后实测；
/// Windows 的 center() 按整屏居中、无视任务栏，定位一律显式钳制。
fn fit_main_window_to_work_area<R: Runtime>(window: &WebviewWindow<R>) {
    const DESIGN_W: f64 = 1320.0;
    const DESIGN_H: f64 = 860.0;
    const EDGE_MARGIN: f64 = 16.0; // 工作区每边呼吸边距（逻辑 px）
    const ABSOLUTE_MIN_W: f64 = 640.0;
    const ABSOLUTE_MIN_H: f64 = 480.0;
    let monitor = match window.current_monitor().ok().flatten() {
        Some(monitor) => monitor,
        None => match window.primary_monitor().ok().flatten() {
            Some(monitor) => monitor,
            None => return,
        },
    };
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return;
    }
    let work = monitor.work_area();
    let work_x = f64::from(work.position.x) / scale;
    let work_y = f64::from(work.position.y) / scale;
    let avail_w = f64::from(work.size.width) / scale;
    let avail_h = f64::from(work.size.height) / scale;
    // 装饰增量 = 外框 − 客户区（物理 px 实测 → 逻辑）
    let (Ok(outer), Ok(inner)) = (window.outer_size(), window.inner_size()) else {
        return;
    };
    let decor_w = f64::from(outer.width.saturating_sub(inner.width)) / scale;
    let decor_h = f64::from(outer.height.saturating_sub(inner.height)) / scale;
    // 外框 ≤ 工作区 − 2×边距 反解出的客户区上限
    let max_w = (avail_w - EDGE_MARGIN * 2.0 - decor_w).max(ABSOLUTE_MIN_W);
    let max_h = (avail_h - EDGE_MARGIN * 2.0 - decor_h).max(ABSOLUTE_MIN_H);
    if avail_w - EDGE_MARGIN * 2.0 - decor_w < ABSOLUTE_MIN_W
        || avail_h - EDGE_MARGIN * 2.0 - decor_h < ABSOLUTE_MIN_H
    {
        // 极小屏：连下限都装不下，最大化是唯一体面解
        let _ = window.maximize();
        return;
    }
    let target_w = DESIGN_W.min(max_w);
    let target_h = DESIGN_H.min(max_h);
    let _ = window.set_size(tauri::LogicalSize::new(target_w, target_h));
    // 外框在工作区内居中（天然满足边距），钳制只作兜底
    let outer_w = target_w + decor_w;
    let outer_h = target_h + decor_h;
    let px = work_x + ((avail_w - outer_w) / 2.0).max(0.0);
    let py = work_y + ((avail_h - outer_h) / 2.0).max(0.0);
    let px = px.clamp(work_x, work_x + (avail_w - outer_w).max(0.0));
    let py = py.clamp(work_y, work_y + (avail_h - outer_h).max(0.0));
    let _ = window.set_position(tauri::PhysicalPosition::new(
        (px * scale).round() as i32,
        (py * scale).round() as i32,
    ));
}

fn main_window_is_offscreen<R: Runtime>(window: &WebviewWindow<R>) -> bool {
    let Ok(position) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let Ok(monitors) = window.available_monitors() else {
        return false;
    };
    if monitors.is_empty() {
        return false;
    }

    let left = i64::from(position.x);
    let top = i64::from(position.y);
    let right = left + i64::from(size.width);
    let bottom = top + i64::from(size.height);

    monitors.iter().all(|monitor| {
        let monitor_position = monitor.position();
        let monitor_size = monitor.size();
        let monitor_left = i64::from(monitor_position.x);
        let monitor_top = i64::from(monitor_position.y);
        let monitor_right = monitor_left + i64::from(monitor_size.width);
        let monitor_bottom = monitor_top + i64::from(monitor_size.height);
        right <= monitor_left
            || left >= monitor_right
            || bottom <= monitor_top
            || top >= monitor_bottom
    })
}

fn reveal_main_window<R: Runtime>(window: &WebviewWindow<R>) {
    let minimized = window.is_minimized().unwrap_or(false);
    let offscreen = main_window_is_offscreen(window);
    if minimized {
        let _ = window.unminimize();
    }
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
    }
    if offscreen {
        let _ = window.center();
    }
    let _ = window.set_focus();
}

fn main() {
    let exit = ExitCoordinator::new();
    let exit_setup = exit.clone();
    let exit_single_instance = exit.clone();
    let exit_state = exit.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(move |app, _, _| {
            if !exit_single_instance.is_running() {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                reveal_main_window(&window);
            }
        }))
        .manage(OwnedSidecar::new())
        .manage(SidecarIdentity::default())
        .manage(exit_state)
        .invoke_handler(tauri::generate_handler![
            save_text_export,
            desktop_backend_ready,
            restart_backend
        ])
        .setup(move |app| {
            // The existing frontend contract reads this identity synchronously
            // from the initialization script. Port reservation and UUID creation
            // are intentionally the only sidecar preparation left in setup.
            let (port, token) =
                allocate_sidecar_identity().map_err(|e| format!("GA-Hub desktop startup: {e}"))?;
            // Persist the identity so restart_backend can respawn with the
            // exact same port/token — the SPA's injected runtime config and
            // WebSocket cursors stay valid across a restart.
            {
                let identity = app.state::<SidecarIdentity>();
                *identity.0.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some((port, token.clone()));
            }
            // Fixed-port browser debug bridge (default 127.0.0.1:8765 → the
            // sidecar's random port). Additive only: a bind failure disables
            // the bridge without blocking desktop startup, and the port's
            // occupant is never touched. The target port survives
            // restart_backend, so no bridge reconfiguration is needed.
            if let Some(bridge_port) = configured_debug_bridge_port() {
                spawn_debug_bridge(exit_setup.clone(), port, bridge_port);
            }
            let owned = app.state::<OwnedSidecar>().inner().clone();
            let runtime_script = runtime_initialization_script(port, &token);
            let main_window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(runtime_script)
                .on_navigation(is_allowed_main_navigation)
                .title("GA-Hub")
                .inner_size(1320.0, 860.0)
                // min 与 ABSOLUTE_MIN 对齐：更小的逻辑工作区走最大化兜底
                .min_inner_size(640.0, 480.0)
                .center()
                .resizable(true)
                .build()?;

            fit_main_window_to_work_area(&main_window);

            // CreateProcess, Windows Job / Unix process-group setup, PyInstaller
            // extraction, and HTTP readiness all run off the Tauri setup thread.
            if let Err(error) =
                spawn_background_supervisor(owned.clone(), port, token, exit_setup.clone())
            {
                let _ = owned.set_failed(format!("GA-Hub desktop startup: {error}"), &exit_setup);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build GA-Hub desktop shell");

    app.run(move |handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { api, .. },
            ..
        } if label == "main" => match exit.request_exit() {
            ExitAction::StartCleanup => {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
                spawn_background_shutdown(handle.clone(), exit.clone());
            }
            ExitAction::WaitForCleanup => api.prevent_close(),
            ExitAction::AllowExit => {}
        },
        RunEvent::ExitRequested { api, .. } => match exit.request_exit() {
            ExitAction::StartCleanup => {
                api.prevent_exit();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
                spawn_background_shutdown(handle.clone(), exit.clone());
            }
            ExitAction::WaitForCleanup => api.prevent_exit(),
            ExitAction::AllowExit => {}
        },
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_bridge_port_parsing_covers_disable_and_garbage() {
        assert_eq!(parse_debug_bridge_port(None), Some(8765));
        assert_eq!(parse_debug_bridge_port(Some(String::new())), Some(8765));
        assert_eq!(parse_debug_bridge_port(Some(" 8765 ".into())), Some(8765));
        assert_eq!(parse_debug_bridge_port(Some("9000".into())), Some(9000));
        assert_eq!(parse_debug_bridge_port(Some("0".into())), None);
        assert_eq!(parse_debug_bridge_port(Some("abc".into())), None);
        assert_eq!(parse_debug_bridge_port(Some("99999".into())), None);
    }

    #[test]
    fn connect_with_retry_reports_failure_without_hanging() {
        // Loopback port 1 is not served by this test environment; a single
        // 1 ms attempt keeps the test fast while proving the give-up path.
        assert!(connect_with_retry(1, 1, Duration::from_millis(1)).is_none());
    }

    #[test]
    fn debug_bridge_forwards_bytes_between_browser_and_sidecar() {
        // Minimal fake sidecar: accept one connection and echo everything.
        let upstream = TcpListener::bind("127.0.0.1:0").unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let fake_sidecar = thread::spawn(move || {
            let (mut socket, _) = upstream.accept().unwrap();
            let mut buffer = [0u8; 2048];
            let size = socket.read(&mut buffer).unwrap();
            let _ = socket.write_all(&buffer[..size]);
        });

        let exit = ExitCoordinator::new();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let bridge_port = listener.local_addr().unwrap().port();
        let bridge_exit = exit.clone();
        let bridge_thread = thread::spawn(move || {
            run_debug_bridge_on(listener, upstream_port, bridge_exit)
        });
        thread::sleep(Duration::from_millis(150));

        let mut client = TcpStream::connect(("127.0.0.1", bridge_port)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let request = b"GET /api/desktop/ready HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        client.write_all(request).unwrap();

        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        assert_eq!(response, request.to_vec());

        drop(client);
        exit.request_exit();
        bridge_thread.join().unwrap();
        fake_sidecar.join().unwrap();
    }

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
        let mut ready = SidecarLifecycle::new();
        assert_eq!(ready.readiness(), Ok(false));
        assert_eq!(ready.commit_spawn(()), Ok(()));
        assert_eq!(ready.readiness(), Ok(false));
        assert!(ready.mark_ready());
        assert_eq!(ready.readiness(), Ok(true));

        let mut failed = SidecarLifecycle::<()>::new();
        assert!(failed.mark_failed("failed".to_string()));
        assert_eq!(failed.readiness(), Err("failed".to_string()));
    }

    #[test]
    fn restart_is_rejected_outside_ready_and_failed_phases() {
        assert!(restartable(&SidecarPhase::Ready));
        assert!(restartable(&SidecarPhase::Failed("boom".to_string())));
        for phase in [
            SidecarPhase::Spawning,
            SidecarPhase::Running,
            SidecarPhase::Stopping,
            SidecarPhase::Stopped,
        ] {
            assert!(!restartable(&phase), "phase {phase:?} must not be restartable");
        }
    }

    #[test]
    fn restart_claim_follows_the_shutdown_exclusion_path_then_resets() {
        let mut lifecycle = SidecarLifecycle::<()>::new();
        // Spawning: a live supervisor owns the transition — not restartable.
        assert!(!restartable(&lifecycle.phase));
        lifecycle.commit_spawn(()).unwrap();
        assert!(lifecycle.mark_ready());

        // Ready → claim → stop → Stopped → fresh lifecycle for respawn.
        assert!(restartable(&lifecycle.phase));
        let ShutdownClaim::Owner(Some(())) = lifecycle.begin_shutdown() else {
            panic!("ready lifecycle must yield its owned process");
        };
        assert_eq!(lifecycle.phase, SidecarPhase::Stopping);
        lifecycle.finish_shutdown();
        assert_eq!(lifecycle.phase, SidecarPhase::Stopped);
        lifecycle = SidecarLifecycle::new();
        assert_eq!(lifecycle.readiness(), Ok(false));
    }

    #[test]
    fn shutdown_before_spawn_commit_rejects_the_late_process() {
        let mut lifecycle = SidecarLifecycle::<u32>::new();
        assert!(matches!(
            lifecycle.begin_shutdown(),
            ShutdownClaim::Owner(None)
        ));
        assert_eq!(lifecycle.phase, SidecarPhase::Stopping);
        assert_eq!(lifecycle.commit_spawn(41), Err(41));

        lifecycle.finish_shutdown();
        assert_eq!(lifecycle.phase, SidecarPhase::Stopped);
        assert_eq!(lifecycle.commit_spawn(42), Err(42));
    }

    #[test]
    fn late_readiness_or_error_cannot_revive_shutdown() {
        let mut lifecycle = SidecarLifecycle::new();
        assert_eq!(lifecycle.commit_spawn(7_u32), Ok(()));
        assert!(matches!(
            lifecycle.begin_shutdown(),
            ShutdownClaim::Owner(Some(7))
        ));

        assert!(!lifecycle.mark_ready());
        assert!(!lifecycle.mark_failed("late failure".to_string()));
        assert_eq!(lifecycle.phase, SidecarPhase::Stopping);

        lifecycle.finish_shutdown();
        assert!(!lifecycle.mark_ready());
        assert!(!lifecycle.mark_failed("later failure".to_string()));
        assert_eq!(lifecycle.phase, SidecarPhase::Stopped);
        assert_eq!(lifecycle.readiness(), Ok(false));
    }

    #[test]
    fn shutdown_claim_is_idempotent_and_has_one_cleanup_owner() {
        let mut lifecycle = SidecarLifecycle::new();
        assert_eq!(lifecycle.commit_spawn(9_u32), Ok(()));
        assert!(matches!(
            lifecycle.begin_shutdown(),
            ShutdownClaim::Owner(Some(9))
        ));
        assert!(matches!(
            lifecycle.begin_shutdown(),
            ShutdownClaim::InProgress
        ));

        lifecycle.finish_shutdown();
        assert!(matches!(
            lifecycle.begin_shutdown(),
            ShutdownClaim::Complete
        ));
    }

    #[test]
    fn exit_coordinator_blocks_repeat_requests_until_cleanup_finishes() {
        let exit = ExitCoordinator::new();
        let worker = exit.clone();
        assert!(exit.is_running());
        assert_eq!(exit.request_exit(), ExitAction::StartCleanup);
        assert_eq!(worker.phase(), ExitPhase::Cleaning);
        assert_eq!(worker.request_exit(), ExitAction::WaitForCleanup);
        worker.allow_exit();
        assert_eq!(exit.request_exit(), ExitAction::AllowExit);
    }

    #[cfg(windows)]
    #[test]
    fn suspended_job_owns_and_terminates_descendant_tree() {
        let mut command = Command::new("cmd.exe");
        command
            .args(["/D", "/C", "ping.exe 127.0.0.1 -n 30 >NUL"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut process = OwnedProcess::spawn(command).expect("owned test process should start");

        let deadline = Instant::now() + Duration::from_secs(3);
        let mut observed_descendant = false;
        while Instant::now() < deadline {
            if process
                .job
                .active_processes()
                .expect("test job accounting should be readable")
                >= 2
            {
                observed_descendant = true;
                break;
            }
            thread::sleep(PROCESS_POLL_INTERVAL);
        }
        if !observed_descendant {
            stop_owned_process(&mut process);
            panic!("resumed job should contain cmd.exe and its ping.exe descendant");
        }

        let terminated = process.job.terminate();
        let exited = wait_for_child_exit(&mut process, FORCE_REAP_TIMEOUT);
        if !exited {
            stop_owned_process(&mut process);
        }
        assert!(terminated, "test job should accept tree termination");
        assert!(exited, "terminating the job must stop its root child");
    }
}
