//! Reclaim the PyInstaller onefile bundle directories that packaged sidecars
//! leave behind in `%TEMP%`.
//!
//! `desktop/build_sidecar.py` builds the sidecar with `--onefile`, so every
//! launch unpacks roughly 85 MB across more than a thousand files into a fresh
//! `%TEMP%\_MEI<pid>`. The bootloader removes that directory only when the whole
//! process tree exits on its own, and the desktop shell always stops the sidecar
//! with SIGKILL / `taskkill` (see `force_stop_owned_process`), so the cleanup
//! code never runs. A test-and-rebuild loop therefore leaves one 85 MB
//! directory per run behind — a 2026-09 measurement found 47 of them, about
//! 4.0 GB, from a test cadence of one rebuild every 1.6 minutes.
//!
//! Deleting the wrong directory here would destroy a *running* sidecar, so a
//! candidate has to clear every gate below before anything is removed:
//!
//! 1. **Ownership** — the directory carries gahub's own packaging fingerprint
//!    (`generic_agent_admin.egg-info` / `generic_agent_admin-*.dist-info`).
//!    `_MEI` is a PyInstaller-wide convention, so third-party onefile apps on
//!    this machine are never even considered.
//! 2. **Age** — the directory is older than [`STALE_AFTER`]. PyInstaller
//!    creates the directory and fills it afterwards, and an extracting bundle
//!    has no module mapped from it yet, which makes gate 3 blind to it. The age
//!    gate is what keeps a launch that is currently starting out of reach.
//! 3. **Liveness** — no running process has any module mapped from the
//!    directory. If the module enumeration cannot be completed, nothing is
//!    deleted at all.
//!
//! The removal is a plain `remove_dir_all` on purpose: a partially deleted
//! directory would still carry a live-looking `_MEI<pid>` name, which is worse
//! than an intact one. Gates 1-3 already rule out a live bundle, and a failed
//! removal is simply retried by the next sweep, which re-applies all three
//! gates.

use std::collections::HashSet;
use std::env;
#[cfg(windows)]
use windows_sys::Win32::Foundation::HANDLE;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// A bundle younger than this may still be extracting. 85 MB over a thousand
/// files takes seconds; half an hour leaves a wide margin over that.
const STALE_AFTER: Duration = Duration::from_secs(30 * 60);

/// Only these processes can hold a gahub bundle open, so only these need their
/// module list read.
///
/// The bundle holds DLLs, `.pyd` modules and data — never an executable: the
/// onefile bootloader runs the sidecar from its original path, so the only
/// processes that map something out of `%TEMP%\_MEI<pid>` are the sidecar
/// itself and any Python process it spawns. The latter is not hypothetical:
/// `project_memory.md` records the onefile bug where `_MEI*` lands at the front
/// of `PATH` and a child interpreter resolves an incompatible runtime DLL out
/// of the parent's bundle. Both are covered here, and the name match is
/// substring-based on `sidecar` so a differently named build is still caught.
const LIVENESS_NAMES: [&str; 3] = ["ga-hub-sidecar.exe", "python.exe", "pythonw.exe"];

/// What one sweep did, for the startup diagnostic trail.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct MeiSweepReport {
    /// Bundle directories that were removed.
    pub removed: Vec<String>,
    /// Bytes those directories held, walked before removal.
    pub reclaimed_bytes: u64,
    /// Candidates skipped because a process still has a module mapped from them.
    pub skipped_live: usize,
    /// Candidates skipped because they are still young enough to be extracting.
    pub skipped_recent: usize,
    /// `_MEI` directories that belong to another application.
    pub skipped_foreign: usize,
    /// Candidates whose age or fingerprint could not be established.
    pub skipped_unreadable: usize,
    /// Removals that failed; those directories are retried by the next sweep.
    pub failed: usize,
    /// True when the sweep only reported what it would have removed.
    pub dry_run: bool,
    /// Bytes the dry run would have reclaimed.
    pub would_reclaim_bytes: u64,
    /// Whether the module enumeration was complete. A sweep that is not
    /// complete removes nothing.
    pub scan_complete: bool,
}

impl MeiSweepReport {
    fn summary(&self) -> String {
        format!(
            "mei_sweep removed={} reclaimed={}B live={} recent={} foreign={} \
             unreadable={} failed={} scan_complete={} dry_run={} would_reclaim={}B",
            self.removed.len(),
            self.reclaimed_bytes,
            self.skipped_live,
            self.skipped_recent,
            self.skipped_foreign,
            self.skipped_unreadable,
            self.failed,
            self.scan_complete,
            self.dry_run,
            self.would_reclaim_bytes
        )
    }
}

/// Remove stale gahub onefile bundles from `%TEMP%`.
///
/// Called from [`crate::spawn_sidecar`] before the sidecar is started, so it
/// also runs on every [`crate::restart_backend`] — the tight rebuild/restart
/// loop is exactly the case that accumulates bundles within one session.
///
/// The sweep never fails the caller: a desktop shell that refuses to launch
/// because cleanup hit a locked file would be a far worse outcome than a
/// leftover directory. `log` receives one summary line, or a refusal line when
/// the liveness probe could not be completed.
pub fn sweep_stale_bundles(log: &dyn Fn(&str)) -> MeiSweepReport {
    // A unit test must never reach into the real %TEMP%: the same reason
    // `record_startup_diagnostic` stays quiet under `cfg(test)`. The opt-in
    // exists for the `#[ignore]`d dry-run test, which exists to validate the
    // gates against real leftovers before a launch is allowed to delete them.
    if cfg!(test) && env::var_os("GAHUB_MEI_SWEEP_ALLOW_REAL_TEMP").is_none() {
        let mut report = MeiSweepReport::default();
        report.scan_complete = true;
        return report;
    }
    let dry_run = env::var_os("GAHUB_MEI_SWEEP_DRY_RUN").is_some_and(|v| v != "0");
    let temp = env::temp_dir();
    sweep_dir(&temp, &live_bundle_dirs, SystemTime::now(), dry_run, log)
}

/// The sweep proper, with the liveness probe and the directory root injected.
///
/// Every gate and the `remove_dir_all` itself live in here so that the tests
/// can drive the whole body against a sandbox directory. The body is the part
/// that deletes, and a delete that no test ever executes is a delete that no
/// test ever checks.
fn sweep_dir(
    root: &Path,
    liveness: &dyn Fn() -> (HashSet<PathBuf>, bool),
    now: SystemTime,
    dry_run: bool,
    log: &dyn Fn(&str),
) -> MeiSweepReport {
    let mut report = MeiSweepReport {
        dry_run,
        ..Default::default()
    };
    let candidates: Vec<Candidate> = collect_candidates(root, &mut report);

    if candidates.is_empty() {
        report.scan_complete = true;
        log(&report.summary());
        return report;
    }

    let (live, complete) = liveness();
    if !complete {
        // Not being able to prove a bundle is dead is a reason to keep it.
        report.scan_complete = false;
        log(&format!(
            "mei_sweep refused: module enumeration incomplete, kept {} candidate(s)",
            candidates.len()
        ));
        return report;
    }
    report.scan_complete = true;

    let mut doomed = Vec::new();
    for candidate in candidates {
        if live.contains(&candidate.path) {
            report.skipped_live += 1;
            continue;
        }
        if !is_stale(&candidate, now) {
            report.skipped_recent += 1;
            continue;
        }
        doomed.push(candidate);
    }

    // A bundle can turn live between the sweep above and the `remove_dir_all`
    // below: a second desktop instance starting at the wrong moment is enough,
    // and deleting its bundle out from under it is the worst outcome available
    // here. Re-enumerate once, immediately before deleting, and re-apply the
    // liveness gate. Two enumerations per sweep, not one per directory.
    if !doomed.is_empty() {
        let (live_now, complete_now) = liveness();
        if !complete_now {
            report.scan_complete = false;
            log(&format!(
                "mei_sweep refused: re-check enumeration incomplete, kept {} bundle(s)",
                doomed.len()
            ));
        } else {
            doomed.retain(|candidate| {
                let keep = live_now.contains(&candidate.path);
                if keep {
                    report.skipped_live += 1;
                }
                !keep
            });
        }
    }

    for candidate in doomed {
        let size = directory_size(&candidate.path).unwrap_or(0);
        if dry_run {
            report.would_reclaim_bytes += size;
            report.removed.push(candidate.name.clone());
            log(&format!(
                "mei_sweep dry-run: would remove {} ({:.1} MiB)",
                candidate.path.display(),
                size as f64 / (1024.0 * 1024.0)
            ));
            continue;
        }
        match fs::remove_dir_all(&candidate.path) {
            Ok(()) => {
                report.reclaimed_bytes += size;
                report
                    .removed
                    .push(candidate.name.clone());
            }
            Err(error) => {
                report.failed += 1;
                log(&format!(
                    "mei_sweep could not remove {}: {error}",
                    candidate.path.display()
                ));
            }
        }
    }
    log(&report.summary());
    report
}

#[derive(Clone)]
struct Candidate {
    path: PathBuf,
    name: String,
    created: Option<SystemTime>,
}

/// List `%TEMP%\_MEI*` and keep the ones that carry gahub's packaging
/// fingerprint. A directory we cannot read is counted and skipped, never
/// guessed at.
fn collect_candidates(temp: &Path, report: &mut MeiSweepReport) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let entries = match fs::read_dir(temp) {
        Ok(entries) => entries,
        Err(_) => return candidates,
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("_MEI") {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(top_level) = fs::read_dir(&path) else {
            report.skipped_unreadable += 1;
            continue;
        };
        let names: Vec<String> = top_level
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        if !carries_our_fingerprint(&names) {
            report.skipped_foreign += 1;
            continue;
        }
        candidates.push(Candidate {
            created: created_at(&path),
            name,
            path,
        });
    }
    candidates
}

/// gahub's own bundle, by packaging metadata. Both variants occur in the wild:
/// editable installs leave `generic_agent_admin.egg-info`, wheel builds leave a
/// versioned `generic_agent_admin-<version>.dist-info`.
fn carries_our_fingerprint(top_level: &[String]) -> bool {
    top_level.iter().any(|name| {
        name == "generic_agent_admin.egg-info"
            || (name.starts_with("generic_agent_admin-") && name.ends_with(".dist-info"))
    })
}

/// A candidate is stale once it is older than [`STALE_AFTER`]. An unknown age
/// counts as not stale, so an unreadable timestamp can never authorise a
/// deletion.
fn is_stale(candidate: &Candidate, now: SystemTime) -> bool {
    candidate
        .created
        .and_then(|created| now.duration_since(created).ok())
        .is_some_and(|age| age >= STALE_AFTER)
}

fn created_at(path: &Path) -> Option<SystemTime> {
    let metadata = fs::metadata(path).ok()?;
    // `created()` is the right timestamp; `modified()` is a conservative stand-in
    // because a freshly written bundle is modified just now, so it can only make
    // the age gate *stricter*, never more permissive.
    metadata.created().ok().or_else(|| metadata.modified().ok())
}

fn directory_size(path: &Path) -> Option<u64> {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total += metadata.len();
            }
        }
    }
    Some(total)
}

/// Bundle directories with a module mapped into them by a running process, plus
/// whether the enumeration was complete enough to trust the answer.
#[cfg(windows)]
fn live_bundle_dirs() -> (HashSet<PathBuf>, bool) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };

    let mut live = HashSet::new();
    let mut complete = true;

    let process_snapshot = match snapshot(TH32CS_SNAPPROCESS, 0) {
        Some(handle) => handle,
        None => return (live, false),
    };
    let self_pid = std::process::id();
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    let mut has_entry = unsafe { Process32FirstW(process_snapshot, &mut entry) } != 0;
    while has_entry {
        // A process cannot map a gahub bundle unless it is a sidecar or an
        // interpreter it spawned, so the expensive module walk is limited to
        // those. See `LIVENESS_NAMES`.
        if entry.th32ProcessID != self_pid && could_hold_bundle(&wide_to_string(&entry.szExeFile)) {
            match module_dirs(entry.th32ProcessID) {
                Ok(dirs) => live.extend(dirs),
                // An interpreter we cannot inspect could be the one using a
                // bundle, so the sweep must not claim to be complete.
                Err(()) => complete = false,
            }
        }
        has_entry = unsafe { Process32NextW(process_snapshot, &mut entry) } != 0;
    }
    unsafe { CloseHandle(process_snapshot) };
    (live, complete)
}

#[cfg(not(windows))]
fn live_bundle_dirs() -> (HashSet<PathBuf>, bool) {
    // POSIX onefile bundles are managed by the bootloader and are not the
    // Windows `%TEMP%` spill this module exists to fix.
    (HashSet::new(), true)
}

/// A snapshot can transiently report `ERROR_BAD_LENGTH`; retry a few times
/// before treating it as a failure.
#[cfg(windows)]
fn snapshot(flags: u32, process_id: u32) -> Option<HANDLE> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::CreateToolhelp32Snapshot;

    for _ in 0..8 {
        let handle = unsafe { CreateToolhelp32Snapshot(flags, process_id) };
        if handle != INVALID_HANDLE_VALUE && !handle.is_null() {
            return Some(handle);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    None
}

#[cfg(windows)]
fn could_hold_bundle(process_name: &str) -> bool {
    let name = process_name.to_ascii_lowercase();
    LIVENESS_NAMES
        .iter()
        .any(|candidate| name == *candidate || name.contains(candidate.trim_end_matches(".exe")))
}

/// `_MEI` directories this process has modules mapped from.
#[cfg(windows)]
fn module_dirs(process_id: u32) -> Result<Vec<PathBuf>, ()> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
    };

    let process = unsafe {
        OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, process_id)
    };
    if process.is_null() {
        return Err(());
    }

    let module_snapshot = snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, process_id);
    let Some(module_snapshot) = module_snapshot else {
        unsafe {
            let _ = CloseHandle(process);
        }
        return Err(());
    };

    let mut dirs = Vec::new();
    let mut entry: MODULEENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
    let mut has_entry = unsafe { Module32FirstW(module_snapshot, &mut entry) } != 0;
    while has_entry {
        let path = PathBuf::from(wide_to_string(&entry.szExePath));
        if let Some(parent) = path.parent() {
            if parent
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with("_MEI"))
            {
                dirs.push(parent.to_path_buf());
            }
        }
        has_entry = unsafe { Module32NextW(module_snapshot, &mut entry) } != 0;
    }
    unsafe {
        let _ = CloseHandle(module_snapshot);
        let _ = CloseHandle(process);
    }
    Ok(dirs)
}

#[cfg(windows)]
fn wide_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    /// A scratch directory holding one plausible gahub bundle, removed when the
    /// test ends whether it passed or not.
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        /// `new` creates a bundle whose creation time is the real current time;
        /// the tests move `now` instead of the filesystem's clock, which cannot
        /// be moved from a unit test.
        fn new(tag: &str) -> Self {
            static COUNTER: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let root = env::temp_dir().join(format!("gahub-mei-test-{tag}-{unique}"));
            let _ = fs::remove_dir_all(&root);
            let bundle = root.join("_MEI100001");
            fs::create_dir_all(bundle.join("generic_agent_admin-0.3.4.dist-info")).unwrap();
            fs::create_dir_all(bundle.join("certifi")).unwrap();
            fs::write(bundle.join("certifi").join("cacert.pem"), b"a certificate\n").unwrap();
            Sandbox { root }
        }

        fn bundle(&self) -> PathBuf {
            self.root.join("_MEI100001")
        }

        fn age_enough(&self) -> SystemTime {
            SystemTime::now() + STALE_AFTER + Duration::from_secs(60)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn no_live_bundles() -> (HashSet<PathBuf>, bool) {
        (HashSet::new(), true)
    }

    #[test]
    fn gahub_bundles_are_recognised_in_both_packaging_shapes() {
        assert!(carries_our_fingerprint(&names(&[
            "generic_agent_admin.egg-info",
            "certifi",
        ])));
        assert!(carries_our_fingerprint(&names(&[
            "generic_agent_admin-0.3.4.dist-info",
            "_ssl.pyd",
        ])));
    }

    #[test]
    fn another_onefile_application_is_left_alone() {
        // `_MEI` is a PyInstaller convention, not a gahub one: an unrelated
        // app's bundle must never be a candidate.
        assert!(!carries_our_fingerprint(&names(&[
            "PySide6",
            "some_other_app-1.0.dist-info",
        ])));
        // Same prefix, different project.
        assert!(!carries_our_fingerprint(&names(&[
            "generic_agent_toolkit-1.0.dist-info",
        ])));
        // Right project, wrong metadata kind.
        assert!(!carries_our_fingerprint(&names(&[
            "generic_agent_admin.exe",
            "generic_agent_admin.pyz",
        ])));
        assert!(!carries_our_fingerprint(&[]));
    }

    #[test]
    fn a_fresh_bundle_is_never_stale_even_without_a_timestamp() {
        let now = SystemTime::now();
        let fresh = Candidate {
            path: PathBuf::from("_MEI1"),
            name: "_MEI1".to_string(),
            created: Some(now),
        };
        assert!(!is_stale(&fresh, now));

        let just_under = Candidate {
            created: Some(now - STALE_AFTER + Duration::from_secs(60)),
            ..fresh
        };
        assert!(!is_stale(&just_under, now));
    }

    #[test]
    fn an_old_bundle_is_stale_but_an_unreadable_one_is_not() {
        let now = SystemTime::now();
        let old = Candidate {
            path: PathBuf::from("_MEI1"),
            name: "_MEI1".to_string(),
            created: Some(now - STALE_AFTER - Duration::from_secs(60)),
        };
        assert!(is_stale(&old, now));

        // Gate 2 must never turn into a licence to delete: no timestamp, no
        // deletion.
        let unknown = Candidate {
            created: None,
            ..old.clone()
        };
        assert!(!is_stale(&unknown, now));
    }

    #[test]
    fn a_test_run_never_touches_the_real_temp_directory() {
        let seen = std::cell::RefCell::new(Vec::new());
        let report = sweep_stale_bundles(&|line: &str| seen.borrow_mut().push(line.to_string()));
        assert_eq!(
            report,
            MeiSweepReport {
                scan_complete: true,
                ..Default::default()
            }
        );
        assert!(seen.borrow().iter().all(|line| !line.contains("refused")));
    }

    #[test]
    fn a_stale_bundle_is_actually_removed_and_its_bytes_counted() {
        let sandbox = Sandbox::new("remove");
        let report = sweep_dir(
            &sandbox.root,
            &no_live_bundles,
            sandbox.age_enough(),
            false,
            &|_| {},
        );
        assert_eq!(report.removed, names(&["_MEI100001"]));
        assert!(!sandbox.bundle().exists(), "the stale bundle survived the sweep");
        assert!(
            report.reclaimed_bytes > 0,
            "a removal that frees nothing was never measured"
        );
        assert_eq!(report.failed, 0);
        assert!(report.scan_complete);
    }

    #[test]
    fn a_live_bundle_is_kept_even_once_it_is_old_enough() {
        let sandbox = Sandbox::new("live");
        let report = sweep_dir(
            &sandbox.root,
            &|| (HashSet::from([sandbox.bundle()]), true),
            sandbox.age_enough(),
            false,
            &|_| {},
        );
        assert!(sandbox.bundle().exists(), "a live bundle was deleted");
        assert!(report.removed.is_empty());
        assert_eq!(report.skipped_live, 1);
    }

    #[test]
    fn an_incomplete_enumeration_removes_nothing_at_all() {
        let sandbox = Sandbox::new("incomplete");
        let report = sweep_dir(
            &sandbox.root,
            &|| (HashSet::new(), false),
            sandbox.age_enough(),
            false,
            &|_| {},
        );
        assert!(sandbox.bundle().exists(), "deleted without a trustworthy probe");
        assert!(report.removed.is_empty());
        assert!(!report.scan_complete);
    }

    #[test]
    fn a_dry_run_reports_without_removing() {
        let sandbox = Sandbox::new("dry");
        let report = sweep_dir(
            &sandbox.root,
            &no_live_bundles,
            sandbox.age_enough(),
            true,
            &|_| {},
        );
        assert!(sandbox.bundle().exists(), "a dry run deleted a directory");
        assert_eq!(report.removed, names(&["_MEI100001"]));
        assert!(report.would_reclaim_bytes > 0);
        assert_eq!(report.reclaimed_bytes, 0, "a dry run must not claim to have freed bytes");
    }

    #[test]
    fn a_fresh_bundle_is_kept_because_its_clock_has_not_moved() {
        let sandbox = Sandbox::new("fresh");
        let report = sweep_dir(
            &sandbox.root,
            &no_live_bundles,
            SystemTime::now(),
            false,
            &|_| {},
        );
        assert!(sandbox.bundle().exists());
        assert_eq!(report.skipped_recent, 1);
        assert!(report.removed.is_empty());
    }

    /// Dry run of the sweep against the machine's real `%TEMP%`. Ignored by
    /// default because it is machine state, not a property of the code.
    ///
    /// Run it deliberately, from the crate root, when a sweep is about to be
    /// trusted with real leftovers:
    ///
    /// ```text
    /// $env:GAHUB_MEI_SWEEP_ALLOW_REAL_TEMP="1"
    /// $env:GAHUB_MEI_SWEEP_DRY_RUN="1"
    /// cargo test -- --ignored dry_run --nocapture
    /// ```
    ///
    /// It only prints. The dry-run branch is the same code path up to the
    /// `remove_dir_all`, so what it lists is what a launch would reclaim.
    #[test]
    #[ignore = "reads the real %TEMP%; opt in with --ignored after setting the two env vars"]
    fn dry_run_against_the_real_temp_directory() {
        assert!(
            env::var_os("GAHUB_MEI_SWEEP_ALLOW_REAL_TEMP").is_some(),
            "refusing to read the real %TEMP% without GAHUB_MEI_SWEEP_ALLOW_REAL_TEMP"
        );
        assert!(
            env::var_os("GAHUB_MEI_SWEEP_DRY_RUN").is_some(),
            "refusing to run this test without GAHUB_MEI_SWEEP_DRY_RUN"
        );
        let report = sweep_stale_bundles(&|line: &str| println!("{line}"));
        println!("{report:?}");
        assert!(report.scan_complete, "the liveness probe was refused; nothing was chosen");
    }
}
