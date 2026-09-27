# GA-Hub 仓库冗余与过程产物审查报告

- 日期：2026-09-23
- 范围：`D:\study\GA-Hub`（= 项目目录 `temp\projects\GA-Hub-d795c16e` 为 junction 指向的同一仓库）
- 方法：git status 全量清点 + check-ignore 核对 + 体积/哈希测量 + mtime 时间线 + import/关键词引用扫描
- 模式：**只读审计，未删除、未修改任何仓库文件**（本报告为唯一新增文件）

---

## 1. 总账

| 指标 | 数值 |
|---|---|
| 仓库体积（除 .git） | **4.05 GB** |
| 工作树改动 | 0（无 modified/已跟踪文件未提交） |
| untracked 条目 | 92（其中 27 个 msg_*.json、~25 个脚本/报告、18 个日志、9 个目录等；本报告落盘后为 93） |
| 本地分支 | 4 个（全部已并入 main） |
| 与远端 myfork/main 差距 | 领先 240 提交、落后 0（未 push 为常态） |

体积大头分解：

| 区域 | 体积 | 说明 |
|---|---|---|
| src-tauri/target/release | **1.71 GB** | 重复构建产物（P0，见 §2.1） |
| src-tauri/target/x86_64-pc-windows-msvc | 878 MB | 正式产物区（保留） |
| webui/node_modules | 743 MB | 依赖树，npm+pnpm 混装（见 §2.4） |
| 仓库内 temp/ | 310 MB | 本机运行数据（见 §2.2） |
| .pytest_tmp* ×15 | 202 MB | pytest basetemp 残留 |
| 根 msg_*.json ×27 | 52 MB | 会话采样数据（当前分析活用中） |
| 根 pytest 会话目录 ×9 | 42 MB | 测试运行残留 |
| .tmp/ | 33 MB | node 编译缓存 + pytest 缓存 + 9-23 分析产物 |
| 根 node_modules | 16 MB | @tauri-apps/* 与 .vite（保留） |

---

## 2. 详细发现

### 2.1 [P0] 重复构建产物：src-tauri/target/release（1.71 GB）

**事实**（哈希前 16 位 / mtime）：

| 文件 | target/release（非正式区） | target/x86_64-pc-windows-msvc/release（正式区） |
|---|---|---|
| ga-hub-desktop.exe | `2e194ad12dab2e01` 09-22 17:33 | `211d772c241db979` 09-22 21:17 |
| ga-hub-sidecar.exe | `f5064b863fa16bb8` 09-22 13:58 | `9e073b206a22d071` 09-22 21:15 |

- 哈希不同 = 两次不同的构建，不是拷贝（desktop.exe 两区同为 6,380,544B；sidecar.exe 大小略异：47,585,435B vs 47,592,348B）。
- `target/release` 含完整构建树（deps/ build/ bundle/ nsis/ wix/），mtime 09-22 17:30–17:33，说明 **9-22 当天发生过一次无 `--target` 的 host 目标构建**。
- 项目记忆明确（2026-08-22 记录）：*「发布路径已规范化为唯一目录 `target\x86_64-pc-windows-msvc\release\`；target\release 拷贝已于 8-22 清除，禁止使用无 --target 的 tauri build」* —— **这是第二次出现**（8-22 清过一轮）。
- 权威判据也支持"唯一产物"：`start.bat` 注释写明 `Canonical artifact = src-tauri\target\x86_64-pc-windows-msvc\release\ga-hub-desktop.exe`，`build_all.py:artifact_path()` 同路径，桌面快捷方式指向它。=> **target/release 整个目录是纯冗余，可整目录删除回收 1.71 GB。**

**复发风险源**：根 `package.json` 的 `desktop:build` = `tauri build`（裸命令，无 `--target`）。`build_all.py` 调用时会补 `-- --target x86_64-pc-windows-msvc`（正确链），但**任何手工单独执行 `npm run desktop:build` 的构建都会落回 `target/release`**。9-22 17:33 那次构建即疑似此类（同时间段的 `build-unified-final.log` 记录了一次 tauri-build 崩溃 PermissionDenied，UTF-16 编码）。

**建议**：
1. 删除 `src-tauri\target\release\`（快捷方式/正式链均不引用它）；
2. 防复发（三选一，需用户拍板）：
   - a. 文档级：BUILD.md/README 加粗体禁令"禁止直接运行 `npm run desktop:build`，桌面构建唯一入口 = `build_all.bat`"；
   - b. 代码级（改动小）：`build_all.py` 产物守卫后追加"host-target 泄漏检测"——若 `target/release/ga-hub-desktop.exe` 的 mtime 在本次构建中被刷新则打印显式警告；**✅ 2026-09-23 已落地（提交 `198a4dd`）**
   - c. 不建议把 root script 固定为 `--target x86_64-pc-windows-msvc`：会与 `build_all.py` 传入的 `--target` 重复、且破坏 macOS `--target aarch64-apple-darwin` 用法。

### 2.2 [P1] 本机过程产物（可回收 ~2.0 GB，均未入库）

以下均**未被 git 跟踪**（部分已被 .gitignore 覆盖，部分没有），删除不影响仓库内容：

| 对象 | 体积 | 性质 / 证据 mtime | 建议 |
|---|---|---|---|
| src-tauri/target/release/ | 1.71 GB | 09-22 重复构建树 | **删**（见 §2.1） |
| .pytest_tmp* ×15 个 | 202 MB | pytest `--basetemp` 残留（09-20~09-21） | 删（已 ignore） |
| 根 pytest 会话目录 ×9：pytest-parser-after/before、pytest-unified-final、pytest_projection×4、temp_pytest_base、pytest-of-lunagent(空) | 42 MB | 09-22 测试运行残留；**未被 ignore** | 删 |
| .tmp/ | 33 MB | node-compile-cache(0.3MB) + pytest-of-lunagent(32.5MB) + stopped_examples.json(9-23) | 缓存删；stopped_examples 视分析是否收尾 |
| 仓库内 temp/ | 310 MB | 见下方明细 | **先读 temp_cleanup_sop 再清** |
| 根日志 ×18：build-unified-final.log、pytest-unified-final.log、phone_bridge*.log×6、proxy*.log×2、sim_run*.log×2、smoke_run*.log×2、vite_dev.log、vitest-final.log、webui-build-final.log、preflight.log | <1 MB | 构建/测试/桥接运行日志 | 除 smoke/sim（证据）外可删 |
| webui/vitest.config.ts.timestamp-*.mjs ×4 | 7 KB | vitest 中断残留（6~8 月），gitignore 注释已自认 | 删 |
| webui/tsconfig.tsbuildinfo | 6 KB | tsc 增量缓存（已 ignore） | 可删（重建即生成） |
| generic_agent_admin.egg-info/ | ~9 KB | 08-03 `pip install -e` 打包残留（已 ignore） | 可删 |
| dsh_window.png | 224 KB | 09-22 调试截图 | 可删/归档 |
| pytest-of-lunagent/（根，空） | 0 | 空壳目录 | 删 |

**temp/ 明细（310 MB）**：`_pt/_pt2/_pt3/_pt5/_pt6` 各 27 MB（5×27=137MB pytest basetemp）；chrome/edge profiles ×4 ≈ 62 MB；`hdr*.png/narrow*.png` 等截图约 45 张 ≈ 10 MB；探针脚本（probe-*.js、feishu_*、cage_*）；joint_review_20260908/；pytest-basetemp、pytest-w36-hub-full、pytest-recovery172(30MB)、pytest-review 等。属"调试+测试+审查素材"历史堆，清前按 `temp_cleanup_sop` 执行（先列后删）。

### 2.3 [P2] 92 个 untracked 分类（git status 污染源）

#### A. 复用工具 / 活件（**保留，勿删**；项目记忆中明确）
- 手机桥接：`phone_bridge.py`、`phone_bridge_v2.py`（断线修复版）、`v2_fresh_launch.py`、`phone_bridge_rooms*.json`
- 投影冒烟：`hub_projection_smoke.py`（+smoke_run.log 证据）
- 隧道自检：`sim_tunnel_test.py`（+sim_rooms.json、sim_run.log）
- 验收复用：`verify_landing.py`、`trace_overwrite.py`、`probe6_instrumented.py`
- 诊断留档：`diag_restore.py`、`probe7_timeline.py`

#### B. 疑似一次性诊断脚本（可归档到 temp/ 或删）
`check_served.py`、`find_routing.py`、`mtime_preview_proxy.py`、`probe2_session_resolve.py`、`probe3_api.py`、`probe4_acceptance.py`、`probe5_acceptance.py`、`probe_session_switch.py`、`test_inplace_switch.py`、`test_inplace_switch_v4.py`、`summary_gap_analysis.py`、`start_vite_preview.cmd`、`v2_fresh_launch.py`(归 A)

#### C. 分析报告 md（建议保留或集中移入 temp/，有知识价值）
`findings_run2.md`、`landing_debug_notes.md`、`landing_restore_review_findings.md`、`older_history_paging_v2_analysis.md`、`retry_continuation_plan.md`、`retry_continuation_review.md`、`summary_gap_analysis.md`

#### D. 工作数据（当前分析仍在用，不宜盲删）
`msg_*.json` ×27（52 MB，会话采样；`.tmp/stopped_examples.json` 09-23 仍在引用它们做停轮统计）、`probe_DSML_8f38d882.json`、`summary_gap_stats.json`、`.tmp/stopped_examples.json`
-> 建议整体迁至 `temp/sessions-cache/` 之类子目录（仓库根保持"代码+入口脚本"清爽），或维持现状。

#### E. 重复文件
`openapi-reviewed.json`（269 KB）= `docs/api/openapi.json` 的**逐字节副本**（sha256 前 12 位均为 `1368682eade8`）。契约脚本（`webui/scripts/*.mjs`）只读 `docs/api/openapi.json`，根副本无消费者 -> 可删。

#### F. 配置/锁文件（见 §2.4）

### 2.4 [P3] 配置与基础设施类问题

1. **包管理器混用（webui）**：
   - 主锁 = `webui/package-lock.json`（已入库，9-08）；npm 特征正常。
   - 09-22 16:17 又出现 `webui/pnpm-lock.yaml`（127 KB）+ `webui/pnpm-workspace.yaml`（内容为未填写的模板占位 `allowBuilds: esbuild: set this to true or false`），且 node_modules 被 pnpm 重装（存在 `.pnpm/`、`.modules.yaml`）。两者**均未入库、未被 ignore**。
   - 隐患：`install_webui.bat/sh`、`check.bat` 的逻辑是**"装了 pnpm 就优先用 pnpm"**；check.bat 的 pnpm 分支用 `--frozen-lockfile`，而 pnpm 锁文件未入库 -> 换机后若目标机器有 pnpm，冻结安装可能因缺锁文件而失败。
   - 建议（二选一，推荐统一 npm）：**a) 统一 npm**：删 `webui/pnpm-lock.yaml`、`pnpm-workspace.yaml`，`webui/node_modules` 用 `npm ci --legacy-peer-deps --no-audit --no-fund` 重装一次（可选，不重装也能跑）；**b) 正式采纳 pnpm**：将 pnpm-lock.yaml/pnpm-workspace.yaml 提交入库并删 npm 锁。当前半吊子状态最差。
   - **✅ 2026-09-23 已执行方案 a**（用户拍板）：`webui/pnpm-lock.yaml`、`pnpm-workspace.yaml` 已删；4 脚本（check / install_webui × bat/sh）探测顺序改为 **npm → pnpm**（pnpm 仅作无 npm 环境兜底），check 系列 pnpm 兜底分支由 `--frozen-lockfile` 改为普通 install（未入库锁不再冻结致败），头注释/告警文案同步「统一 npm」——提交 `8649166`（+23/−17）。sh 语法检查：LF 化后 `bash -n` 双绿（工作区 CRLF 系 autocrlf=true 检出形态，仓库内为 LF）。`webui/node_modules` 未重装（可选，现状可跑）。
2. **.gitignore 未覆盖的"本机散件"模式**（导致 status 长期 92 项）：`.tmp/`、根 `pytest-*/` 会话目录、`msg_*.json`、根日志模式（`*-final.log`、`phone_bridge*.log`、`vite_dev.log` 等）、`webui/pnpm-*.yaml`、`openapi-reviewed.json`。建议至少补上（权衡：`msg_*.json`、probe 脚本如后续仍要"根目录可见"可不 ignore；`webui/pnpm-*` 与 `.tmp/` 建议直接 ignore 或删）。
3. **本地分支 4 个全部已并入 main**（`git branch --merged main` 验证）：
   - `backup/0.1b-before-shortcut-icons`（05-09）
   - `task/workpack-a-session-capacity`（08-04）
   - `task/workpack-b-global-session-modal`（08-05）
   - `task/workpack-c-tauri-sidecar`（08-05）
   - 均可 `git branch -d` 清理（提交历史已全部包含在 main，零丢失风险）。

### 2.5 [P3] 过期代码 / 陈旧内容（逐项定性）

| 对象 | 判定 | 说明 |
|---|---|---|
| `server/services/notify_service.py:3-6` 注释 | **过期描述** | 写着"webui runs inside PyWebView"，实际桌面壳已是 Tauri（WebView2）；逻辑（桌面壳下改用系统级通知）本身仍需要。建议改一句注释（改码需另行确认）。 |
| `docs/plans/restore-session-scoped-fix-checkpoint-2026-09-15.md` | **已过期未归档** | `docs/plans/README.md` 自己标注"⏹ 已过期，应收进 docs/archive/"，但文件仍在 plans/。 |
| `docs/plans/ga-side-handover-g1g2.md` | 已过期引用 | README 标注：交接已完成，文中 GA HEAD 引用已过期（文档本身作历史证据可留）。 |
| `docs/archive/*` | 正常档案 | 无需动。 |
| `start_hidden.vbs` | **疑似孤儿** | 05-13 引入（隐藏窗口启动 start.bat）；唯一引用是被 `docs/archive/desktop_startup_investigation_20260816.md` 提及。当前桌面入口 = start.bat（直启 Tauri exe）。可考虑退役（低优先）。 |
| `.trellis/spec/backend/quality-guidelines.md` | tracked 孤例 | 05-13 入库后未再动，Trellis 工具痕迹；内容是通用质量规范。低价值但无害，建议维持（动它需评估工具依赖）。 |
| `mockups/conductor-density-compare.html` | 设计对比稿 | 已 ignore 的单文件；可留可删。 |
| `generic_agent_admin.egg-info/` | 打包残留 | 见 §2.2。 |
| `server/routes/agent.py:138`、`webui/src/runtime/chatSocket.ts:12` 等"legacy/removed"注释 | **正常** | 记录已移除端点/兼容路径，属有意留痕。 |
| LEGACY 代码全局扫描 | **非死码** | server 59 处（18 个文件）、webui/src 19 处（15 个文件） "legacy" 命中绝大多数是**有意兼容层**（旧存档键、旧事件帧、迁移逻辑）；**server/ 全模块 import 引用扫描 = 0 个未引用模块**。代码层面干净。 |

---

## 3. 建议的清理行动计划（分级；执行前按纪律先列后删）

> **执行记录（2026-09-23，用户批准后执行）**：阶段 1 全部完成——31 项删除 0 失败、4 个本地分支已删（`-d`）；仓库体积 4.05 GB → **2.07 GB**。阶段 2/3 主体完成（逐项见本节末「阶段 2/3 执行记录」；提交 `e648f64`）；**遗留待拍板：webui 包管理器归一；根 36 项散件（§2.2，待指示）**。

**阶段 1（安全回收 ≈ 1.96 GB，无任何理解成本）**
1. 删 `src-tauri\target\release\`（1.71 GB）
2. 删 `.pytest_tmp*` ×15（202 MB）与根 pytest 会话目录 ×9（42 MB）、空目录 `pytest-of-lunagent\`
3. 删 `.tmp\node-compile-cache`、`.tmp\pytest-of-lunagent`（32.8 MB）
4. 删 `webui\vitest.config.ts.timestamp-*.mjs`、`generic_agent_admin.egg-info\`
5. `git branch -d backup/0.1b-before-shortcut-icons task/workpack-a-session-capacity task/workpack-b-global-session-modal task/workpack-c-tauri-sidecar`

**阶段 2（需用户拍板，涉及取舍）**
6. `temp/` 310 MB 清理（先读 `temp_cleanup_sop`；_pt*/chrome profiles 可清，feishu/joint_review 素材看留档意愿）
7. webui 包管理器归一（§2.4-1 方案 a 或 b）
8. `msg_*.json` + `.tmp/stopped_examples.json` 迁出仓库根（或补 ignore）
9. 删 `openapi-reviewed.json`（纯副本）
10. ✅ 防复发措施（§2.1 方案 a/b）——a 已落 `docs/BUILD.md`；b 已落 `scripts/build_all.py`（提交 `198a4dd`）

**阶段 3（文档）**
11. `restore-session-scoped-fix-checkpoint-2026-09-15.md` 移入 docs/archive/
12. `notify_service.py` 注释修正（一条）
13. .gitignore 增补（清单见 §2.4-2）

> **阶段 2/3 执行记录（2026-09-23，提交 `e648f64`）**：6 ✅ 已清 ~295 MB（_pt*×5、pytest-* 系、chrome/edge profiles；余 ~5 MB 素材保留）；7 ⏸ 待拍板（pnpm 混装未动；`webui/pnpm-*.yaml` 先入 ignore 防污染）；
> 8 ✅ 补 ignore（msg_*.json、.tmp/）；9 ✅ 已删；10 ✅ 方案 a 已落 `docs/BUILD.md`；b ✅ 已落 `scripts/build_all.py`（提交 `198a4dd`）；11 ✅ 4 份一起归档（fix-plan、fix-checkpoint、supervisor-protocol-patch、handover-g1g2 + 2 处引用修正）；12 ✅；13 ✅（14 模式）。根 36 项散件维持现状（分类见 §2.2，待用户指示）。
>
> **补充执行记录（2026-09-23，提交 `8649166`）**：7 ✅ **已完成**——webui 包管理器统一 npm（用户拍板方案 a）：pnpm 两文件已删、4 脚本探测顺序改 npm→pnpm（pnpm 兜底不冻结锁）、文案同步；sh `bash -n`（LF 化）通过；node_modules 未重装（可选）。**§2.4-1 关闭**；§2.2 根散件处置仍待指示。

---

## 4. 附录：证据要点

- target/release 与正式区 exe 哈希、mtime 对照见 §2.1 表（本报告所有哈希均为 sha256 前 16 hex）。
- check-ignore 实测：`webui/pnpm-lock.yaml`、`msg_*.json`、根日志、根 pytest 目录、`.tmp/` 均**未被 ignore**；`mockups/`、`egg-info/`、`node_modules/`、`webui/dist/`、`tsbuildinfo`、`vitest timestamp`、`.pytest_tmp*`、`temp/` 已被 ignore。
- `openapi-reviewed.json` 与 `docs/api/openapi.json` sha256 前 12 位一致（`1368682eade8`），字节数一致（275045）。
- 分支 merge 判据：`git branch --merged main` 全含；`git rev-list --left-right --count main...<branch>` 显示 behind=0。
- 92 untracked 全量清单可重放：`git -C D:\study\GA-Hub status --porcelain`。

*报告完（只读审计，未改动仓库任何内容）。*
