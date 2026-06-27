#!/usr/bin/env bash
# Run the full local validation suite for GA-Hub.
#
#   1) Install Python runtime + dev dependencies
#   2) Run pytest
#   3) Run frontend type-check
#   4) Run frontend production build

set -euo pipefail
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
say() { printf "${GREEN}==>${NC} %s\n" "$*"; }
die() { printf "${RED}xx ${NC} %s\n" "$*" >&2; exit 1; }

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || die "未找到 python3，请先安装 Python 3.10+"

say "Python: $($PY --version 2>&1)"
say "安装 Python 开发依赖（pip install -e .[dev]）..."
"$PY" -m pip install -e ".[dev]" --upgrade

say "运行 pytest..."
"$PY" -m pytest -q

say "检查 Node.js 工具链..."
if command -v pnpm >/dev/null 2>&1; then
  PKG=pnpm
elif command -v npm >/dev/null 2>&1; then
  PKG=npm
else
  die "未检测到 pnpm/npm，请先安装 Node.js 18+"
fi
say "使用 $PKG · $($PKG -v)"

cd webui
say "安装前端依赖..."
if [ "$PKG" = "npm" ]; then
  "$PKG" install --legacy-peer-deps --no-audit --no-fund
else
  "$PKG" install
fi

say "前端类型检查..."
"$PKG" run lint

say "生产构建..."
"$PKG" run build

printf "\n${GREEN}✓ All checks passed.${NC}\n"
