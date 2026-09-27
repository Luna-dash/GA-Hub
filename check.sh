#!/usr/bin/env bash
# GA-Hub 本机校验入口（提交前跑这一套）。
#
#   1) 安装 Python 依赖（requirements.txt = 构建配方）
#   2) 前端：依赖 + 单测 + 类型检查 + API 契约 + 生产构建
#   3) pytest（后端 —— 需要 GA 核心仓库，见下面的提示）
#
# 顺序不是随意的：tests/test_backend_api_smoke.py 的
# test_built_spa_deep_link_and_hashed_entry_asset 断言 webui/dist 里的构建产物，
# 所以**前端生产构建必须排在 pytest 之前** —— 否则新克隆上第 3 步必红。
#
# 发布前的全量验证与打包是另一条链：python scripts/build_all.py --full
# （口径与边界见 docs/BUILD.md）

set -euo pipefail
cd "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
say() { printf "${GREEN}==>${NC} %s\n" "$*"; }
die() { printf "${RED}xx ${NC} %s\n" "$*" >&2; exit 1; }

PY="${PYTHON:-python3}"
command -v "$PY" >/dev/null 2>&1 || die "未找到 python3，请先安装 Python 3.10+"

say "Python: $($PY --version 2>&1)"
say "安装 Python 依赖（构建配方 requirements.txt）..."
# 用 requirements.txt（唯一可复现安装清单，钉版本），**不要**用
# `pip install -e .[dev] --upgrade`：pyproject 声明的是松范围，--upgrade 会把运行时
# 依赖升到比构建配方更新的版本 —— 于是"提交前检查"会悄悄改变 PyInstaller 打包进去
# 的东西。dev 工具链（pytest/httpx）已在 requirements.txt 里。
"$PY" -m pip install -r requirements.txt
"$PY" -m pip install -e . --no-deps

say "检查 Node.js 工具链..."
# 统一使用 npm（主路径）；pnpm 仅作无 npm 环境的兜底
if command -v npm >/dev/null 2>&1; then
  PKG=npm
elif command -v pnpm >/dev/null 2>&1; then
  PKG=pnpm
else
  die "未检测到 npm/pnpm，请先安装 Node.js 18+"
fi
say "使用 $PKG · $($PKG -v)"

cd webui
say "安装前端依赖..."
if [ "$PKG" = "npm" ]; then
  # 与 CI / build_all 同一口径：plain npm ci（锁文件是冻结的，--legacy-peer-deps
  # 会绕过锁文件校验；本链实测无需它）
  "$PKG" ci --no-audit --no-fund
else
  # 纯 pnpm 环境兜底：不冻结锁文件，允许自行解析
  "$PKG" install
fi

say "运行前端测试..."
"$PKG" test -- --run

say "前端类型检查..."
"$PKG" run lint

say "前端 API 契约检查..."
"$PKG" run api:check

say "生产构建..."
"$PKG" run build
cd ..

# 后端套件需要 GA 核心仓库（agentmain/frontends）：把 GA_ROOT 指过去，或把 GA 克隆到
# 与本仓库同级（默认 ../GA）。没有它，pytest 会在采集期就中断（17 errors / 0 passed）。
# 它还需要上一步产出的 webui/dist（test_backend_api_smoke 断言构建后的 SPA）。
say "运行 pytest（需要 GA 核心仓库：GA_ROOT 或 ../GA）..."
"$PY" -m pytest -q

printf "\n${GREEN}✓ All checks passed.${NC}\n"
