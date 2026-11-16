"""Standalone PyInstaller entry: deliberately imports no Hub runtime."""
from server.update_helper import main

if __name__ == "__main__":
    raise SystemExit(main())
