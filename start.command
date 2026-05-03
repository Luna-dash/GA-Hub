#!/usr/bin/env bash
# 双击启动 GenericAgent Web 管理后台 (macOS)。
#
# 这个文件就是普通的 shell 脚本，在 macOS Finder 里双击即可弹出 Terminal
# 并启动后端 + 原生窗口。第一次跑前请先执行 install_webui.sh。
#
# mykey.py 不在 admin 这边，而是在 GenericAgent 主项目里 — 由 launch_webui.pyw
# 通过 GA_ROOT 找到 GA 目录后再 import。这里不做检查。

set -e
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  osascript -e 'display alert "未找到 python3" message "请先安装 Python 3.10+ (https://www.python.org)"' || true
  exit 1
fi

exec "$PY" launch_webui.pyw
