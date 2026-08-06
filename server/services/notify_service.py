"""Cross-platform desktop notifications.

The webui runs inside PyWebView on the user's machine, so the browser-side
``Notification`` API is unusable (WKWebView/WebView2 pin permission to
``denied``). Instead the frontend POSTs to ``/api/notify`` and we shell out
to the native notifier here.

Backends, in order of preference per OS:

* **macOS** — ``osascript -e 'display notification "..." with title "..."'``
  (always available; no extra deps).
* **Windows 10/11** — Powershell + ``BurntToast`` if installed, else fall
  back to a transient balloon via ``System.Windows.Forms.NotifyIcon`` — both
  shell-only, no PyPI deps required.
* **Linux** — ``notify-send`` (libnotify, near-universal on desktop distros).

Everything is best-effort: any failure (notifier missing, daemon not running,
shell escape edge-case) is swallowed and logged. Notifications must never
crash the request flow.
"""
from __future__ import annotations

import logging
import platform
import shutil
import subprocess
import sys
import threading
import time

log = logging.getLogger(__name__)

_THROTTLE_SEC = 0.8       # mirrors the frontend's 800ms throttle as a backstop
_last_fired_at: float = 0.0
_lock = threading.Lock()


def _truncate(s: str, n: int) -> str:
    s = (s or "").replace("\r", " ").replace("\n", " ").strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def _spawn(cmd: list[str], *, wait_sec: float = 4.0) -> bool:
    """Run a notifier command. ``wait_sec=0`` fires-and-forgets (used for
    Windows balloon since it self-sleeps to keep the icon alive)."""
    try:
        popen_kwargs: dict = dict(
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=(sys.platform != "win32"),
        )
        if sys.platform == "win32":
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        proc = subprocess.Popen(cmd, **popen_kwargs)
        if wait_sec <= 0:
            return True
        try:
            proc.wait(timeout=wait_sec)
            return proc.returncode == 0
        except subprocess.TimeoutExpired:
            # Notifier still running but command was already dispatched —
            # treat as success and let it finish in the background.
            return True
    except Exception as e:
        log.debug("notifier command failed (%s): %s", cmd[0], e)
        return False


def _send_macos(title: str, body: str) -> bool:
    def _esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace('"', '\\"')

    script = f'display notification "{_esc(body)}" with title "{_esc(title)}"'
    return _spawn(["osascript", "-e", script], wait_sec=4)


def _send_linux(title: str, body: str) -> bool:
    if not shutil.which("notify-send"):
        return False
    return _spawn(["notify-send", "--app-name=GenericAgent", title, body], wait_sec=4)


_PS_TEMPLATE_POPUP = (
    'Add-Type -AssemblyName System.Windows.Forms; '
    'Add-Type -AssemblyName System.Drawing; '
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class GAWindow {{ [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool BringWindowToTop(IntPtr hWnd); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }}'; "
    '$form = New-Object System.Windows.Forms.Form; '
    '$form.Text = {title}; '
    '$form.Size = New-Object System.Drawing.Size(360, 150); '
    '$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow; '
    '$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual; '
    '$form.ShowInTaskbar = $false; '
    '$form.TopMost = $true; '
    '$form.BackColor = [System.Drawing.Color]::White; '
    '$form.Cursor = [System.Windows.Forms.Cursors]::Hand; '
    '$titleLabel = New-Object System.Windows.Forms.Label; '
    '$titleLabel.Text = {title}; '
    '$titleLabel.Font = New-Object System.Drawing.Font("Segoe UI", 11, [System.Drawing.FontStyle]::Bold); '
    '$titleLabel.AutoSize = $false; '
    '$titleLabel.Location = New-Object System.Drawing.Point(18, 16); '
    '$titleLabel.Size = New-Object System.Drawing.Size(318, 28); '
    '$titleLabel.Cursor = [System.Windows.Forms.Cursors]::Hand; '
    '$bodyLabel = New-Object System.Windows.Forms.Label; '
    '$bodyLabel.Text = {body}; '
    '$bodyLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9); '
    '$bodyLabel.AutoEllipsis = $true; '
    '$bodyLabel.Location = New-Object System.Drawing.Point(18, 52); '
    '$bodyLabel.Size = New-Object System.Drawing.Size(318, 54); '
    '$bodyLabel.Cursor = [System.Windows.Forms.Cursors]::Hand; '
    '$form.Controls.AddRange(@($titleLabel, $bodyLabel)); '
    '$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea; '
    '$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 20), ($area.Bottom - $form.Height - 20)); '
    '$timer = New-Object System.Windows.Forms.Timer; '
    '$timer.Interval = 8000; '
    '$timer.Add_Tick({{ $timer.Stop(); $form.Close() }}); '
    '$activate = {{ '
    '  $timer.Stop(); '
    '  $targetHandle = [GAWindow]::FindWindow("Tauri Window", "GenericAgent"); '
    '  if ($targetHandle -eq [IntPtr]::Zero) {{ '
    '    $fallback = Get-Process | Where-Object {{ $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "GA-Hub*" }} | Select-Object -First 1; '
    '    if ($fallback) {{ $targetHandle = $fallback.MainWindowHandle }} '
    '  }}; '
    '  if ($targetHandle -ne [IntPtr]::Zero) {{ '
    '    $form.Hide(); '
    '    [GAWindow]::ShowWindowAsync($targetHandle, 9) | Out-Null; '
    '    [GAWindow]::BringWindowToTop($targetHandle) | Out-Null; '
    '    [GAWindow]::SetForegroundWindow($targetHandle) | Out-Null; '
    '  }}; '
    '  $form.Close() '
    '}}; '
    '$form.Add_Click($activate); '
    '$titleLabel.Add_Click($activate); '
    '$bodyLabel.Add_Click($activate); '
    '$form.Add_Shown({{ $timer.Start() }}); '
    '[System.Windows.Forms.Application]::Run($form)'
)


def _ps_quote(s: str) -> str:
    # Single-quoted PowerShell strings: escape ' as ''
    return "'" + s.replace("'", "''") + "'"


def _send_windows(title: str, body: str) -> bool:
    powershell = shutil.which("powershell") or shutil.which("powershell.exe")
    if not powershell:
        return False
    script = _PS_TEMPLATE_POPUP.format(
        title=_ps_quote(title),
        body=_ps_quote(body),
    )
    # A healthy popup enters its WinForms message loop and remains alive.
    # A missing assembly or malformed script exits within this startup check.
    return _spawn(
        [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
        wait_sec=1,
    )


def send(title: str, body: str = "") -> dict:
    """Best-effort OS notification. Returns a small dict for diagnostics.

    The dict has ``ok`` (bool), ``backend`` (str — which path actually fired
    or was tried), and optionally ``throttled`` / ``error``. The frontend
    surfaces ``ok`` via /api/notify so the user's "测试" button can show a
    toast on failure.
    """
    global _last_fired_at
    title = _truncate(title or "GenericAgent", 80)
    body = _truncate(body or "", 240)

    with _lock:
        now = time.time()
        if now - _last_fired_at < _THROTTLE_SEC:
            return {"ok": False, "throttled": True, "backend": "throttle"}
        _last_fired_at = now

    sysname = platform.system()
    try:
        if sysname == "Darwin":
            ok = _send_macos(title, body); return {"ok": ok, "backend": "osascript"}
        if sysname == "Windows":
            ok = _send_windows(title, body); return {"ok": ok, "backend": "powershell"}
        if sysname == "Linux":
            ok = _send_linux(title, body); return {"ok": ok, "backend": "notify-send"}
    except Exception as e:
        log.warning("notify failed: %s", e)
        return {"ok": False, "backend": sysname.lower(), "error": str(e)}
    return {"ok": False, "backend": "unsupported", "error": f"unsupported platform: {sysname}"}


def backend_name() -> str:
    """Reported on the Settings panel so the user knows what's wired up."""
    s = platform.system()
    if s == "Darwin": return "macOS · osascript"
    if s == "Windows": return "Windows · PowerShell"
    if s == "Linux":
        return "Linux · notify-send" + ("" if shutil.which("notify-send") else "（未安装 libnotify-bin）")
    return f"unsupported · {s}"
