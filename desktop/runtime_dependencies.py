"""Explicit runtime imports shared by packaging and frozen startup validation.

pywin32 provides both modules. win32cred loads win32timezone implicitly when
converting CREDENTIAL.LastWritten; merely importing win32cred is insufficient.
Keep connector.py's static imports too, for third-party Python packagers.
"""
WINDOWS_IMPORTS = ("win32cred", "win32timezone")


def hidden_import_args(platform: str) -> list[str]:
    return [arg for name in (WINDOWS_IMPORTS if platform == "win32" else ())
            for arg in ("--hidden-import", name)]
