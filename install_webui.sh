#!/usr/bin/env bash
# 一键安装 GenericAgent Web 管理后台所需的全部依赖。
#
#   1) Python：pip install -e ".[webui]"
#   2) 前端：  pnpm install && pnpm build  (或 npm)
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

say "安装 Python 依赖（pip install -e .）..."
"$PY" -m pip install -e . --upgrade

# ── Node ────────────────────────────────────────────────
say "检查 Node.js 工具链..."
PKG=""
if command -v pnpm >/dev/null 2>&1; then PKG=pnpm
elif command -v npm  >/dev/null 2>&1; then PKG=npm
else
  warn "未检测到 pnpm / npm。"
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
  # vite 5 + @vitejs/plugin-react 的 peer 依赖在某些 npm 版本下会冲突，加 legacy 兼容
  NPM_FLAGS+=(--legacy-peer-deps --no-audit --no-fund)
fi
"$PKG" install "${NPM_FLAGS[@]}"

say "构建前端 → webui/dist/..."
"$PKG" run build
cd ..

[ -f webui/dist/index.html ] || die "前端构建失败：webui/dist/index.html 不存在"

cat <<EOF

${GREEN}✓ 安装完成${NC}

启动方式：
  • 双击：     start.command
  • 命令行：   $PY launch_webui.pyw
  • 或纯后端：  $PY -m server.run         （浏览器打开 http://127.0.0.1:8765）
EOF
