# GA 引擎端 × GA-Hub 客户端：结构嵌套核查报告

- 核查日期：2026-09-15
- 核查对象：`D:\study\GA`（GenericAgent fork，下称 **GA / 引擎**）与 `D:\study\GA-Hub`（下称 **Hub / 客户端**）
- 基线：GA `aba30f7`（`main`，较 `origin/main` ahead 42，较 `upstream/HEAD` ahead 125）+ 工作区未提交改动；Hub 工作区未提交改动
- 性质：**只读核查**，除本报告外未改动任何生产代码

---

## 0. 结论摘要

**"互相嵌套"确实存在，但不是两向而是四向**，且其中只有一部分是真正的逻辑缺陷：

| 编号 | 嵌套方向 | 是否合规 | 判定 |
|---|---|---|---|
| A | Hub → GA：进程内 `import` 引擎内部模块、直写引擎文件、拉起引擎脚本 | **部分违规** | 传输层已有 HTTP/SSE 边界，但**文件面对引擎内部零隔离** |
| B | GA → Hub：`frontends/gahub/` 整包（5934 行）是**客户端的引擎侧实现**，住在引擎仓 | **位置合规、内容越界** | 见 §3.1：`frontends/` 本就是按消费方命名的目录；越界在于包里承载了客户端产品逻辑 |
| C | Hub 仓内保留第三份 GA 全量副本 `.ga-staging/`（464 文件 / 35MB） | **违规（且已失效）** | 与现役 GA 不同版，无任何脚本引用它 |
| D | 状态所有权交叉：引擎把真值流写进 Hub 的 `ADMIN_DATA`，Hub 把编辑写回引擎的**被跟踪** `memory/` | **违规** | 两侧的持久化目录互相入侵 |

**一句话结论**：这不是"两个项目混在一起"这种笼统的问题，而是四处**可精确定位**的边界穿透；其中 A-B 的物理位置大部分是上游惯例允许的，真正的病灶是 **(1) 客户端产品逻辑住在引擎仓、(2) Hub 直写引擎被跟踪文件、(3) 跨仓契约靠人工锁步而无版本协商**。

---

## 1. 核查方法（可复现）

```bash
# 引擎仓：Hub 专属物是否存在、是否为 fork 新增
cd /d/study/GA
git ls-files | grep -i gahub
git diff --name-status upstream/HEAD...HEAD -- frontends/
git ls-tree upstream/HEAD frontends/ --name-only   # 上游是否有 gahub

# 客户端仓：是否进程内导入 GA、是否直写 GA 目录
cd /d/study/GA-Hub
grep -rn "bootstrap_sys_path\|import llmcore\|from agentmain" --include="*.py" server/
grep -rn "GA_ROOT\s*/\|temp_dir()\|memory_dir()" --include="*.py" server/
find . -name agentmain.py -not -path "./node_modules/*"   # 仓内 GA 副本计数
```

---

## 2. 方向 A：Hub → GA（证据充分，含具体行号）

### 2.1 进程内导入引擎内部模块（非公开 API）

| 引擎符号 | Hub 消费点 |
|---|---|
| `agentmain.GeneraticAgent` | `server/services/agent_service.py:28`、`server/services/goalhive_service.py:22`、`server/services/core_contract.py:215` |
| `llmcore.reload_mykeys` | `server/services/llm_registry.py:84` |
| `llmcore.resolve_client` | `server/services/mykey_service.py:274` |
| `sys.path` 注入机制 | `server/_paths.py:448-468`（`bootstrap_sys_path` 把 `<GA_ROOT>`、`<GA_ROOT>/frontends` 插进 `sys.path`），并在 `_paths.py:467-468` **模块导入期就 eager 执行** |

也就是说：Hub 后端进程一旦启动，GA 的模块搜索路径就常驻在 Hub 进程里。这是 README 自己承认的"进程内深度集成"（`README.md:8-12`）。

### 2.2 拉起引擎脚本（子进程面）

| 被拉起的 GA 脚本 | Hub 调用点 |
|---|---|
| `<GA_ROOT>/frontends/gahub_app.py` | `server/services/conductor_client.py:242-270`（`ensure_running` 拼 argv 后 `child_job.spawn(kind="engine")`） |
| `<GA_ROOT>/frontends/fsapp.py` | `server/services/feishu_service.py:73`、`server/services/service_registry.py:127` |

`conductor_client.py` 顶部注释（`:1-9`）明确写："GA-Hub no longer imports GA Python symbols on the conductor path" —— **这句话只对 conductor 这一条链路成立**（它走 HTTP/SSE），全仓并非如此，§2.1 的 5 处导入仍在。

### 2.3 直写引擎文件（最严重的一类）

| Hub 代码 | 写入目标（引擎仓内） | 目标文件 git 状态 |
|---|---|---|
| `server/routes/memory.py:46-48`（`open(tmp,"w")` → `os.replace`） | `<GA>/memory/global_mem.txt`、`<GA>/memory/global_mem_insight.txt` | **TRACKED** |
| `server/services/mykey_service.py:103-107`（同样原子替换） | `<GA>/mykey.py` | ignored（`.gitignore:41`） |

`<GA>/.gitignore:48-51` 在本 fork 里有显式注释：

```
# Memory policy (local fork): track and push the whole memory tree.
!memory/
!memory/**
```

**所以对 `memory/` 的写入会直接脏化被跟踪、且会被 push 的目录树。** 现场已验证：

```
$ cd /d/study/GA && git status --porcelain
 M memory/gahub_sop.md
 M memory/global_mem_insight.txt      ← 正是 memory 路由的写入目标
 M memory/scheduled_task_sop.md
 ...（另有 16 项）
```

### 2.4 读引擎私有数据面

- `server/routes/conversations.py:524` → `<GA>/memory/L4_raw_sessions`
- `server/routes/logs.py:50,56` → `<GA>/temp/wechatapp.log`、`<GA>/temp/model_responses`
- `server/services/feishu_service.py:368` → `<GA>/memory/keychain.py`（读并在子进程里 exec）
- `server/_paths.py:478-483, 532-534` → `<GA>/temp`、`<GA>/temp/autonomous_reports`

**规模**：`server/` 下共 **17 个模块**引用 `GA_ROOT`（见 `_paths.py`、`main.py`、`desktop_sidecar.py`、`services/*` 等）。

---

## 3. 方向 B：GA → Hub（客户端的引擎侧实现住在引擎仓）

### 3.1 先厘清：`frontends/` 的位置本身**不**算违规

上游 `lsdefine/GenericAgent` 的 `frontends/` 就是一个**按消费方命名**的适配器目录：

```
qqapp.py   dingtalkapp.py   dcapp.py   fsapp.py   qtapp.py   hub.py   hub_p2p.py ...
```

`upstream/HEAD` 的 `frontends/` 里**没有** `gahub`（`git ls-tree upstream/HEAD frontends/` 只列出 `conductor.py` / `conductor.html` / `hub.py` / `hub_p2p.py` 等）。也就是说：把一个"给某客户端用的适配器"放进 `frontends/`，**是符合上游既有惯例的**。把 `frontends/gahub/` 一概说成"不该存在"是过度指控。

> 补充一个易混淆点：上游自己的 `hub.py` / `hub_p2p.py` / `hub.html` 是 GenericAgent 的 **P2P hub**，与 GA-Hub 无关。命名撞车，读代码时不要串线。

### 3.2 真正越界的是**内容**

`frontends/gahub/` 是 fork 新增的 7 个模块、**5934 行**：

```
gahub_app.py          2069   （HTTP/SSE 服务本体）
conductor_core.py     2551
conductor_delivery.py  437
gahub_state.py         523
conductor_journal.py   221
gahub_admission.py      77
gahub_models.py         55
```

外加两个**纯兼容 shim**：`frontends/gahub_app.py`（19 行）、`frontends/conductor_core.py`（13 行），唯一作用是让 `python frontends/gahub_app.py` 这种**Hub 的 spawn 写法**继续可用（`gahub_app.py:7-13` 注释直说 "the GA-Hub spawn path"）。

矛盾点在于：`gahub_app.py:2-15` 的 docstring 声称**职责已经切干净**——

> "Ownership split: GA-Hub keeps workflow/product logic (admission, workflow ...)"

而同一个文件里却留着三条迁移痕迹：

```
gahub_app.py:213  # ===== output budget (absorbed from GA-Hub conductor_ext_timeout) =====
gahub_app.py:539  # -- subagent display monitoring (absorbed from GA-Hub) -------------
gahub_app.py:850  # -- supervisor prompt (adapted from GA-Hub; self-API is this service) --
```

对照 Hub 仓仍保留同名模块 `server/services/conductor_ext_timeout.py`（5514 字节）——**同一份产品逻辑在两个仓各有一份**，且引擎那份自称是"吸收来的"。这就是"客户端逻辑住在引擎里"的直接物证。

### 3.3 为客户端改造**上游文件**

`git diff --name-status upstream/HEAD...HEAD` 显示这些上游文件被 fork 修改：

| 文件 | 改动性质 |
|---|---|
| `frontends/fsapp.py` | 新增 `_emit_gahub_feishu_chat()`（`:19-26`），向 stdout 打印 `__GAHUB_FEISHU_CHAT__` 前缀的机器可读事件，**就是为了给 Hub 的飞书页消费**（`:783, 830, 845` 三处调用点） |
| `frontends/desktop_bridge.py`、`frontends/p2p_ws_client.py`、`frontends/workspace_cmd.py`、`frontends/tests/test_release_qualification.py` | fork 改动 |
| `memory/*.md` 多个 SOP | fork 文档 |

顺带纠正一处**不准确的既有表述**：`memory/ga_update_sop.md:34` 写"核心文件 agentmain/llmcore/agent_loop/ga 保持零 delta"。实测它们对上游**有**改动：

```
agent_loop.py | 16 ++++++--
agentmain.py  | 93 ++++++++++++++++++---------
llmcore.py    | 13 ++++++---
3 files changed, 80 insertions(+), 42 deletions(-)
```

（好消息：`git diff ... | grep -i gahub` **零命中**——这些改动与 gahub 无关，是 fork 的其它工作。所以"SOP 的**意图**（核心文件不含 gahub delta）成立，**字面表述**不成立。）

### 3.4 客户端专属的测试与文档也在引擎仓

- `tests/test_gahub_app.py`（2252 行）、`tests/test_gahub_state.py`（213 行）；另有 `tests/test_conductor{,_checks,_journal,_milestones}.py` 涉及 gahub 契约
- `memory/gahub_sop.md`、`memory/gahub_test_patterns_sop.md`、`memory/gahub_conductor_run_roadmap.md` —— 注意这是 GA **Agent 自己的记忆目录**

---

## 4. 方向 C：Hub 仓里还有第三份引擎

```
D:\study\GA-Hub\.ga-staging\     464 文件 / 35MB   （含 agentmain.py、llmcore.py、frontends/gahub/…）
```

- 被 `GA-Hub/.gitignore:63` 忽略；
- **与现役 GA 不同版**：
  - `gahub_app.py`：现役 `fb35518…` vs staging `6f3c101…`
  - `conductor_core.py`：现役 `479ebbc…` vs staging `9073f6e…`
- 全仓引用它的只有 `.gitignore` 与两条文档说明（`docs/BACKLOG.md:519` 自己写明"未同步…不参与运行"）。

结论：**它是一份已失效的引擎副本，当前只有负价值**（污染搜索结果、误导审计——既有审阅文档 `docs/archive/GA_HUB_ENGINE_JOINT_REVIEW_20260908_FOLLOWUP.md:5` 就不得不专门声明"`.ga-staging/` 不作为证据"）。

---

## 5. 方向 D：状态所有权交叉

| 方向 | 机制 | 位置 |
|---|---|---|
| 引擎 → Hub 目录 | Hub spawn 时注入 `GAHUB_JOURNAL_PATH`，引擎把**耐久真值流**写在 Hub 的 `~/.genericagent-admin/gahub_journal/journal.jsonl` | Hub 侧 `conductor_client.py:104`；引擎侧 `gahub_app.py:231`（`os.environ.get("GAHUB_JOURNAL_PATH")`） |
| Hub → 引擎目录 | 见 §2.3，直写引擎 `memory/` 被跟踪文件 | `server/routes/memory.py:46-48` |

**这是最反直觉的一条**：引擎的持久化真值放在**客户端**目录，客户端的编辑写回**引擎**目录。两侧的"私有状态"都不是私有的。环境变量注入只是把它变成了"协商过的越界"，并没有改变所有权交叉的事实。

---

## 6. "磁盘零侵入"声明的核实结果

**该声明不成立，且 Hub 内部自相矛盾。**

声明出现在三处：

- `README.md:5-6`：「🔒 磁盘零侵入：本项目与 GenericAgent 仓库**文件级完全分离**，从不写入 GA 目录」
- `_paths.py:36-37`：「Crucially, NOTHING is written into the GenericAgent repo from admin code, so `git pull` on GA never conflicts.」
- `README.md:95-96`：把 `<GA>/temp/wechat_media/`、`<GA>/temp/autonomous_reports/` 标为 ✅「agent 运行时数据，本来就归 GA 自身管理」

反证：

1. `server/routes/memory.py` 写的是 **TRACKED** 的 `memory/global_mem*.txt`，不是 temp 数据；
2. GA 工作区当前就有 `M memory/global_mem_insight.txt`；
3. **Hub 自己的代码在别处承认这条边界**：`server/services/agent_service.py:1051-1054` 注释写道

   > "writing GA's file would violate the 'don't mutate GA' boundary."

   同一个仓里，一处以边界为由**拒绝**写 GA 文件，另一处正在**写** GA 文件。

**精确结论（分文件看）**：

- `mykey.py`（`.gitignore:41`）、`temp/`（`.gitignore:1`）→ 被忽略，写入**不会**弄脏 git，README 的说法在这两个路径上**实践成立**；
- `memory/` → 在本 fork 被**显式改为跟踪并推送**（`.gitignore:48-51`），写入**会**脏化工作区、且可能被 commit/push。README 声明在这条路径上**不成立**。

---

## 7. 隐式嵌套：契约以"复制 + 人工锁步"方式存在

没有 `protocol_version` / `capabilities` 协商（既有审阅 `docs/architecture/conductor-reliability-plan.md:170` 已建议补上，尚未落地），两仓靠**同一套语义在两处各写一份**维持一致：

| 契约 | 引擎侧 | Hub 侧 | 一致性约束 |
|---|---|---|---|
| 完成标记尾部 | `frontends/gahub/conductor_core.py:173-177` `_DONE_TAIL_RE`（三种拼法 `[[GAHUB_TASK_DONE]]` / `[GAHUB_TASK_DONE]` / `[DONE]`） | `webui/src/components/conductor/presentation.ts:513`（同一套正则，JS 版） | 引擎注释 `:170-172` 直接点名 "GA-Hub's presentation.stripContractTail must recognise the same three spellings" |
| 事件 kind → UI 文案 | 引擎 SSE 事件 `kind` | `server/services/conductor_activity.py` 唯一映射表 | 新增 kind 必须两侧同步补表 |
| 遗留事件标签 | `RuntimeEffects.WORKER_EVENT_LABEL` | `conductorStore.WORKER_EVENT_KIND` | **必须同键**，缺键＝静默丢行 |

这构成一种**看不见的嵌套**：仓库文件系统上两边是分开的，但语义上两边是同一个不可分割的单元——**任一侧单独升级都会破**（本仓 `.workbuddy/memory/2026-09-14.md` 记录了改一个标记要动 8 个文件、跨 2 个仓的过程）。

---

## 8. 风险分级

| 级别 | 问题 | 后果 |
|---|---|---|
| **P0** | Hub 直写 GA **被跟踪**的 `memory/global_mem*.txt`（§2.3） | 跨仓写 + 进入 fork 的 push 面；两侧同时编辑无锁；`git pull` 语义失真 |
| **P1** | 客户端产品逻辑住在引擎仓，且与 Hub 共享语义但**无版本协商**（§3.2、§7） | 单向升级即破；Hub 侧改文案要动引擎仓文件 |
| **P1** | 上游文件被为客户端改造（`fsapp.py:19-26` 等 5 个，§3.3） | `git pull upstream` 的合并成本持续上升 |
| **P2** | `.ga-staging/` 失效副本（§4） | 污染 grep/搜索、误导审计与新人 |
| **P2** | README/SOP 声明与实测不符（§3.3、§6） | 误导下一个维护者；审计需要额外交叉验证 |

---

## 9. 建议（按风险/成本排序）

**立即可做（低风险、不改契约）**

1. **删除或归档 `.ga-staging/`**（464 文件 / 35MB，非跟踪、无脚本引用、已失效）。先确认无本地脚本依赖；这是本报告里唯一"零风险纯收益"的一项。
2. **改正声明文本**，让文档与代码一致：
   - `README.md:5-6` 与 `_paths.py:36-37`：把"从不写入 GA 目录"改为"**不写 GA 的源码树**；运行时数据面限定为 `<GA>/mykey.py` 与 `<GA>/temp/`（均被 GA 的 `.gitignore` 忽略）"；
   - `memory/ga_update_sop.md:34`：把"核心文件零 delta"改为"核心文件**无 gahub 相关** delta（实测有 80+/42- 行其它 fork 改动）"；
   - 在 `memory/` 这条路径上**明确表态**：要么禁止写入，要么在 GA 的 `.gitignore` 里为本机实例文件加显式放行注释。
3. **统一 Hub 内部的边界口径**：把 `agent_service.py:1051-1054` 那条注释升级为可执行约束——即"Hub 不直接 `open(GA文件,'w')`"，与 `routes/memory.py` 的现状对齐（二选一：禁止，或改走 GA 提供的入口）。

**中期（需要两仓协同）**

4. **把 `memory/global_mem*.txt` 的编辑改为调用引擎侧的更新入口**，而不是 Hub 直接原子替换；或至少让 GA 侧提供一个"面向外部编辑"的明确契约文件（含并发/备份语义）。
5. **`frontends/gahub/` 去品牌化 + 职责再切**：把它定义为"GA 内置的 conductor 前端适配器"，并把仍属客户端的部分（如 `follow_main` 语义、UI 展示规则、`conductor_ext_timeout` 那份重复实现）收回 Hub，消除 §3.2 的双份实现。
6. **补协议协商**：`GET /health` 返回 `protocol_version` + `capabilities`，Hub 握手校验；两仓锁步的正则/映射表下沉为**一份生成物**（或至少一份 golden 文件），把"人工同步"变成"生成校验"。

**长期（结构性）**

7. 把 `frontends/gahub/` 抽成**独立可安装包**（`pip install` 进 GA 的运行环境），引擎仓只保留一个 entrypoint 钩子。这样 `frontends/` 的位置惯例得以保留，而客户端的引擎侧实现从引擎仓的源码树里彻底移出——同时消除方向 B 与方向 C。

---

## 10. 附：本次核查**未能确认/未覆盖**的部分

- 未运行任何测试、未启动引擎或 Hub 进程，全部结论来自静态代码与 git 元数据；
- 未评估 `temp/` 下的历史副本（`.pytest_tmp/`、`temp/joint_review_20260908/scratch-hub/`、`temp/_pt*/` 中还有若干含 `frontends/gahub_app.py` 的测试残留），它们属一次性产物，未计入 §4 的副本统计；
- 上游 `newga` / `GA_desk-vps-share` 两个 remote 的**远端**是否已包含 `frontends/gahub/`（`git branch -r --contains` 在本地产出为空，即这些提交当前**不在任何远端跟踪分支上**）未做网络核实。
