# 调研:撤回"队列中的消息"

> 日期:2026-10-13 | 类型:调研(不改代码) | 仓库:GA-Hub `D:/study/GA/temp/projects/GA-Hub-d795c16e` + GA `D:/study/GA`

## 0. 一句话结论

**当前代码里,"消息撤回"唯一有意义的落点是 Goal/Hive 的任务队列;而它恰好存在一个已登记、按用户要求暂缓的缺陷(R2·P1)**:任务已 `put_task` 入队、但 GA 运行线程尚未取出执行的窗口内,前端"停止"按钮无效,活动状态要等任务真正跑完才释放。主聊天侧从设计上就不排队(忙则 409),前端也没有本地待发队列;**定时消息**是另一类"待发送队列",但已有独立的取消路径。

因此"撤回队列中的消息"在现状下 = **修复 R2**,不是从零造功能。已有约 70% 的现成件可复用。

---

## 1. "队列"在系统中的全部落点(先厘清语义)

全仓检索 `队列 / queue / pending / queued / 撤回 / 待发送`,真实存在的"队列"只有三处:

| # | 位置 | 性质 | 是否含"撤不回"的问题 |
|---|---|---|---|
| A | **主聊天**(AgentService + `session_coordinator`) | **无队列**。忙则直接 409 `AgentBusyError` | ❌ 不适用(见 §2) |
| B | **Goal/Hive** `goalhive_service.submit → agent.put_task` | **真队列**(GA `task_queue`)| ✅ **正是 R2 缺陷所在** |
| C | **定时消息** `scheduledChats`("待发送定时消息"横向条) | 计划任务,状态机 `pending/dispatching/sent/cancelled` | ⚠️ 已有取消入口(见 §5) |

> 注:`LiveChatTranscript.tsx:566` 的 `aria-label="待发送定时消息"` 属 C 类,不是"发出去还没跑"的队列。

---

## 2. 主聊天为什么"不用撤回"(负面证据,避免误判)

主聊天没有服务端排队,前端也没有本地待发队列,因此不存在"撤回排队消息"的场景:

- 服务端准入:`session_coordinator` 在提交时若发现同一 session 已有活动 run,直接 `raise self._busy(same_session, reason=REASON_SESSION_ACTIVE)`(`session_coordinator.py:421-427`);超容量则 `_busy(next(...))`。
- 路由层把它映射成 409(`server/routes/sessions.py`,`_api_error` 家族;`AgentBusyError` 语义)。
- 前端 `webui/src/api/client.ts:243-247` 对 409/`operation_in_progress` 等做"uncertain"分类,**不重试也不排队**。
- 端点 `/api/sessions/{session_id}/abort` 已有(撤回当前 run),但它是"中止正在跑的",不是"撤回排队的"。

**结论:主聊天不需要做撤回队列,因为它根本不排队。**

---

## 3. Goal/Hive:R2 缺陷的完整机理(核心)

### 3.1 入队与执行的时序裂缝

- **入队**:`goalhive_service._submit_locked` 在 `goalhive_service.py:336` 调 `agent.put_task(prompt, source="goalhive")`;
  GA `agentmain.py:131-134`:
  ```python
  def put_task(self, query, source="user", images=None):
      display_queue = queue.Queue()
      self.task_queue.put({...})   # ← 只入队,不置 is_running
      return display_queue
  ```
- **取队**:GA `agentmain.py:152-171` 的运行线程:
  ```python
  task = self.task_queue.get()
  ...
  self.is_running = True; self._current_queue = display_queue   # 行 171
  ```
  **即 `is_running` 是在 put 之后、由另一线程取出时才置真的。**
- **撤回**:Goal/Hive 的 `abort()`(`goalhive_service.py:454-463`)只做:
  ```python
  agent.abort()            # 见下,空闲时是 no-op
  self._finish_active_messages()   # 把 messages 标记为非 streaming、清 _active_stream_id
  ```
  而 GA `abort()`(`agentmain.py:112-113`):
  ```python
  def abort(self):
      if not self.is_running: return     # ← 任务还没被取走时,直接返回,什么都不做
  ```

### 3.2 结果(正是 R2 描述)

若在一个任务"已入队、runner 尚未 `get()`"的窗口内点"停止":

1. `agent.abort()` no-op(因为 `is_running` 还是 False);
2. 但 `_finish_active_messages()` 把 UI 侧消息结束、`_active_stream_id=None` → **UI 看起来"停了"**;
3. **GA 队列里的任务还在**。runner 随后照常取出并执行;
4. 更糟:该任务的 `display_queue` 仍在 `self._stream_queues` 里,`_drain` 线程会把它读出来写回 `self.messages`(按 `msg_id` 找消息更新),**于是被"停止"的消息又活过来继续流式**;
5. 若期间又发了新任务,新任务排在旧任务后面,`_active_stream_id` 已被清 → `submit` 的 busy 判定与队列状态错位,活动状态释放时机错误(文档表述:"活动状态等待真实完成后释放")。

这解释了 `docs/TODO_REMAINING.md:13` 的记录:
> **R2 · P1 · 按用户要求暂缓**:Goal/Hive 停止覆盖任务已入队但 runner 尚未开始的窗口,活动状态等待真实完成后释放。

以及 `docs/archive/project-structure-review-20261010.md:32-36` 的原始 R2 描述(同一问题,行号 336/454-463 完全吻合本报告)。

### 3.3 补充:Goal/Hive 语义上允许排队,所以"排队消息"确实可能超过 1 条

- `submit` 只在 `self._closed`(关闭中)或 `_submit_locked` 内特定条件才拒绝;多条任务是允许堆积在 GA `task_queue` 里的。
- 因此"队列中的消息"在 Goal/Hive 里可以是**多条**,不只是一条。

---

## 4. 关键发现:修复件已大部分现成

### 4.1 `_discard_pending_tasks` 已经写好,只差接到 abort 上

`goalhive_service.py:170-188` 已存在静态方法:
```python
@staticmethod
def _discard_pending_tasks(task_queue: object) -> None:
    """Drain pending items from a queue.Queue, respecting task_done()."""
    ... get_nowait() 循环直到 _q.Empty ...
```
目前**只在 `shutdown()` 里被用**(`:214-222`,配合 `_RUNNER_STOP` 哨兵唤醒 runner)。`abort()` 里**没有**调用它 —— 这就是 R2 的修复缺口。

### 4.2 GA 侧已支持"字符串哨兵"关闭信号

`agentmain.py:152-157`:
```python
while True:
    task = self.task_queue.get()
    if isinstance(task, str):      # 字符串 = 停止信号
        self.task_queue.task_done()
        break
```
且运行线程本身是 daemon 语义、由 `_ensure_runner` 重建(`test_next_submit_restarts_an_unexpectedly_exited_runner` 证明支持重启)。

> ⚠️ 重要陷阱:GA `run()` 里 `if isinstance(task, str): break` 会**直接退出整个运行线程**。若 abort 时误用哨兵"排空",会把 runner 线程也杀掉;而 `shutdown()` 之所以敢用,是因为它本来就要终止 runner。所以 **abort 不能照抄 shutdown 的哨兵路径**,应只做 `_discard_pending_tasks`(清空队列里未取走的任务),**不**投哨兵。

### 4.3 需要新增/收紧的点

1. `abort()` 需要知道"当前这条任务是否已被 runner 取走",以便:
   - 已取走 → 走现有 `agent.abort()`(真实中断);
   - 未取走(仍在队列)→ 把它从 `task_queue` 移除,并让对应 `display_queue` 收到终止信号、从 `_stream_queues` 摘除,避免 `_drain` 复活消息。
2. `_discard_pending_tasks` 目前无差别清空**整个**队列。Goal/Hive 队列里理论上可能混入非 goalhive 来源的任务?经查 `source` 字段区分,Goal/Hive 走独立 service/agent 实例,可接受"清空全部 pending"。若要求只撤回"某一条",则需改成按 key 过滤(成本更高,见 §6)。

---

## 5. 定时消息(第三类"待发送")的现状——已可取消

- 前端:`LiveChatTranscript.tsx:566` 渲染 `aria-label="待发送定时消息"` 的横向条,支持点击取消;相关 API `client.ts:529-535`(`scheduledChats / createScheduledChat(scheduled_for)`)。
- 服务端状态机:`schemas.py:514` `status: Literal["pending","dispatching","sent","cancelled"]`。
- **结论:这一类已有完整取消路径,不属于本次"撤不回"范围。** 若用户所指正是它,则问题只是 UI 入口不够显眼,而非缺功能。

---

## 6. 修复方案(供决策,本次不实施)

### 方案 A(推荐,最小改动,复用 90% 现成件)

在 `GoalHiveService.abort()` 中,先"排空未取走任务"再 `agent.abort()`:

```python
def abort(self) -> None:
    with self._lifecycle_lock:
        agent = self.agent
        if agent:
            task_queue = getattr(agent, "task_queue", None)
            if task_queue is not None:
                self._discard_pending_tasks(task_queue)   # ← 新增:清掉未取走的
            try:
                agent.abort()      # 已取走的,由 GA 真实中断
            except Exception as e:
                log.warning("goalhive abort failed: %s", e)
        self._finish_active_messages()
        # 还需:清理 _stream_queues 中对应屏道,防止 _drain 复活(见下)
```
配套:
- `_drain` 侧:当 `_active_stream_id` 已不在 / 或收到终止哨兵时,丢弃该流的后续 `next` 更新(`goalhive_service.py:380` 已有 `_RUNNER_STOPPED_KEY` 分支可参考),避免"停掉的消息复活"。
- 边界:并发 submit 与 abort 都在 `_lifecycle_lock` 下,保持单锁域(BACKLOG:406-409 明确"做并发撤回前必须先统一锁域"——这里正是那个锁域)。

**验收标准(建议测试)**:
1. 入队后立即 abort → GA 队列为空、`is_running` 保持 False、UI 消息保持非 streaming 且**不再被复活**;
2. 任务已在执行中 abort → 行为与现状一致(真实中断);
3. abort 后立刻 submit 新任务 → 新任务正常执行,不被旧任务污染;
4. 连续 submit 多条再一次 abort → 队列清空。

### 方案 B(精准撤回单条)

给 `submit` 返回的每一项携带 token,`abort(token)` 只移除对应项。**成本高**:GA `task_queue` 是 `queue.Queue`,不支持按 key 删除,需要"取出→过滤→放回"或换数据结构(触碰 GA 核心 `agentmain.py`,属改动自身源码范畴,须请示)。**收益场景不明**(Goal/Hive 通常一次一条目标),暂不建议。

### 方案 C(不改 GA,只在 Hub 侧加"逻辑取消"标记)

不碰 GA 队列,改为:被撤回的任务仍会被执行,但 Hub 侧 `_drain` 直接丢弃其输出、立即释放活动状态。**缺点**:GA 仍会实际跑一遍(浪费算力、可能起副作用,如 hive 子代理),语义只是"假装停了"。**不推荐**,除非明确要求零侵入 GA。

---

## 7. 风险与约束

| 项 | 说明 |
|---|---|
| 锁域 | BACKLOG 明确要求"统一锁域"。abort 需与 submit 同锁(`_lifecycle_lock`),否则 `_active_stream_id`/`_stream_queues` 竞态。 |
| 哨兵误用 | 不可在 abort 里投 `_RUNNER_STOP`(会终止 runner 线程)。 |
| 消息复活 | 必须同步处理 `_stream_queues` 与 `_drain`,否则 UI 上"撤回"会反弹。 |
| GA 核心改动 | 方案 A 不动 GA;方案 B 需改 `agentmain.py` → 按宪法须先请示。 |
| 既有暂缓令 | R2 标注"按用户要求暂缓"。**本次是用户主动提出,等于解除暂缓**,可推进;但仍应确认是否只做 Goal/Hive、是否连带 R4。 |

---

## 8. 复用的现成资产清单

- `goalhive_service.py:170-188` `_discard_pending_tasks(task_queue)` —— 直接复用。
- `goalhive_service.py:197-231` `shutdown()` —— 排空 + 唤醒的参考范式(注意哨兵差异)。
- `goalhive_service.py:380` `_RUNNER_STOPPED_KEY` 处理 —— `_drain` 丢弃流的参考。
- `agentmain.py:131-134 / 152-171 / 112-113` —— 队列、runner、abort 的真实语义来源。
- 现有测试:`tests/test_goalhive_service_lifecycle.py`(288 行,已覆盖 shutdown/重启/idempotent)、`tests/test_goalhive_routes.py`、`webui/src/pages/GoalHive.test.tsx` —— 新增用例的挂载点。
- 前端停止入口:`webui/src/pages/GoalHive.tsx`(WS 发 `{"type":"abort"}`)→ `server/routes/goalhive.py:71-72` `service.abort()`。

---

## 9. 待用户决策的最小问题

1. 目标是否就是 **Goal/Hive 的 R2**(停止覆盖"已入队未执行"窗口)?还是仅指**定时消息**的取消?
2. 采用**方案 A**(清空 pending,最小改,不动 GA)还是需要**方案 B**(按条精准撤回,需改 GA)?
3. 是否顺带处理同批暂缓的 **R4**(Goal/Hive reset 复用 GA 原生清理语义)?