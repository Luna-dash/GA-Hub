"""Export the configured GA-Hub app's OpenAPI document as a stable artifact."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Works from any cwd and without an editable install (same contract as
# tests/conftest.py) — docs/BUILD.md promises a plain requirements install.
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server.main import app  # noqa: E402


DEFAULT_OUTPUT = ROOT / "docs" / "api" / "openapi.json"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    document = app.openapi()
    title = document.get("info", {}).get("title", "")
    if "setup mode" in title:
        raise SystemExit(
            "Refusing to export setup-mode OpenAPI; configure GA_ROOT and restart the exporter"
        )

    # FastAPI's operation/schema ordering is deterministic for a given source
    # tree. Preserve it rather than sorting keys so regeneration produces a
    # focused diff when an endpoint actually changes.
    serialized = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(serialized, encoding="utf-8")
    print(f"wrote {args.output} ({len(document.get('paths', {}))} paths)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
