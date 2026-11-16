"""Conservative Windows Job independence checks for scheduled update workers.

An unrestricted scheduler Job is acceptable only when the worker is outside
all Jobs held by every live Hub desktop. Inspection failures are not evidence
of independence. Handle snapshots are bounded and all duplicated handles close.
"""
from __future__ import annotations

import ctypes
import os

import psutil


def _api():
    from ctypes import wintypes as w
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    n = ctypes.WinDLL("ntdll")
    h = w.HANDLE
    k.GetCurrentProcess.restype = h
    k.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
    k.OpenProcess.restype = h
    k.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
    k.CreateJobObjectW.restype = h
    k.CloseHandle.argtypes = [h]
    k.DuplicateHandle.argtypes = [h, h, h, ctypes.POINTER(h), w.DWORD, w.BOOL, w.DWORD]
    k.QueryInformationJobObject.argtypes = [h, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
    k.IsProcessInJob.argtypes = [h, h, ctypes.POINTER(w.BOOL)]
    n.NtQueryInformationProcess.argtypes = [h, w.ULONG, ctypes.c_void_p, w.ULONG, ctypes.POINTER(w.ULONG)]
    n.NtQueryInformationProcess.restype = ctypes.c_long
    return k, n, w


def _snapshot(n, w, process):
    u = ctypes.c_size_t

    class Entry(ctypes.Structure):
        _fields_ = [("handle", w.HANDLE), ("count", u), ("pointers", u),
                    ("access", w.ULONG), ("type", w.ULONG),
                    ("attributes", w.ULONG), ("reserved", w.ULONG)]

    size = 65536
    while size <= 16_000_000:
        buf = ctypes.create_string_buffer(size)
        returned = w.ULONG()
        rc = n.NtQueryInformationProcess(process, 51, buf, size, ctypes.byref(returned))
        if rc == 0:
            count = u.from_buffer(buf).value
            offset = 2 * ctypes.sizeof(u)
            if offset + count * ctypes.sizeof(Entry) > size:
                raise OSError("Invalid process handle snapshot")
            return [Entry.from_buffer_copy(buf, offset + i * ctypes.sizeof(Entry))
                    for i in range(count)]
        if rc not in (-1073741820, -1073741789):
            raise OSError(f"Cannot inspect process handles: NTSTATUS {rc:#x}")
        size = max(size * 2, returned.value)
    raise OSError("Process handle snapshot exceeds safety bound")


def current_job_flags() -> int:
    k, _, w = _api()
    # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: 144 bytes on x64, 112 on x86.
    buf = ctypes.create_string_buffer(144 if ctypes.sizeof(w.HANDLE) == 8 else 112)
    returned = w.DWORD()
    if not k.QueryInformationJobObject(None, 9, buf, len(buf), ctypes.byref(returned)):
        raise ctypes.WinError(ctypes.get_last_error())
    return ctypes.c_uint32.from_buffer(buf, 16).value


def desktop_job_memberships() -> list[bool]:
    k, n, w = _api()
    current = k.GetCurrentProcess()
    probe = k.CreateJobObjectW(None, None)
    if not probe:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        # Resolve the runtime Job object type, not a version-specific type ID
        # or access-mask guess. Non-Job duplicate failures are irrelevant.
        types = {e.type for e in _snapshot(n, w, current) if e.handle == probe}
        if len(types) != 1:
            raise OSError("Cannot identify Job object type")
        job_type = types.pop()
    finally:
        k.CloseHandle(probe)
    memberships = []
    for process in psutil.process_iter(["name"]):
        if (process.info["name"] or "").casefold() != "ga-hub-desktop.exe":
            continue
        if process.pid in {p.pid for p in psutil.Process().parents()}:
            return [True]
        owner = k.OpenProcess(0x40 | 0x400, False, process.pid)
        if not owner:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            jobs = [e for e in _snapshot(n, w, owner) if e.type == job_type]
            if not jobs:
                raise OSError(f"Desktop {process.pid} has no inspectable ownership Job")
            for entry in jobs:
                duplicate = w.HANDLE()
                if not k.DuplicateHandle(owner, entry.handle, current,
                                         ctypes.byref(duplicate), 0, False, 2):
                    raise ctypes.WinError(ctypes.get_last_error())
                try:
                    inside = w.BOOL()
                    if not k.IsProcessInJob(current, duplicate, ctypes.byref(inside)):
                        raise ctypes.WinError(ctypes.get_last_error())
                    memberships.append(bool(inside.value))
                finally:
                    k.CloseHandle(duplicate)
        finally:
            k.CloseHandle(owner)
    return memberships


def safe_scheduler_job() -> bool:
    # Only accept completely unrestricted scheduler Jobs. In particular,
    # KILL_ON_JOB_CLOSE, time limits and active-process limits are rejected.
    if current_job_flags() != 0:
        return False
    return not any(desktop_job_memberships())
