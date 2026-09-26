# 子进程解释器选错环境排查报告：GA 环境未参与解析链

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-09-24（定位并修复）；2026-09-25 成文 |
| 状态 | **已修复并端到端验证**（产物 `ga-hub-desktop.exe` 22:48:23） |
| 严重度 | 中 —— 打包版飞书「检查」恒红；并隐性影响 GA 代码执行 / 外部 worker |
| 触发场景 | 打包版（冻结 sidecar）在 **PATH 上存在无关 Python** 的机器上启动任何子进程 |
| 不受影响 | ① Conductor 引擎本身（它读另一个配置键）；② 开发模式（`sys.executable` 就是真解释器）；③ 未配置 `gahub_python` 且 PATH 无干扰 Python 的机器 |
| 涉及文件 | `server/_paths.py`、`tests/test_paths_python.py` |
| 性质 | **既有缺陷**，此前被「飞书 check 恒 25s 超时」这一更显眼的故障掩盖（见 §4.4） |

---

## 0. 一句话结论

GA-Hub 里「GA 环境在哪」这件事，被**两套机制各自表达**：Conductor 引擎读 `config.gahub_python`，
而通用解析链 `discover_user_python()` **根本没读这个键**。于是引擎跑在正确的 GA 环境里，
子进程却跑在 PATH 上碰巧排第一的那个无关 Python 上——用户其实早就把答案写在配置里了，
只是那条链没去看。

修法：**把 `config.gahub_python` 纳入通用解析链**，位置在显式配置组内、所有推断来源之前。

---

## 1. 通俗版：同一份知识，两套答案

「GA 要用哪个 Python」这个问题，本机的答案一直躺在 `~/.genericagent-admin/config.json` 里：

```json
{ "ga_root": "D:\\study\\GA",
  "gahub_python": "D:\\APP\\anaconda3\\envs\\ga\\python.exe" }
```

但它有两个读者，只有一个真读了：

| 谁 | 读哪个键 | 本机得到 |
| --- | --- | --- |
| Conductor 引擎（起 `gahub_app.py`） | `config.gahub_python` | ✅ `D:\APP\anaconda3\envs\ga\python.exe` |
| 飞书 / code_run / 外部 worker / mykey | 只读 `config.python_path`（**本机为空**） | ❌ 一路下滑到 PATH 上的无关 Python |

`python_path` 是设置页那个「Python 解释器（可选）」输入框写的键，本机**空着**；
而 `gahub_python` 是引擎自己写进去的键，**有值**。通用链不认后者，就继续往下猜：

```
GA_PYTHON（环境变量，空） → config.python_path（空） → GA venv（无） → 已知安装位置（不匹配）
 → PATH 上的 python3  ← 在这里命中
```

PATH 上排第一的是 **WorkBuddy 自带的运行时**
（`C:\Users\lunagent\.workbuddy\binaries\python\versions\3.13.12\python3.exe`）。
它能跑 Python，但**没装 GA 的可选依赖**——于是飞书端一启动就报：

```
No module named 'lark_oapi'
```

打比方：家里只有一把「工作室钥匙」被登记在册（`gahub_python`），但你只让**管家**（引擎）看这本册子；
**其他人**（子进程）进门时问的是**另一本册子**（`python_path`），那本上空着，只好"随便拿一把抽屉里的钥匙"——
抽屉里那把是邻居家的。

**关键点是：这不是依赖缺失，也不是 python 坏了，是"选错了环境"。**
GA 自己的环境（`D:\APP\anaconda3\envs\ga\python.exe`）里 `lark_oapi` **装得好好的**——
用这个解释器直跑 `fsapp.py --check`，返回 `ready:true`。

---

## 2. 现象

打包版（从桌面快捷方式启动）里：

**看得到的**

- 飞书设置页点「检查」→ 状态恒为**红**；
- 后端接口能回，但结果是：

```json
POST /api/feishu/check  →  { "ready": true, "ok": false,
                             "error": "No module named 'lark_oapi'" }
```

**容易看走眼的**

- `/api/feishu/status` 里其实**直接给出**了它选中的解释器——只是没人会主动去比对：

```json
"python": "C:\\Users\\lunagent\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python3.exe"
```

- 同一台机器、同一份代码，**开发模式（非打包）下不报错**——因为 `sys.executable` 就是真解释器，
  永远不会落到 PATH 那条分支上。**这解释了为什么它在开发期完全隐形。**

---

## 3. 定位过程

### 3.1 先排除"超时"这一层

上一轮提交 `dba740e` 刚刚修掉了「打包版飞书 check 恒 25s 超时」（一次性子进程继承了壳的匿名生命线管道 → 卡在 stdio 初始化）。
修完之后 check **2.42s 就返回了**——超时确实解决。但它立刻暴露出下一层：`ok:false` + 缺模块。

> 这一步很重要：**两个 bug 叠在一起，修掉表层的那个，才看得见下面那个。**

### 3.2 二分：是"环境真缺"还是"选错解释器"

| 检查 | 结果 |
| --- | --- |
| `ls D:\APP\anaconda3\envs\ga\Lib\site-packages\lark_oapi` | ✅ **存在** |
| `ls C:\...\workbuddy\binaries\python\versions\*\Lib\site-packages\lark_oapi` | ❌ 不存在 |
| `D:\APP\anaconda3\envs\ga\python.exe frontends/fsapp.py --check` | ✅ `ready:true` |
| `GET /api/feishu/status` 的 `python` 字段 | ⚠️ 指向 WorkBuddy 运行时 |

→ 依赖在，解释器选错了。**不是环境问题，是选择逻辑问题。**

### 3.3 落到代码：谁选了它

`server/services/feishu_service.py:84`：

```python
def _python(self) -> str:
    return _paths.discover_user_python(_paths.GA_ROOT) or sys.executable
```

顺着 `_paths.discover_user_python()` → `user_python_candidates()` 读下来，
看到的候选顺序里**压根没有 `gahub_python`**：

```
1. GA_PYTHON            （环境变量）
2. config.python_path   （设置页）        ← 本机为空
3. GA venv（.venv/venv/env）              ← 本机无
4. 已知安装位置（Homebrew/pyenv/常见 Windows 路径）
5. PATH 上的 python3/python               ← ★ 本机命中这里
6. 当前进程可执行文件
```

### 3.4 反面确认：另一个读者早就读对了

`server/services/conductor_client.py:220-236`：

```python
def _resolve_python_exe(ga_root):
    explicit = _config_str("gahub_python")     # ← 引擎先读这个
    if explicit and os.path.isfile(explicit):
        return explicit
    discovered = _paths.discover_user_python(ga_root)   # ← 才轮到这里
    ...
```

→ 印证了 §1 的判断：**`gahub_python` 早就存在且有值，只是通用链漏读。**

---

## 4. 根因

### 4.1 直接原因

`server/_paths.py:user_python_candidates()` 只读 `config.python_path`，
**没有读 `config.gahub_python`**：

```python
saved = load_config().get("python_path")          # 只有这一个配置键
add(saved, "config.python_path", report_invalid=True)
```

### 4.2 上游原因：同一个语义有两个键名

| 键 | 写入者 | 语义 | 谁读 |
| --- | --- | --- | --- |
| `python_path` | 设置页输入框 | 「用户手填的兜底解释器」 | 通用链 ✅ |
| `gahub_python` | 引擎 / 配置流程 | 「GA 自己跑在哪个解释器上」 | 仅引擎 ✅ |

两者语义高度重叠（都是"给 GA 用的 Python"），但**只有被引擎读的那一个在链上**。
本机恰好只填了 `gahub_python`、没填 `python_path`，于是通用链整段落空。

> 本质是 **单一事实被两套机制分别实现**：引擎那条路自己实现了「读 gahub_python」，
> 通用链那条路自己实现了「读 python_path」——两条路各写一半，谁也不是权威来源。

### 4.3 为什么以前没被发现

| 伪装 | 说明 |
| --- | --- |
| **开发模式不触发** | 开发时 `sys.executable` 是真解释器，PATH 分支不会被走到 |
| **被超时故障掩盖** | check 之前恒 25s 超时，压根走不到"缺模块"这一步 |
| **只在特定 PATH 上暴露** | 只有 PATH 上存在"能跑 Python 但没有 GA 依赖"的运行时才会现形 |

### 4.4 影响面（不止飞书）

`discover_user_python()` / `user_python_candidates()` 是所有「需要真解释器的子进程」的统一入口：

| 消费点 | 用途 | 选错后果 |
| --- | --- | --- |
| `feishu_service.py:84` | 飞书端 `fsapp.py` 子进程 | ❌ 缺 `lark_oapi`，检查恒红 |
| `ga_subprocess_patch.py:85` | GA 子进程补丁 | ⚠️ GA 侧 API 补丁可能失效 |
| `agent_service.py:134` | GA web 工具外部 worker | ⚠️ web 工具可能起不来 |
| `ga_external_worker.py` | 长驻外部 worker | ⚠️ 同上 |
| `mykey_service.py:419` | mykey 同步脚本（走 `user_python_candidates`） | ⚠️ 缺 `cryptography` 等 |
| `conductor_client.py:231` | 引擎解释器（**仅作 fallback**） | ✅ 前面先读了 `gahub_python`，未受影响 |

→ 所以这是一处「改一行、四类子进程同时归位」的修复。

---

## 5. 修复

### 5.1 采纳方案：把 `gahub_python` 插入解析链

`server/_paths.py`（`user_python_candidates()` 内）：

```python
config = load_config()
add(config.get("python_path"), "config.python_path", report_invalid=True)
# ``config.gahub_python`` is the interpreter the user already declared for
# GA itself: the conductor engine spawns ``gahub_app.py`` with it
# (conductor_client._resolve_python_exe). Honour it here too, and above
# every *inferred* source below. Otherwise a host whose PATH carries an
# unrelated Python (tool-bundled runtimes, MSYS, conda base, ...) resolves
# here to that runtime, and any child needing GA's optional dependencies
# (feishu's lark_oapi, mykey's cryptography, ...) fails to start — while
# the engine happily runs in GA's environment. One declaration, one
# interpreter, everywhere.
add(config.get("gahub_python"), "config.gahub_python", report_invalid=True)
```

同时更新 `discover_user_python()` 的 docstring，把解析顺序写成 7 条。

新的完整顺序：

```
1. GA_PYTHON              （环境变量，最高优先）
2. config.python_path     （设置页手填的显式覆盖）
3. config.gahub_python    ← ★ 新增：GA 自己声明的解释器
4. GA venv（.venv/venv/env）
5. 已知安装位置（Homebrew/pyenv/常见 Windows 路径）
6. PATH 上的 python3/python
7. 当前进程可执行文件
```

**核心思想**：`gahub_python` 是**声明**（用户已明确告诉系统 GA 在哪），
第 4 条之后全是**推断**。声明必须压过推断——一行插入，全线归位。

### 5.2 为什么放在第 3 位、而不是第 1 位

| 备选位置 | 结果 | 评价 |
| --- | --- | --- |
| 放在 `python_path` **之前** | 设置页手填的值会被 `gahub_python` 压住 | ❌ 会破坏「设置页覆盖」这一既有语义 |
| **放在 `python_path` 之后**（采纳） | 显式覆盖优先，其次是引擎声明，再次才是推断 | ✅ 语义分层清晰：越明确越靠前 |
| 替换掉 `python_path` | 设置页入口失效 | ❌ 破坏 UI 契约 |

### 5.3 为什么不选另外两种省事改法

| 备选 | 做法 | 否决理由 |
| --- | --- | --- |
| A | 只在 `feishu_service._python()` 里补读 `gahub_python` | 治标——其余四类子进程照旧选错（§4.4） |
| B | 让用户在设置页手填 `python_path` | 把产品缺陷转嫁成用户手工配置；而系统**本来就知道答案** |
| C | **纳入统一解析链（采纳）** | 一处修复覆盖全部消费点，且消除"两套机制"的分裂 |

> 备选 B 是**当时已实测可行**的临时手段（注入 `GA_PYTHON` 后 check 立刻转
> `ready:true`），文档在此保留记录：它证明的是"换个解释器就好"，而非"问题已解决"。

---

## 6. 验证

### 6.1 单元测试（新增 3 例）

`tests/test_paths_python.py`：

| 用例 | 断言 |
| --- | --- |
| `test_discover_user_python_prefers_gahub_python_over_path` | `gahub_python` 压过 PATH 命中项，且 `source == "config.gahub_python"` |
| `test_discover_user_python_prefers_python_path_over_gahub_python` | `python_path` 仍优于 `gahub_python`（覆盖语义不倒退） |
| `test_discover_user_python_ignores_invalid_gahub_python` | `gahub_python` 指向失效路径时**不抛异常**，继续向下探测 |

结果：`tests/test_paths_python.py` **21 passed**（含原有 4 例解释器用例，无回归）。

### 6.2 真实配置下的解析结果（未改任何设置）

| | 修复前 | 修复后 |
| --- | --- | --- |
| `resolved_python` | `…\.workbuddy\binaries\python\versions\3.13.12\python3.exe` | **`D:\APP\anaconda3\envs\ga\python.exe`** |
| `resolved_python_source` | `PATH:python3` | **`config.gahub_python`** |
| 候选链第 1 条 | `PATH:python3`（WorkBuddy） | `config.gahub_python`（GA env） |

### 6.3 打包版端到端

| 验证项 | 结果 |
| --- | --- |
| 构建 | `python scripts/build_all.py` **128.2s**；`ga-hub-desktop.exe` **22:48:23**、`ga-hub-sidecar.exe` **22:47:19** |
| 修复进包 | `CArchiveReader` 抽出包内 `server/_paths.py`，`config.gahub_python` 命中 **2 处** |
| 其它进包项 | 前端 100=100、sha256 100/100、`index.html` 哈希 MATCH、8 个后端模块字节一致 |
| **启动冒烟** | ✅ sidecar **12.0s 就绪**；`/api/setup/status` 200 `configured:true` |
| **核心契约（关键）** | ✅ `/api/health/core-contract` 200 **`ok:true`** `core_commit cfb3f66`——见 §6.4 |
| 解释器自动归位 | `/api/feishu/status` 的 `python` → **`D:\APP\anaconda3\envs\ga\python.exe`** |
| **打包版飞书检查（零环境变量注入）** | ✅ `POST /api/feishu/check` → **`ready:true, ok:true`**（首跑 16.6s，二次 0.05s 缓存）<br>修复前同条件：`ok:false` / `No module named 'lark_oapi'` |
| Rust 单元测试 | `cargo test` **14 passed / 0 failed** |
| 全量 pytest | **992 passed / 4 failed / 1 skipped**（4 例均为既有失败，见 §6.5） |
| 快捷方式 | `~/Desktop/GA-Hub.lnk` → `…\release\ga-hub-desktop.exe`（22:48:23 新产物） |
| 清理 | 无残留 `ga-hub` 进程 |

### 6.4 一个被专门验证的风险点：3.12 与 3.13 混用

sidecar 冻结在 **Python 3.13**，而 GA env 是 **Python 3.12**。改动让 sidecar 注入的
site-packages 从「3.13 的 WorkBuddy 环境」变成「3.12 的 GA 环境」——这存在版本错配风险。

实测结论：**风险可控且方向正确**。

- 注入方式是 `sys.path.**append**`（追加到末尾），**不覆盖** sidecar 自带的包
  → sidecar 自身的 3.13 依赖仍优先，只有 GA 的可选依赖从 3.12 树里取；
- 冒烟的 `core-contract ok:true` 是最有力的反证：该检查需要 GA 的 `rich` 等依赖，
  混用若有害，这一步会先炸；
- 而改动前注入的是「**完全没有 GA 依赖**的 WorkBuddy 环境」——**改完只会更正确**。

### 6.5 全量 pytest 的 4 个失败：都不是本次引入

逐一追查并留档（目的是防止下次被误判为回归）：

| 失败 | 判定 |
| --- | --- |
| `test_upload.py::rejects_symlink_outside_allowed_root` | 本机权限环境问题，长期存在 |
| `test_api_contract.py::test_generated_typescript_contract_is_fresh` | `npm run api:check` 打印 passed 却返回 1；未触碰任何 API/schema |
| `test_desktop_sidecar.py::test_packaged_sidecar_exits_when_owner_pipe_closes` | **用改动前的 exe（22:19）手动复现，同样失败** → 与本次无关 |
| `test_desktop_sidecar.py::test_packaged_sidecar_preserves_owner_stdin_shutdown` | 同上 |

后两例的真实机制：测试传入无效 `GA_ROOT` → sidecar `_shutdown` 里
`stop_hub_session_projection()` import `frontends.*` 失败 → 投影线程未停 → 进程不退出 → 测试 15s 超时。
**它们此前一直被 skip 掩盖**（`binaries/*.exe` 早于源码即 skip），本轮 rebuild 刷新 exe 后才真正执行
（`skipped` 从 2 变 1 正是这个信号）。

---

## 7. 遗留与后续

1. **`_paths` 与 `conductor_client` 的职责重叠未清理**：本次修复后，
   `_resolve_python_exe()` 里那段「先读 `gahub_python`」已与解析链重复。
   目前保留（无害、且是 package 内的快捷路径），但**二者迟早应收敛到一处**，
   否则下次再改解析链时又要同步改两个地方。
2. **`test_desktop_sidecar` 两例既有失败待修**：应让 sidecar 在 `GA_ROOT` 无效时也能优雅退出
   （`stop_hub_session_projection()` 失败不应阻塞关停）。独立改动，尚未实施。
3. **`feishu_service` 的缓存语义**：首跑 16.6s、二次 0.05s，说明结果有缓存；
   若用户中途改了 `gahub_python`，需确认缓存是否失效（本轮未验证该路径）。
4. **`docs/BUILD.md` 未改动**：是否把「打包版子进程异常先查解释器 / 看
   `%TEMP%\gahub_desktop_shell.log`」写进构建文档，待定。

---

## 8. 可复用的排查经验

1. **"同一个事实、两个来源"是最常见的隐性缺陷形态。**
   一旦发现"某个行为在 A 路径对、在 B 路径错"，第一反应就该是
   **搜出这个事实的所有读写点**（`grep -rn` 那一个键名），看是不是有人没读。
   本次一行 `grep -n "gahub_python"` 就把根因钉死了。

2. **"依赖缺失"的报错先别急着装依赖。**
   `No module named 'X'` 有两种成因：环境里真没有，或**选错了环境**。
   判据是——用**候选解释器逐个直跑**那条命令（本次：GA env 直跑 `fsapp.py --check` → `ready:true`），
   能跑通就说明是选择问题。

3. **开发模式不复现的问题，优先怀疑"打包特有的解析链"。**
   冻结进程里 `sys.executable` 是 launcher 而非解释器，于是所有
   "找不到真 Python" 的兜底逻辑才会真正生效。

4. **两个 bug 叠加时，先修表层、再看下面。**
   本次若不先修 25s 超时，永远看不到"缺模块"这一层。

5. **修复位置要选在"所有消费点的公共上游"。**
   `discover_user_python()` 是五处子进程的统一入口，改它一处优于在五个调用点各打补丁。
   判断方法：把消费点列成表（见 §4.4），看哪一层的改动能覆盖最多行。

6. **版本混用必须实测，不能靠推理。**
   3.12/3.13 混用看着危险，但"注入方式 = append 到末尾"这一条事实改变了结论。
   最终靠 `core-contract ok:true` 这一**独立强断言**收口。

7. **不要用"改配置"掩盖产品缺陷。**
   让用户去设置页手填解释器是**可行**的（已实测），但系统本来就有正确信息——
   把这种"手工绕过"当成解决方案，等于把缺陷固化进用户流程。
