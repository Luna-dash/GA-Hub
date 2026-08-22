#!/usr/bin/env bash
# GA-Hub 一键交付构建：前端 → sidecar → Tauri 壳 → 产物守卫。
# 逻辑都在 scripts/build_all.py，这里只负责挑解释器。
set -e
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
export PYTHONUTF8=1

PY="${GA_HUB_PYTHON:-${PYTHON:-python3}}"
exec "$PY" scripts/build_all.py "$@"
