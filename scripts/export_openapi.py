"""Export the configured GA-Hub app's OpenAPI document as a stable artifact."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from server.main import app


ROOT = Path(__file__).resolve().parents[1]
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
