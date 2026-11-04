"""Explicit runtime imports shared by packaging and frozen startup validation.

GA worldline is imported from an external checkout, so its rich.cells dependency
is invisible to static analysis and must be frozen explicitly on every platform.
pywin32 provides both Windows modules. win32cred loads win32timezone implicitly when
converting CREDENTIAL.LastWritten; merely importing win32cred is insufficient.
Keep connector.py's static imports too, for third-party Python packagers.
"""
COMMON_IMPORTS = ("rich", "rich.cells")
WINDOWS_IMPORTS = ("win32cred", "win32timezone")


def hidden_import_args(platform: str) -> list[str]:
    imports = COMMON_IMPORTS + (WINDOWS_IMPORTS if platform == "win32" else ())
    return [arg for name in imports for arg in ("--hidden-import", name)]
