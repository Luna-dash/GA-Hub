#!/usr/bin/env bash
# 一键安装 GenericAgent Web 管理后台所需的全部依赖。
#
#   1) Python：pip install -r requirements.txt（构建配方、钉版本）
#   2) 前端：  npm install && npm run build  (统一 npm)
#
# 已经装过会跳过；前端构建产物落到 webui/dist/。
# 跑完后双击 start.command 即可启动。

set -e
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
say() { printf "${GREEN}==>${NC} %s\n" "$*"; }
warn() { printf "${YELLOW}!! ${NC} %s\n" "$*"; }
die() { printf "${RED}xx ${NC} %s\n" "$*" >&2; exit 1; }

# ── Python ───────────────────────────────────────────────
PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || die "未找到 python3，请先安装 Python 3.10+"

PYVER=$("$PY" -c 'import sys;print("%d.%d"%sys.version_info[:2])')
say "Python: $($PY --version 2>&1) → $PYVER"

case "$PYVER" in
  3.1[0-3]) ;;  # 3.10 ~ 3.13
  *) warn "推荐 Python 3.10–3.13，当前是 $PYVER";;
esac

say "安装 Python 依赖（构建配方 requirements.txt）..."
# pyproject 声明的是松范围，requirements.txt 才是钉版本的唯一可复现清单；
# 不用 --upgrade，避免把运行时依赖升到比构建配方更新的版本。
"$PY" -m pip install -r requirements.txt
"$PY" -m pip install -e . --no-deps

# ── Node ────────────────────────────────────────────────
say "检查 Node.js 工具链..."
PKG=""
# 统一使用 npm（主路径）；pnpm 仅作无 npm 环境的兜底
if command -v npm >/dev/null 2>&1; then PKG=npm
elif command -v pnpm >/dev/null 2>&1; then PKG=pnpm
else
  warn "未检测到 npm / pnpm。"
  warn "请安装 Node.js 18+（https://nodejs.org），然后重跑本脚本。"
  warn "若你只想用后端 API（http://127.0.0.1:8765/docs），可以跳过这一步。"
  exit 0
fi
say "使用 $PKG · $($PKG -v)"

# ── webui ───────────────────────────────────────────────
cd webui
say "安装前端依赖..."
NPM_FLAGS=()
if [ "$PKG" = "npm" ]; then
  # --legacy-peer-deps：vite 5 + @vitejs/plugin-react 的 peer 依赖在某些 npm 版本下会冲突
  NPM_FLAGS+=(--legacy-peer-deps --no-audit --no-fund)
fi
# 用 ci 而不是 install：实测 npm install（哪怕已同步）会改写已跟踪的
# webui/package-lock.json（把一堆 peer:true 翻成 dev:true），把工作区弄脏。
if [ "$PKG" = "npm" ]; then
  "$PKG" ci "${NPM_FLAGS[@]}"
else
  "$PKG" install "${NPM_FLAGS[@]}"
fi

say "构建前端 → webui/dist/..."
"$PKG" run build
cd ..

[ -f webui/dist/index.html ] || die "前端构建失败：webui/dist/index.html 不存在"

cat <<EOF

${GREEN}✓ 安装完成${NC}

启动方式：
  • 双击：     start.command        （macOS 浏览器模式）
  • 纯后端：    $PY -m server.run   （浏览器打开 http://127.0.0.1:8765）
  • 桌面版：    Windows 下运行 build_all.bat 构建 Tauri 壳
EOF
