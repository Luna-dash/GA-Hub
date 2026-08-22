#!/usr/bin/env bash
# 启动 GenericAgent Web 管理后台 (macOS · 浏览器模式)。
#
# macOS 桌面壳（Tauri）暂未交付，此脚本退化为纯后端 + 浏览器模式：
# 跑完后手动打开 http://127.0.0.1:8765。首次使用先执行 install_webui.sh。
#
# mykey.py 不在 admin 这边，而是在 GenericAgent 主项目里 — 后端通过
# GA_ROOT 找到 GA 目录后再 import。这里不做检查。

set -e
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  osascript -e 'display alert "未找到 python3" message "请先安装 Python 3.10+ (https://www.python.org)"' || true
  exit 1
fi

echo "[GA-Hub] 浏览器模式启动：http://127.0.0.1:8765"
exec "$PY" -m server.run
