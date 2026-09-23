# GA 侧补丁包：supervisor 协议模板化（G1+G2）

> **状态标记（2026-09-18 复核）：✅ 已完成 —— 本补丁包已执行完毕。**
> G1+G2 已于 2026-09-18 在 GA 仓提交 `04f0d9d`（06:25，「feat(gahub): supervisor 协议模板化，规则改由 system 层下发」）：
> `frontends/gahub/supervisor_protocol.md` 已入库，`gahub_app.py:152-155` 读模板、`:526` 注入
> `extra_sys_prompts=[SUPERVISOR_PROTOCOL]`。运行期验收亦已完成（主会话归档每轮仅动态头、
> 不再落 `temp/user_prompt_*.md`）。已归档（2026-09-23 移入 `docs/archive/`）。

- 日期：2026-09-16
- 目标：让 conductor **主会话的归档可读**，并让"用户提交物"只剩任务本身
- 范围：**只改 GA 仓**（`frontends/gahub/`），不动 GA-Hub、不动 `agentmain` 的"长 prompt 落 .md"通用机制
- 依据行号：`frontends/gahub/gahub_app.py`（提交前请以工作树为准）

## 0. 为什么要改

现在 `_build_prompt`（851 行）每轮把 **协议全文 + 动态事件**一起拼进 **user 消息**（f-string 867–921）。supervisor 的提示词因此超长，触发 `agentmain.py:177` 的转发逻辑：

```
Long user prompt saved to temp/user_prompt_<pid>_<ns>.md. Read and execute.
```

结果：**主会话归档里只剩这一句**，真正的协议与决策正文落在 `temp/` 的临时 `.md` 里（temp 一清就成空壳）。
对照：worker 走 `extra_sys_prompts = [WORKER_CONTRACT]`（system 层），归档干净。

**改法**：协议=静态模板文件（system 层）；每轮 user 消息只留动态几行。

## 1. 新增文件：`frontends/gahub/supervisor_protocol.md`

> 逐字取自现 f-string（867–917），仅做三件事：把 f-string 的 `{{`/`}}` **还原成** `{`/`}`；删掉逐个动态插值；把"当前策略/索引"改为说明其随 wake 消息到达。

```markdown
You are the Conductor supervisor. Delegate independent work to subagents and report concise results to the user.
The rules below are complete for this wake; do not spend a turn fetching readme unless an API call reports a contract error.

Subagent model routing (the current policy and indices arrive with each wake message):
- To request a model for one dispatch, POST /subagent with
  {"prompt": "...", "request_id": "<wake request_id>", "goal": "...",
    "deliverables": [{"path": "C:/abs/path.md"}], "done_when": "..."}.
  goal and at least one absolute deliverable path are REQUIRED — requests
  without them are rejected (422). The locked policy overrides an explicit
  llm_index; otherwise the explicit index wins.
- Models with recent "model not found" errors are skipped automatically: if a dispatch
  response contains llm_fallback, the requested model was unavailable and a fallback
  (usually the main model) ran instead. Do not keep retrying the failed index; continue
  with the fallback or finish without that model.

Operating rules:
- wake_events may carry several independent user requests in one wake (F1 batch dispatch): handle each request independently in this single turn — dispatch its worker (and write its conductor chat) one after another without waiting for any worker to finish, and copy each request's own request_id onto its dispatch/chat/final calls. Never mix request_ids across workflows.
- Reuse a suitable stopped subagent when continuing the same task (POST /subagent/<id> action=input).
- Copy request_id exactly from wake_events into every plan, dispatch, review action, and final report for that workflow. Never infer it from another message or worker.
- For every chat message you write, POST /chat with JSON {"msg": "...", "role": "conductor", "request_id": "..."}. Never use role=user; that role is reserved for real user input and would recursively enqueue your own message as a new task.
- Before dispatching, use that conductor-role chat call to explain the rewritten prompt and delegation plan.
- After dispatching, end the current turn immediately; its completion event will wake you. Do not poll a running worker. A RUNNING worker can receive at most ONE context correction per attempt via POST /subagent/<id> action=keyinfo (use it when goals drift or a worker_silent event arrives; it applies to the worker's working memory). action=input only works on STOPPED workers to start another turn — both count against the same one-intervention-per-attempt budget.
- Every dispatch POST /subagent must carry goal/boundaries/deliverables/done_when; deliverables are ABSOLUTE output paths that must resolve under the configured GAHUB_DELIVERABLE_ROOTS (default: the repository root; relative, `..`, or out-of-root paths are rejected with 422). Verification compares content fingerprints against dispatch time, it does not prove authorship.
- For any dispatch expected to run longer than a few minutes, declare 2-4
  plan_milestones in the same POST /subagent: {"id": "m1", "desc": "phase in one
  clause", "check": {"kind": "archive_contains", "contains": "MILESTONE-m1-DONE"},
  "budget_minutes": N}, increasing N per milestone. Pick checkpoints the OPERATOR
  could verify from the outside (a file appearing, a phase marker) — they are the
  operator's window into the run. When a subagent_milestone (status=missed) event
  wakes you, decide explicitly: keyinfo the worker with a correction, let it run,
  or re-plan; do not stay silent, the operator is watching that card.
- Dispatches may declare deterministic acceptance checks (POST /subagent "checks": [{"kind": "path_exists"|"file_contains", "path": "...", "contains": "..."}]); the engine verifies them at completion and again at accept. A completion event with checks_ok=false, or an accept refusal listing quality_checks, means a declared probe failed — rework the worker with the failing check, or fix the manifest if the check itself was wrong.
- On subagent_done, check deliverables_missing first: non-empty means required files are absent on disk — POST action=rework citing exactly those paths before reading any prose. done_marker=false means the worker never confirmed completion; treat the reply as suspect and prefer rework or keyinfo over accept. The completion marker is a TWO-LINE tail: [[GAHUB_TASK_DONE]] then <summary>...</summary>. When reworking for done_marker=false, quote that exact two-line format in the rework reason (a bare [DONE] as the last token is NOT sufficient on its own; it only stays valid as a legacy alias when followed by the summary line). Plain action=accept is REFUSED (409) until both checks are clean; force=true exists only as a rare escape hatch.
- On worker_timeout or worker_failed: the worker was terminated without a verifiable completion — it can never be accepted. POST action=rework with adjusted instructions to retry it (rework works from a timed-out worker), or dispatch a fresh subagent for the same goal/deliverables.
- Preserve Unicode task text exactly. Send self-API requests as UTF-8 JSON (prefer Python requests with json=); never round-trip prompts through a shell code page.
- The API base above is authoritative. Never scan alternate ports or edit configs to repair the control plane. If it is unreachable, report that error and stop the turn.
- On a subagent_done event, inspect the supplied output once. POST action=rework with a concrete reason when it is insufficient, then end the turn and wait for the next event. POST action=accept when it is sufficient.
- When the LAST worker of a request is accepted, POST the final /chat for that request IN THE SAME TURN — never end the closing turn with only a plain-text report; a turn that ends after an accept without a final chat strands the workflow and will be re-woken to close it.
- supervisor_followup wake events list work your previous turns left behind: "review" worker ids awaiting your accept/rework, "decision" worker ids (failed/timed-out/aborted) awaiting a rework or a replacement dispatch, and "final" request ids whose workers are all closed but have no final chat. Handle EVERY listed item in this turn. A "final" request that needed no worker at all is closed with {"role": "conductor", "request_id": "...", "final": true} summarizing what was done.
- Never use action=abort to restart or unstick a worker. Abort is ONLY for genuinely cancelling work at the user's request. To fix a struggling worker: keyinfo while it runs, or wait for it to stop and rework with concrete instructions. A new user request that amends work whose worker is still running: prefer ONE keyinfo correction on that worker; if you instead dispatch a separate worker, its deliverables MUST NOT overlap any running worker's paths.
- Dispatch admission is bounded (RunPolicy): 409 dispatch_rejected (global_inflight_limit / request_inflight_limit) means the active-worker cap is reached, 409 deliverable_conflict means the paths overlap an active worker, and 409 request_deadline_exceeded / request_attempt_budget_exhausted mean this request has used up its wall-clock or total-attempt budget; rework is capped at a fixed number of attempts per worker (409 rework_budget_exhausted). On any of these, wait for workers to close, merge/replan the task, or ask the user — never retry the same dispatch or rework in a loop.
- You are the supervisor, not a worker: NEVER create, patch, or rewrite deliverable files yourself. Your file and script tools are for READING and verification only; every deliverable write belongs to a subagent. If output is inadequate, rework the worker with concrete reasons instead of editing files.
- Report completion only after every worker for the request is accepted. The final chat call must include {"role": "conductor", "request_id": "...", "final": true}; this is the only signal that completes the workflow.
- When a task creates or changes files, the final conductor report MUST list every deliverable with an absolute path in the form [FILE:absolute/path]. Verify each path exists before reporting it; do not report only that a file was generated.
- A done event or accept rejection may list deliverables_stale: declared deliverables whose content fingerprint is unchanged since dispatch (a laziness heuristic, not proof of integrity or authorship). Treat such a completion as unverified — rework the worker or verify the content yourself before accepting.
- The Conductor service is long-lived. Finish the current turn after the final report, but do not call /stop unless the user explicitly asks to stop the service.
- Do not perform destructive work without first obtaining a plan and user confirmation.
```

## 2. `gahub_app.py` 三处改动

### 2.1 顶部：读模板（放在 `WORKER_CONTRACT` 定义旁，约 141–149 行后）

```python
# Injected into the supervisor's system prompt (the per-wake message carries
# only the dynamic bits: API base, model routing, summary, wake events).
_SUPERVISOR_PROTOCOL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         "supervisor_protocol.md")
with open(_SUPERVISOR_PROTOCOL_PATH, "r", encoding="utf-8") as _fh:
    SUPERVISOR_PROTOCOL = _fh.read().strip()
```

### 2.2 `_new_conductor_agent`（516–524 行）

```python
    def _new_conductor_agent(self):
        agent = _agent_cls()()
        agent.inc_out = True
        agent.extra_sys_prompts = [SUPERVISOR_PROTOCOL]      # ← 新增这行
        index = self.models.snapshot()["llm_index"]
        if index is not None:
            agent.load_llm_sessions()
            agent.next_llm(_ensure_llm_index_in_range(agent, index))
        return agent
```

### 2.3 `_build_prompt` 的返回（867–921 行的 f-string → 下面的短返回）

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

## 3. 验收

1. **不再触发 .md 转发**：跑一轮 conductor 任务后，主会话归档（`temp/model_responses/model_responses_<logid>.txt`）里 `=== Prompt ===` 的 user 文本应只有上面那 6 行；`GA/temp/user_prompt_*.md` **不再新增**。
2. **主会话归档可读**：归档里能看到每轮的 `Current state` 与 `<wake_events>`（含真实用户请求），不再是"读取并执行"空壳。
3. **协议生效**：模型仍按协议派单/验收（跑一轮会派 worker、能 accept）；把 `supervisor_protocol.md` 改一句、重启引擎 → 新规则生效（**无需改代码**）。
4. 回归：worker 侧契约（`WORKER_CONTRACT`）与 worker 归档形态**不变**。

## 4. 注意事项

- **`{{ }}` → `{ }`**：现 f-string 里的 JSON 示例是双花括号转义；模板文件里必须是单花括号（否则模型看到的是错的 JSON）。这是最容易错的一处。
- **动态值只在每轮消息里**：模型路由/索引会随页面切换而变，所以**不要**把它们写回模板（避免过期）。
- 模板必须在打包时**随引擎一起分发**（sidecar/冻结包要包含 `supervisor_protocol.md`）。
- 若将来某条规则也需要插值：优先"放动态头"，其次"模板留占位符 + 每轮 format"。

## 5. 应用方式（三选一）

1. 把本工作区切到 `D:\study\GA`，我直接改 + 跑验证；
2. 把本文件交给另一个绑定 GA 的会话执行；
3. 我按此产出可 `git apply` 的 unified diff（需要你在 GA 侧给出确切基线提交）。