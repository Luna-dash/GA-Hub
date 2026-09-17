# 交接单：GA 侧 supervisor 协议模板化（G1 + G2）

> 交接给：**绑定 `D:\study\GA` 的 AutoCoder 会话**
> 交接自：绑定 `D:\study\GA-Hub` 的会话（2026-09-16）
> 关联文档：`D:\study\GA-Hub\docs\plans\ga-supervisor-protocol-patch.md`（**含模板逐字正文与逐行改动，必读**）

## 0. 一句话任务

在 **GA 仓**把 supervisor 提示词从"每轮把协议全文塞进 user 消息"，改成"**静态协议进 system 层（模板文件）+ 每轮只发动态 6 行**"。
目标：conductor **主会话归档可读**，且不再触发 `temp/user_prompt_*.md` 转发。

## 1. 边界与前置（务必先读）

- 目标仓：`D:\study\GA`。**不要改 `D:\study\GA-Hub`**。
- **GA 仓有未提交改动（12 个文件）**，是此前的工作，**必须在其之上叠加，禁止 revert / checkout / clean / stash**：
  `frontends/gahub/` 下 `conductor_core.py`、`conductor_delivery.py`、`conductor_journal.py`、`gahub_app.py`、`gahub_models.py`、`gahub_state.py`；`memory/` 下 6 个 SOP。
- GA 仓 HEAD：`aba30f7`（2026-09-08）。
- 本任务只碰 **2 个文件**：
  - 改 `frontends/gahub/gahub_app.py`
  - 新增 `frontends/gahub/supervisor_protocol.md`

## 2. 为什么要改（一句话背景）

`gahub_app.py::_build_prompt`（约 851 行）每轮把 **协议全文 + 动态事件**一起拼进 **user 消息**（f-string 867–921）。supervisor 提示词因此超长，触发 `agentmain.py:177`：

```
Long user prompt saved to temp/user_prompt_<pid>_<ns>.md. Read and execute.
```

结果：**主会话归档里只剩这一句**（正文落在 temp 的临时 md，temp 一清即空壳）。
对照：worker 走 `agent.extra_sys_prompts = [WORKER_CONTRACT]`（system 层，见 `_new_conductor_agent` 下方的 `_new_subagent_agent`），归档干净。

## 3. 改动（三步；逐字文本见补丁文档）

1. **新增 `frontends/gahub/supervisor_protocol.md`**：内容 = 补丁文档 §1 的完整 markdown 正文（逐字取自现 f-string，**已把 `{{`/`}}` 还原为 `{`/`}`**）。
2. **`gahub_app.py` 顶部**（`WORKER_CONTRACT` 定义旁，约 141–149 行之后）新增读模板常量 `SUPERVISOR_PROTOCOL`（读同目录的 `supervisor_protocol.md`）。
3. **`_new_conductor_agent`（516–524）** 加一行：`agent.extra_sys_prompts = [SUPERVISOR_PROTOCOL]`。
4. **`_build_prompt` 的返回值（867–921 行的 f-string）** 换成只含动态 6 行：

```python
        return (
            f"API base: {base}\n"
            f"Subagent model routing: policy={models['subagent_model_policy']}, "
            f"conductor_index={models['llm_index']}, "
            f"subagent_index={models['subagent_llm_index']}\n\n"
            f"Current state: {summary}\n\n"
            f"Authoritative wake events (act on these directly):\n"
            f"<wake_events>{event_payload}</wake_events>"
        )
```

> 851–866 行（取 unread、算 summary/base/models/event_payload）**保持不动**。

## 4. 验收（必须给证据）

1. **不再落 .md**：先记下 `D:\study\GA\temp\user_prompt_*.md` 的**文件数与最新 mtime** → 在 GA-Hub 桌面端**新建一个 conductor 任务**（随便一个小任务）→ 跑完再比对：**不应新增**。
2. **主会话归档可读**：找该任务对应的引擎归档 `D:\study\GA\temp\model_responses\model_responses_<logid>.txt`（最新 mtime 的那个即主会话），其 `=== Prompt ===` 的 user 文本应只有上述 6 行（含真实 `wake_events`），**不再是"读取并执行"**。
3. **协议仍生效**：任务能正常派 worker / accept / 收 final（说明协议进 system 层没丢）。
4. **改 md 即生效**：把 `supervisor_protocol.md` 随便改一句 → **重启引擎** → 新规则生效（无需改代码）。
5. **回归**：worker 归档形态不变（仍是 `[Task Goal] …`）。

## 5. 注意事项 / 坑

- **`{{ }}` → `{ }`**：现 f-string 里的 JSON 示例是双花括号转义，模板文件里必须单花括号（最容易错的一处）。
- **动态值不要写进模板**（API base、两个模型索引会变）→ 留在每轮消息里。
- **改完必须重启引擎**才生效：当前引擎**正在运行**（PID 50468，监听 18770，跑的是改动前的代码）。重启方式：关掉桌面端（或结束该引擎进程）→ 重进 Conductor 页会自动重新拉起。
- 引擎直接跑 GA 检出，**无需打包**该 md；若 GA 侧另有打包/分发流程，确认它包含 `supervisor_protocol.md`。
- 若发现 G1/G2 的假设与代码实际不符（例如 `_build_prompt` 的调用方还依赖别的东西），**先报告再改**。

## 6. 相关背景：GA-Hub 侧已完成（避免重复劳动）

| 已完成 | 提交 |
|---|---|
| 一次一任务（引擎 spawn 注入 `GAHUB_MULTI_REQUEST_TURNS=off`） | `a1d5659` |
| 引擎懒启动 / 关闭回收 / Conductor 输入三态 | `a1d5659` |
| GA-Hub 自有子进程生命周期（Job 笼子 + 启动登记 + 清扫） | `f6f5732` |
| 引擎经 `cmd.exe` 中介启动（修"冻结侧车 spawn 挂死"） | `20ad092` |
| 启动窗口 UX（徽标与状态条统一） | `348345e`（尚未重建桌面端） |

**本任务之后仍未做**（不要在本次顺手做）：
- **G3**：新任务边界换归档 + 清上下文（`_new_log_path` + `_retarget_log` + `_clear_conversation_state`）；
- **缺口**：对"已完成"任务追加目前会另铸 request_id（需 workflow reopen 语义，GA 侧 + GA-Hub 侧一起改）。

## 7. 回报格式

- 改动文件 + 关键 diff；
- 验收证据：归档片段（那 6 行）、`user_prompt_*.md` 数量/mtime 前后对比、重启引擎后的生效验证；
- 未完成 / 未验证项；与本交接单的偏差。