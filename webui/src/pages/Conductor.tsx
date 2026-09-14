import { MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, FileCheck2, Play, Square } from 'lucide-react'
import '@/styles/conductor.css'
import { api, type ConductorSubagentModelPolicy } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'
import { useConductorStore } from '@/stores/conductorStore'
import { dialog } from '@/stores/dialogStore'
import { PageShell } from '@/components/PageShell'
import { MainModelSelect } from '@/components/ModelSelect'
import { ActivityTimeline } from '@/components/conductor/ActivityTimeline'
import { HistoryDropdown } from '@/components/conductor/HistoryDropdown'
import { SubagentSettingsModal, type SubagentSettingsValue } from '@/components/conductor/SubagentSettingsModal'
import { TaskCard } from '@/components/conductor/TaskCard'
import { TaskConversation } from '@/components/conductor/TaskConversation'
import { WorkerDossier } from '@/components/conductor/WorkerDossier'
import {
  compactTaskText,
  historyRowsOf,
  isNearScrollBottom,
  isReviewable,
  workerNumbers,
  workflowPresentation,
  isWorkflowClosed,
  type SubagentEvidence,
} from '@/components/conductor/presentation'
import { useConductorData } from '@/hooks/useConductorData'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError, structuredErrorDetailFromError } from '@/utils/sessionUi'
import { formatDurationSeconds } from '@/utils/timeFormat'

const SUBAGENT_MODEL_LOCK_KEY = storageKeys.conductorSubagentModelLocked

/**
 * The engine toggle swaps between 启动 and 停止 in the same slot. Both branches
 * must share this layout: a bare inline button lets the icon and the label break
 * onto two lines once the header row squeezes, so keep it a single
 * shrink-proof inline-flex row regardless of which label is showing. Colours
 * stay per-branch (primary vs danger) — only the layout is shared.
 */
const ENGINE_TOGGLE_LAYOUT = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap'

function readSubagentModelLock(): boolean {
  try {
    return localStorage.getItem(SUBAGENT_MODEL_LOCK_KEY) === 'true'
  } catch {
    return false
  }
}

function writeSubagentModelLock(locked: boolean): void {
  try {
    localStorage.setItem(SUBAGENT_MODEL_LOCK_KEY, String(locked))
  } catch {}
}

export default function Conductor() {
  const qc = useQueryClient()
  const [userMsg, setUserMsg] = usePageState('conductor.userMsg', '')
  const [subagentModelLocked, setSubagentModelLocked] = useState(readSubagentModelLock)
  const [subagentSettingsOpen, setSubagentSettingsOpen] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  // Subagent review surface (roadmap P1-B): inline accept/rework/abort with
  // the engine's verification evidence shown before any forced accept.
  const [reworkSid, setReworkSid] = useState<string | null>(null)
  const [reworkReason, setReworkReason] = useState('')
  const [evidenceBySid, setEvidenceBySid] = useState<Record<string, SubagentEvidence>>({})
  const [busySid, setBusySid] = useState<string | null>(null)
  const [selectedSid, setSelectedSid] = useState<string | null>(null)
  // Task-history pin: null = auto-follow the newest open workflow. Pinned
  // views survive new task arrivals until the user switches back.
  const [pinnedRequestId, setPinnedRequestId] = useState<string | null>(null)
  // The conversation now lives permanently in the left column; the right
  // column is pure dossier, so its tabs only pick between delivery detail
  // and the activity timeline.
  const [contextTab, setContextTab] = useState<'delivery' | 'activity'>('delivery')
  const [mobileView, setMobileView] = useState<'board' | 'context'>('board')
  // The worker queue is a one-line-per-worker module now; collapsing it hands
  // the freed rows to the conversation below. Remembered per browser session.
  const [processCollapsed, setProcessCollapsed] = usePageState('conductor.processCollapsed', false)
  // Bumped to move focus into the composer (retry prefill).
  const [composerFocusTick, setComposerFocusTick] = useState(0)
  const actionInFlightRef = useRef(false)
  const chatEndRef = useRef<HTMLDivElement | null>(null)
  const chatScrollRef = useRef<HTMLDivElement | null>(null)
  const shouldFollowChatRef = useRef(false)

  // Extract store actions (stable references) to avoid socket churn
  const addChatMessage = useConductorStore((s) => s.addChatMessage)
  const chatMessages = useConductorStore((s) => s.chatMessages)
  const subagents = useConductorStore((s) => s.subagents)

  // Poll status
  const { data: status } = useQuery({
    queryKey: queryKeys.conductor.status,
    queryFn: () => api.conductorStatus(),
    refetchInterval: 12_000,
    refetchIntervalInBackground: false,
  })

  // Conductor and Goal/Hive share durable key-based model preferences.
  const { data: llmsData } = useQuery({
    queryKey: queryKeys.llms,
    queryFn: api.llms,
  })
  const llms = llmsData?.llms ?? []
  const {
    mainLlmKey,
    subagentLlmKey,
    mainLlmIndex: effectiveLlmIndex,
    subagentLlmIndex: effectiveSubagentLlmIndex,
    selectedSubagentLlmIndex,
    selectMainLlm,
    selectSubagentLlm,
  } = useSharedModelSelection(llms)
  const subagentModelPolicy: ConductorSubagentModelPolicy = subagentLlmKey === null
    ? 'follow_main'
    : subagentModelLocked ? 'locked' : 'default'
  const conductorModelSettings = useMemo(() => ({
    llmIndex: effectiveLlmIndex,
    subagentLlmIndex: selectedSubagentLlmIndex,
    subagentModelPolicy,
  }), [effectiveLlmIndex, selectedSubagentLlmIndex, subagentModelPolicy])

  // Selecting a history row switches the pinned task but keeps the dropdown
  // open: comparing/stepping through several tasks is the whole point of the
  // list, and closing on every click would force a reopen each time. The
  // dropdown dismisses on outside press / Escape / trigger toggle.
  //
  // Stable identity (useCallback) is load-bearing, not decoration: both
  // `HistoryPanel` and `WorkerCard` are memo'd on top of these handlers, and
  // an inline closure makes the memo comparison fail on every page render
  // (i.e. on every composer keystroke).
  const selectHistoryWorkflow = useCallback((id: string) => {
    setPinnedRequestId((current) => (current === id ? null : id))
    setSelectedSid(null)
  }, [])

  const saveSubagentSettings = ({ llmKey, locked, autoAccept }: SubagentSettingsValue) => {
    selectSubagentLlm(llmKey)
    setSubagentModelLocked(locked)
    writeSubagentModelLock(locked)
    if (status && autoAccept !== status.auto_accept) {
      api.conductorSettings(autoAccept)
        .then((next) => qc.setQueryData(queryKeys.conductor.status, next))
        .catch(() => toast.error('保存自动验收设置失败，请稍后重试。'))
    }
  }

  const { workflows, isChatLoading, isChatError, refetchChat } = useConductorData(() => {
    shouldFollowChatRef.current = isNearScrollBottom(chatScrollRef.current)
  })

  const currentWorkflow = useMemo(() => {
    if (pinnedRequestId) {
      const pinned = workflows.find((workflow) => workflow.request_id === pinnedRequestId)
      if (pinned) return pinned
    }
    const active = [...workflows].reverse().find((workflow) => (
      !isWorkflowClosed(workflow)
    ))
    return active ?? workflows.at(-1)
  }, [workflows, pinnedRequestId])
  // Conversation continuity (2026-09 UI audit): while the viewed workflow is
  // still open, the composer APPENDS to it (same request id) instead of
  // forking a new task — previously every message minted a fresh request id
  // and the "本轮对话" filter made the running task's thread vanish.
  const appendTargetRequestId = currentWorkflow
    && !isWorkflowClosed(currentWorkflow)
    ? currentWorkflow.request_id
    : null
  // The explicit start button is a pure bring-up (2026-09 user ruling): it
  // never batch-resumes stranded workflows. Per-task resume lives on the
  // workflow card ("恢复此任务") so the user picks which task continues.

  const submitChat = async (targetRequestId: string | null) => {
    if (!userMsg.trim() || effectiveLlmIndex === null || isSending) return
    const msg = userMsg.trim()
    setUserMsg('')
    setIsSending(true)

    // Send and use returned item (with real id) for instant display.
    // The EventBus and snapshot bootstrap merge by id, so this stays unique.
    try {
      const item = await api.conductorSendChat(msg, 'user', conductorModelSettings, targetRequestId ?? undefined)
      shouldFollowChatRef.current = true
      addChatMessage({
        id: item.id,
        role: item.role as 'user' | 'assistant',
        msg: item.msg,
        ts: item.ts,
        request_id: item.request_id,
        kind: item.kind,
      })
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      // A user message implicitly starts the supervisor when needed. Refresh
      // the badge immediately instead of waiting for the 12s status poll.
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.status })
    } catch (err) {
      console.error('sendChat failed', err)
      // Preserve anything the user typed while the request was in flight.
      setUserMsg((current) => current.trim() ? `${current}\n${msg}` : msg)
      toast.error(
        err instanceof Error && err.name === 'HttpTimeoutError'
          ? '任务请求超时。任务可能仍在启动或已被受理，请勿立即重复发送。'
          : '任务发送失败，内容已恢复，请检查 Conductor 状态后重试。',
        7000,
      )
    } finally {
      setIsSending(false)
    }
  }

  const stopConductor = async () => {
    if (isStopping) return
    setIsStopping(true)
    try {
      const result = await api.conductorStop()
      if (!result.ok) {
        toast.error('Conductor 未能停止，请检查引擎状态。')
        return
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.conductor.status }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.subagents }),
      ])
      toast.success('Conductor 已停止')
    } catch (err) {
      console.error('stopConductor failed', err)
      toast.error('停止 Conductor 失败，请稍后重试。')
    } finally {
      setIsStopping(false)
    }
  }

  const startConductor = async () => {
    if (isSending || isStopping) return
    setIsSending(true)
    try {
      const result = await api.conductorStart(conductorModelSettings)
      if (!result.ok) {
        toast.error('Conductor 未能启动，请检查引擎配置。')
        return
      }
      await qc.invalidateQueries({ queryKey: queryKeys.conductor.status })
      toast.success('Conductor 已启动：不会自动重跑任务，需要续跑时用任务卡上的“恢复此任务”')
    } catch (err) {
      console.error('startConductor failed', err)
      // The backend sends actionable detail (bad llm index 422, engine
      // 502/503) — surface it instead of a fixed retry line.
      toast.error(errorMessageFromError(err, '启动 Conductor 失败，请稍后重试。'))
    } finally {
      setIsSending(false)
    }
  }

  // Per-task resume (恢复此任务): the backend brings the supervisor up and
  // re-relays ONLY this workflow's original message — every other open task
  // stays untouched. This replaces the old blanket redispatch that one
  // header click used to trigger for all stranded workflows.
  const resumeCurrentWorkflow = async () => {
    if (!currentWorkflow || isResuming || isSending || isStopping) return
    setIsResuming(true)
    try {
      const result = await api.conductorResumeWorkflow(currentWorkflow.request_id)
      if (!result.ok) {
        toast.error('该任务未能恢复，请检查引擎状态。')
        return
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.conductor.status }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.subagents }),
      ])
      toast.success('已恢复该任务：仅重放这一个任务的原始指令，其他任务不受影响')
    } catch (err) {
      console.error('resumeCurrentWorkflow failed', err)
      toast.error(errorMessageFromError(err, '恢复任务失败，请稍后重试。'))
    } finally {
      setIsResuming(false)
    }
  }

  const runSubagentAction = async (
    sid: string,
    action: 'accept' | 'rework' | 'abort',
    msg = '',
    force = false,
  ) => {
    if (actionInFlightRef.current) return
    actionInFlightRef.current = true
    setBusySid(sid)
    try {
      const worker = subagents.find(sub => sub.id === sid)
      const expected = worker?.boot_id ? {
        expected_boot_id: worker.boot_id,
        expected_generation: worker.active_generation,
        expected_command_revision: worker.command_revision,
      } : undefined
      await api.conductorSubagentAction(sid, action, msg, null, {}, force, expected)
      setEvidenceBySid((prev) => {
        if (!(sid in prev)) return prev
        const next = { ...prev }
        delete next[sid]
        return next
      })
      setReworkSid((prev) => (prev === sid ? null : prev))
      setReworkReason('')
      toast.success(action === 'accept' ? '已通过验收' : action === 'rework' ? '已打回子代理' : '已终止子代理')
      // Review efficiency: after a decision, jump straight to the next worker
      // that still needs one. Archived rows are skipped: they have no action
      // to take, so landing the dossier there would stall the review queue.
      if (action !== 'abort') {
        const rest = workflowSubagents.filter((sub) => sub.id !== sid && !sub.archived)
        const next = rest.find(isReviewable)
          ?? rest.find((sub) => sub.status === 'running')
          ?? rest[rest.length - 1]
        if (next) setSelectedSid(next.id)
      }
    } catch (err) {
      const detail = structuredErrorDetailFromError<SubagentEvidence>(err)
      if (action === 'accept' && detail?.error === 'completion_unverified') {
        setEvidenceBySid((prev) => ({ ...prev, [sid]: detail }))
        toast.error('机器验收未通过，已展示证据；可人工核对后强制通过。')
      } else {
        console.error('subagent action failed', action, sid, err)
        // rework's 409 carries the engine reason as a STRING detail;
        // structuredErrorDetailFromError only unwraps objects.
        toast.error(errorMessageFromError(err, '操作失败，请稍后重试。'))
      }
    } finally {
      actionInFlightRef.current = false
      setBusySid(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.conductor.subagents }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows }),
      ])
    }
  }

  // One task title per request, oldest user message wins (the task origin).
  const taskTitleByRequest = useMemo(() => {
    const map = new Map<string, string>(workflows.filter(workflow => workflow.title)
      .map(workflow => [workflow.request_id, compactTaskText(workflow.title!)]))
    for (const item of chatMessages) {
      if (item.role === 'user' && item.request_id && !map.has(item.request_id)) {
        map.set(item.request_id, compactTaskText(item.msg))
      }
    }
    return map
  }, [chatMessages, workflows])

  // The history list model is computed once here: the header trigger needs
  // the same attention count the drawer list renders.
  const historyRows = useMemo(
    () => historyRowsOf(workflows, subagents, taskTitleByRequest, status?.started ?? false),
    [workflows, subagents, taskTitleByRequest, status?.started],
  )

  const workflowSubagents = useMemo(() => {
    // No workflow on screen → no worker cards. The earlier slice(-5) fallback
    // orphaned pool/archive workers under a "尚未收到任务" header, which reads
    // as a contradiction now that archived rows persist across engine resets.
    if (!currentWorkflow) return []
    const workerIds = new Set(Object.keys(currentWorkflow.subagents))
    return subagents
      .filter((sub) => sub.request_id === currentWorkflow.request_id || workerIds.has(sub.id))
      // Ties broken by id: parallel spawns share a created_at second, and an
      // unstable order made the cards swap positions on every poll.
      .sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id))
  }, [currentWorkflow, subagents])
  const workerNumberById = useMemo(() => workerNumbers(workflowSubagents), [workflowSubagents])
  const currentTask = currentWorkflow ? taskTitleByRequest.get(currentWorkflow.request_id) || '当前任务' : ''
  const visibleChat = useMemo(() => {
    if (!currentWorkflow) return chatMessages
    return chatMessages.filter((item) => item.request_id === currentWorkflow.request_id)
  }, [chatMessages, currentWorkflow])
  const workflowView = workflowPresentation(currentWorkflow, status?.started ?? false)
  const workflowOpen = currentWorkflow !== undefined
    && !isWorkflowClosed(currentWorkflow)
  // An open workflow needs a live clock; a closed one shows a fixed duration
  // and needs none. Handing the ticking case to <WorkflowElapsed> keeps the
  // 1s re-render scoped to that one label instead of the whole board.
  const liveStartedAt = (() => {
    if (!workflowOpen || !currentWorkflow) return null
    const started = currentWorkflow.created_at
    return Number.isFinite(started) && started > 0 ? started : null
  })()
  const finishedDuration = useMemo(() => {
    if (workflowOpen || !currentWorkflow) return ''
    // The workflow row is rewritten on close (created_at ≈ completed_at),
    // so its own timestamps cannot measure a finished task. The chat span
    // is the honest record: first message → last message.
    const stamps = visibleChat.map((item) => item.ts).filter((ts) => Number.isFinite(ts) && ts > 0)
    if (stamps.length >= 2) {
      const span = (Math.max(...stamps) - Math.min(...stamps)) / 1000
      if (span > 0) return `用时 ${formatDurationSeconds(span)}`
    }
    const started = currentWorkflow.created_at
    const finished = currentWorkflow.completed_at
    if (Number.isFinite(started) && typeof finished === 'number' && finished > started) {
      return `用时 ${formatDurationSeconds(finished - started)}`
    }
    return ''
  }, [workflowOpen, currentWorkflow, visibleChat])
  // Count from the merged worker set first: archived rows are absent from
  // the tracker's subagents map, so deriving the totals from the map alone
  // made a finished-but-archived task read "0 尚未指派" under the same cards
  // the process grid was showing. The tracker map is the pre-archive fallback.
  const trackerWorkers = currentWorkflow ? Object.values(currentWorkflow.subagents) : []
  const workerCount = workflowSubagents.length || trackerWorkers.length
  const acceptedCount = workflowSubagents.length
    ? workflowSubagents.filter((sub) => sub.review_status === 'accepted').length
    : trackerWorkers.filter((worker) => worker.state === 'accepted').length
  const activeSubagents = workflowSubagents.filter((sub) => sub.status === 'running')
  const pendingReview = workflowSubagents.filter(isReviewable)
  const selectedWorker = workflowSubagents.find((sub) => sub.id === selectedSid) ?? null

  // Worker rows are pure selectors now: the dossier owns all execution
  // detail, so there is no inline expansion state to keep in sync.
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set())
  const deleteWorkflow = useCallback(async (requestId: string) => {
    if (deletingIds.has(requestId)) return
    const confirmed = await dialog.confirm('删除历史任务', '删除这条历史任务记录？其对话与子代理存档将一并移除，不可恢复。', {
      confirmText: '删除', tone: 'danger',
    })
    if (!confirmed) return
    setDeletingIds((current) => new Set(current).add(requestId))
    try {
      await api.conductorDeleteWorkflow(requestId)
      toast.success('已删除该任务记录')
      if (pinnedRequestId === requestId) setPinnedRequestId(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.subagents }),
      ])
    } catch (err) {
      toast.error(errorMessageFromError(err, '删除失败，请稍后重试。'))
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current)
        next.delete(requestId)
        return next
      })
    }
  }, [deletingIds, pinnedRequestId, qc])
  // The history panel takes a `void` handler; keeping the promise in here lets
  // the memo'd panel receive one stable reference instead of an inline arrow.
  const requestDeleteWorkflow = useCallback((requestId: string) => {
    void deleteWorkflow(requestId)
  }, [deleteWorkflow])

  // Retry entry for a failed workflow: prefill the composer with the task's
  // original wording so the user can adjust it and dispatch a fresh task.
  const retryCurrentWorkflow = () => {
    if (!currentWorkflow) return
    const origin = chatMessages.find((item) => (
      item.role === 'user' && item.request_id === currentWorkflow.request_id
    ))
    setUserMsg(origin ? origin.msg : currentTask)
    // The composer lives in the left column now, so "board" is where the
    // prefilled draft is.
    setMobileView('board')
    setComposerFocusTick((tick) => tick + 1)
  }

  const selectWorker = useCallback((sid: string) => {
    // One click is "open this worker": it selects the dossier and brings the
    // delivery tab forward.
    setSelectedSid(sid)
    setContextTab('delivery')
    setMobileView('context')
  }, [])

  useEffect(() => {
    if (workflowSubagents.length === 0) {
      setSelectedSid(null)
      return
    }
    setSelectedSid((prev) => {
      if (prev && workflowSubagents.some((sub) => sub.id === prev)) return prev
      const next = workflowSubagents.find(isReviewable)
        ?? workflowSubagents.find((sub) => sub.status === 'running')
        ?? workflowSubagents[workflowSubagents.length - 1]
      return next.id
    })
  }, [workflowSubagents])

  // Keyboard review shortcuts were removed (2026-09 ruling: feature pages
  // carry no hotkeys — the command palette is the only keyboard surface).

  return (
    <PageShell
      title="Conductor"
      titleExtra={
        <>
        <span className={`ga-badge ${status === undefined ? 'ga-badge-offline' : status.started ? 'ga-badge-connected' : 'ga-badge-offline'}`}>
          {status === undefined ? '连接中' : status.started ? '运行中' : '未运行'}
        </span>
        </>
      }
      middleArea={
        /* History is a look-back surface, so it anchors to the middle of the
           title bar — it reads as page-level navigation, not as one more
           control in the right-hand cluster. */
        <HistoryDropdown
          rows={historyRows}
          selectedId={currentWorkflow?.request_id}
          onSelect={selectHistoryWorkflow}
          onDelete={requestDeleteWorkflow}
          deletingIds={deletingIds}
        />
      }
      actions={
        <div className="conductor-header-actions">
          {/* Right cluster = two groups with a deliberate gap: [主模型 + 子代理
              模型] ⟷ [启动/停止]. The model-family controls belong together —
              picking the conductor's model and the subagents' models is one
              decision — while the engine toggle stands alone on the right edge.
              Packed at 8px they read as one glued strip; the group gap (22px,
              in CSS) marks the boundary. */}
          <div className="flex items-center gap-2">
            <span className="conductor-header-model-label text-xs text-ink-muted">主模型</span>
            <MainModelSelect
              llms={llms}
              value={mainLlmKey}
              onChange={selectMainLlm}
              className="w-[210px] max-w-full"
              title="选择 Conductor 使用的主模型"
              aria-label="Conductor 主模型"
            />
            <SubagentSettingsModal
              llms={llms}
              value={subagentLlmKey}
              locked={subagentModelLocked}
              autoAccept={status?.auto_accept ?? true}
              open={subagentSettingsOpen}
              onOpenChange={setSubagentSettingsOpen}
              onSave={saveSubagentSettings}
            />
          </div>
          <div className="conductor-header-engine flex items-center gap-2">
            {status?.started ? (
              <button onClick={stopConductor} disabled={isStopping} className={`ga-btn-danger ${ENGINE_TOGGLE_LAYOUT}`}>
                <Square size={13} />停止
              </button>
            ) : (
              <button onClick={startConductor} disabled={isSending} className={`ga-btn ga-btn-primary ${ENGINE_TOGGLE_LAYOUT}`}
                title="仅拉起监督者，不会自动重跑任何任务；要续跑某个暂停任务，用任务卡上的“恢复此任务”">
                <Play size={13} />启动
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        {status?.recovery && !status.recovery.ready && (
          <div role="status" className="conductor-recovery">
            {status.recovery.error ? `调度暂不可用：${status.recovery.error}` : '正在同步任务状态'}
          </div>
        )}
        <div className="conductor-mobile-tabs" role="tablist" aria-label="工作区视图">
          <button role="tab" aria-selected={mobileView === 'board'} onClick={() => setMobileView('board')}>当前任务</button>
          <button role="tab" aria-selected={mobileView === 'context'} onClick={() => setMobileView('context')}>详情</button>
        </div>
        <div className="conductor-layout" data-mobile-view={mobileView}>
          {/* Left column = the task narrative: the board (task card + worker
              queue) on top, the conversation filling everything below. CSS
              caps the board's height so a long queue can never squeeze the
              chat out of the first screen. */}
          <main className="conductor-main">
            {/* Whitespace anywhere on the board toggles the dispatch module
                (fold/unfold) — the flanking strips beside a centred 672px
                module are narrow, and beside the folded one-line header they
                are tiny, so the whole board is the hit target. Interactive
                elements and module content opt out and keep their own
                behaviour. */}
            <div
              className="conductor-board"
              onClick={(e: ReactMouseEvent<HTMLDivElement>) => {
                const target = e.target as HTMLElement
                if (target.closest('button, a, input, textarea, select, .conductor-worker-grid, .conductor-process-empty-note, .conductor-empty')) return
                setProcessCollapsed((open) => !open)
              }}
            >
              <TaskCard
                workflow={currentWorkflow}
                started={status?.started ?? false}
                view={workflowView}
                title={currentTask}
                workerCount={workerCount}
                acceptedCount={acceptedCount}
                activeCount={activeSubagents.length}
                liveStartedAt={liveStartedAt}
                finishedDuration={finishedDuration}
                pendingReview={pendingReview}
                workers={workflowSubagents}
                workerNumberById={workerNumberById}
                selectedSid={selectedSid}
                collapsed={processCollapsed}
                onToggleCollapsed={() => setProcessCollapsed((open) => !open)}
                isResuming={isResuming}
                onResume={() => void resumeCurrentWorkflow()}
                onRetry={retryCurrentWorkflow}
                onSelectWorker={selectWorker}
              />
            </div>
            {/* The conversation is the task's running narrative, so it holds
                the rest of the left column: the scroller flexes, the composer
                pins to the bottom edge. */}
            <TaskConversation
              messages={visibleChat}
              isLoading={isChatLoading}
              isError={isChatError}
              onRetry={() => void refetchChat()}
              followRef={shouldFollowChatRef}
              scrollRef={chatScrollRef}
              endRef={chatEndRef}
              userMsg={userMsg}
              onUserMsgChange={setUserMsg}
              onSubmit={(target) => void submitChat(target === 'append' ? appendTargetRequestId : null)}
              appendMode={appendTargetRequestId !== null}
              llmReady={effectiveLlmIndex !== null}
              sending={isSending}
              focusSignal={composerFocusTick}
            />
          </main>
          <aside className="conductor-context" aria-label="任务详情">
            <div className="conductor-context-tabs" role="tablist" aria-label="任务内容">
              <button id="conductor-tab-delivery" role="tab" aria-controls="conductor-panel-delivery" aria-selected={contextTab === 'delivery'} onClick={() => setContextTab('delivery')}><FileCheck2 size={14} />交付详情</button>
              <button id="conductor-tab-activity" role="tab" aria-controls="conductor-panel-activity" aria-selected={contextTab === 'activity'} onClick={() => setContextTab('activity')}><Activity size={14} />动态</button>
            </div>
            <section role="tabpanel" id="conductor-panel-delivery" aria-labelledby="conductor-tab-delivery" hidden={contextTab !== 'delivery'} className="conductor-context-panel">
              {selectedWorker ? (
                <WorkerDossier
                  sub={selectedWorker}
                  workerNumber={workerNumberById.get(selectedWorker.id)}
                  control={{
                    evidence: evidenceBySid[selectedWorker.id],
                    busy: busySid !== null,
                    reworkOpen: reworkSid === selectedWorker.id,
                    reworkReason: reworkSid === selectedWorker.id ? reworkReason : '',
                    onAccept: () => void runSubagentAction(selectedWorker.id, 'accept'),
                    onForceAccept: () => void runSubagentAction(selectedWorker.id, 'accept', '人工核对证据后强制通过', true),
                    onAbort: () => void runSubagentAction(selectedWorker.id, 'abort'),
                    onReworkOpen: () => { setReworkSid(selectedWorker.id); setReworkReason('') },
                    onReworkReasonChange: setReworkReason,
                    onReworkCancel: () => setReworkSid((prev) => (prev === selectedWorker.id ? null : prev)),
                    onReworkSubmit: () => {
                      if (reworkReason.trim()) void runSubagentAction(selectedWorker.id, 'rework', reworkReason.trim())
                    },
                    onEvidenceDismiss: () => setEvidenceBySid((prev) => {
                      if (!(selectedWorker.id in prev)) return prev
                      const next = { ...prev }
                      delete next[selectedWorker.id]
                      return next
                    }),
                  }}
                />
              ) : (
                <div className="conductor-empty"><FileCheck2 size={28} strokeWidth={1.4} /><p>暂无子代理交付</p></div>
              )}
            </section>
            <section role="tabpanel" id="conductor-panel-activity" aria-labelledby="conductor-tab-activity" hidden={contextTab !== 'activity'} className="conductor-context-panel">
              <ActivityTimeline requestId={currentWorkflow?.request_id ?? null} active={contextTab === 'activity'} />
            </section>
          </aside>
        </div>
      </div>
    </PageShell>
  )
}
