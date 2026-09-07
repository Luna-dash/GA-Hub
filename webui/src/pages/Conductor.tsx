import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, type ConductorSubagentModelPolicy } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'
import { useConductorStore } from '@/stores/conductorStore'
import { PageShell } from '@/components/PageShell'
import { MessageContent } from '@/components/MessageContent'
import { bubbleTone } from '@/components/bubbleTone'
import { ModalOverlay } from '@/components/ModalOverlay'
import { MainModelSelect, SubagentModelSelect } from '@/components/ModelSelect'
import { ActivityTimeline } from '@/components/conductor/ActivityTimeline'
import {
  compactTaskText,
  isNearScrollBottom,
  isReviewable,
  shortWorkerTitle,
  workflowPresentation,
  WORKFLOW_STAGE_CLOSED,
  type SubagentEvidence,
} from '@/components/conductor/presentation'
import { WorkflowBadge } from '@/components/conductor/WorkflowBadge'
import { WorkerListRow } from '@/components/conductor/WorkerListRow'
import { WorkerDossier } from '@/components/conductor/WorkerDossier'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { useHubEvent } from '@/hooks/useHubEvent'
import { useNowTick } from '@/hooks/useNowTick'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError, structuredErrorDetailFromError } from '@/utils/sessionUi'
import { formatDurationSeconds, formatRelativeTime } from '@/utils/timeFormat'

const scrollMemory: { chatTop: number | null } = {
  chatTop: null,
}
const SUBAGENT_MODEL_LOCK_KEY = storageKeys.conductorSubagentModelLocked

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
  const [historyOpen, setHistoryOpen] = usePageState('conductor.historyOpen', true)
  // Rail collapse (2026-09 UI audit): both side columns can be hidden to give
  // the conversation the full width; toggles live in the chat header.
  const [leftCollapsed, setLeftCollapsed] = usePageState('conductor.leftCollapsed', false)
  const [dossierCollapsed, setDossierCollapsed] = usePageState('conductor.dossierCollapsed', false)
  const [draftSubagentLlmKey, setDraftSubagentLlmKey] = useState<string | null>(null)
  const [draftSubagentModelLocked, setDraftSubagentModelLocked] = useState(false)
  const [draftAutoAccept, setDraftAutoAccept] = useState(true)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const subagentSettingsButtonRef = useRef<HTMLButtonElement>(null)
  const subagentSettingsDialogRef = useRef<HTMLDivElement>(null)
  const shouldFollowChatRef = useRef(false)
  const restoredScrollRef = useRef({ chat: false })

  // Extract store actions (stable references) to avoid socket churn
  const addChatMessage = useConductorStore((s) => s.addChatMessage)
  const hydrateSubagents = useConductorStore((s) => s.hydrateSubagents)
  const hydrateChatMessages = useConductorStore((s) => s.hydrateChatMessages)
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

  const openSubagentSettings = () => {
    setDraftSubagentLlmKey(subagentLlmKey)
    setDraftSubagentModelLocked(subagentLlmKey !== null && subagentModelLocked)
    setDraftAutoAccept(status?.auto_accept ?? true)
    setSubagentSettingsOpen(true)
  }

  const closeSubagentSettings = () => {
    setSubagentSettingsOpen(false)
    requestAnimationFrame(() => subagentSettingsButtonRef.current?.focus())
  }

  const saveSubagentSettings = () => {
    const locked = draftSubagentLlmKey !== null && draftSubagentModelLocked
    selectSubagentLlm(draftSubagentLlmKey)
    setSubagentModelLocked(locked)
    writeSubagentModelLock(locked)
    if (status && draftAutoAccept !== status.auto_accept) {
      api.conductorSettings(draftAutoAccept)
        .then((next) => qc.setQueryData(queryKeys.conductor.status, next))
        .catch(() => toast.error('保存自动验收设置失败，请稍后重试。'))
    }
    closeSubagentSettings()
  }


  // Bootstrap snapshots also repair state after page remounts and hard resyncs.
  const { data: subagentSnapshot } = useQuery({
    queryKey: queryKeys.conductor.subagents,
    queryFn: async () => {
      const expectedRevision = useConductorStore.getState().subagentsRevision
      const res = await api.conductorSubagents()
      return { items: res.items, expectedRevision }
    },
    refetchOnMount: 'always',
  })

  const { data: workflowSnapshot } = useQuery({
    queryKey: queryKeys.conductor.workflows,
    queryFn: api.conductorWorkflows,
    refetchOnMount: 'always',
    // SSE is the fast path; this is a quiet recovery path for sleep/wake and
    // half-open connections where the browser has not observed a close yet.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })

  const {
    data: chatSnapshot,
    isLoading: isChatLoading,
    isError: isChatError,
    refetch: refetchChat,
  } = useQuery({
    queryKey: queryKeys.conductor.chat,
    queryFn: async () => {
      const generation = useConductorStore.getState().generation
      return { items: (await api.conductorChat(200)).items, generation }
    },
    refetchOnMount: 'always',
  })

  useEffect(() => {
    if (subagentSnapshot) {
      hydrateSubagents(
        subagentSnapshot.items,
        subagentSnapshot.expectedRevision,
      )
    }
  }, [hydrateSubagents, subagentSnapshot])

  useEffect(() => {
    if (chatSnapshot) {
      hydrateChatMessages(chatSnapshot.items, chatSnapshot.generation)
    }
  }, [chatSnapshot, hydrateChatMessages])

  useHubEvent('conductor:', (event) => {
    if (event.topic === 'conductor:chat' && event.payload.item) {
      shouldFollowChatRef.current = isNearScrollBottom(chatScrollRef.current)
      if (event.payload.item.role === 'user') {
        void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      }
    }
    if (
      event.topic === 'conductor:workflow_completed'
      || event.topic === 'conductor:workflow_failed'
      || event.topic === 'conductor:workflow_cancelled'
      || event.topic === 'conductor:workflow_killed'
    ) {
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      // A terminal transition also flips the badge (started workers freed).
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.status })
    }
    if (
      event.topic.startsWith('conductor:subagent_')
      && !event.topic.endsWith('_running')
    ) {
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
      // The mounted dossier must show the worker's freshest snapshot the
      // moment its lifecycle changes (delivery, acceptance, failure).
      const workerId = event.payload?.id
      if (typeof workerId === 'string') {
        void qc.invalidateQueries({ queryKey: queryKeys.conductor.subagent(workerId) })
      }
    }
  })

  useEffect(() => {
    return () => {
      if (restoredScrollRef.current.chat) {
        scrollMemory.chatTop = chatScrollRef.current?.scrollTop ?? scrollMemory.chatTop
      }
    }
  }, [])

  useEffect(() => {
    const el = chatScrollRef.current
    if (restoredScrollRef.current.chat || !el || chatMessages.length === 0) return
    const frame = requestAnimationFrame(() => {
      const rememberedTop = scrollMemory.chatTop
      el.scrollTop = rememberedTop === null
        ? el.scrollHeight
        : Math.min(rememberedTop, el.scrollHeight)
      shouldFollowChatRef.current = isNearScrollBottom(el)
      restoredScrollRef.current.chat = true
    })
    return () => cancelAnimationFrame(frame)
  }, [chatMessages.length])

  // Auto-scroll only while the reader is already at the live edge.
  useEffect(() => {
    if (shouldFollowChatRef.current) {
      // Instant scrolling avoids a smooth-scroll/onScroll feedback loop that
      // could silently disable live following while messages stream in.
      chatEndRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [chatMessages])

  const workflows = workflowSnapshot?.items ?? []
  const currentWorkflow = useMemo(() => {
    if (pinnedRequestId) {
      const pinned = workflows.find((workflow) => workflow.request_id === pinnedRequestId)
      if (pinned) return pinned
    }
    const active = [...workflows].reverse().find((workflow) => (
      !WORKFLOW_STAGE_CLOSED.has(workflow.stage ?? '')
    ))
    return active ?? workflows.at(-1)
  }, [workflows, pinnedRequestId])
  // Conversation continuity (2026-09 UI audit): while the viewed workflow is
  // still open, the composer APPENDS to it (same request id) instead of
  // forking a new task — previously every message minted a fresh request id
  // and the "本轮对话" filter made the running task's thread vanish.
  const appendTargetRequestId = currentWorkflow
    && !WORKFLOW_STAGE_CLOSED.has(currentWorkflow.stage ?? '')
    ? currentWorkflow.request_id
    : null

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

  // Form submit handler: default target is the open workflow (append). The
  // composer's explicit 新任务 button submits with a null target instead.
  const sendChat = (e: FormEvent) => {
    e.preventDefault()
    void submitChat(appendTargetRequestId)
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
      toast.success('Conductor 已启动，可继续处理任务')
    } catch (err) {
      console.error('startConductor failed', err)
      // The backend sends actionable detail (bad llm index 422, engine
      // 502/503) — surface it instead of a fixed retry line.
      toast.error(errorMessageFromError(err, '启动 Conductor 失败，请稍后重试。'))
    } finally {
      setIsSending(false)
    }
  }

  const runSubagentAction = async (
    sid: string,
    action: 'accept' | 'rework' | 'abort',
    msg = '',
    force = false,
  ) => {
    setBusySid(sid)
    try {
      await api.conductorSubagentAction(sid, action, msg, null, {}, force)
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
      // that still needs one (review queue order, else the next in list).
      if (action !== 'abort') {
        const rest = workflowSubagents.filter((sub) => sub.id !== sid)
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
      setBusySid(null)
      await Promise.all([
        qc.invalidateQueries({ queryKey: queryKeys.conductor.subagents }),
        qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows }),
      ])
    }
  }

  useLayoutEffect(() => {
    const el = chatInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [userMsg])

  // One task title per request, oldest user message wins (the task origin).
  const taskTitleByRequest = useMemo(() => {
    const map = new Map<string, string>()
    for (const item of [...chatMessages].reverse()) {
      if (item.role === 'user' && item.request_id && !map.has(item.request_id)) {
        map.set(item.request_id, compactTaskText(item.msg))
      }
    }
    return map
  }, [chatMessages])

  const workflowHistory = useMemo(() => (
    [...workflows].reverse().map((workflow) => ({
      request_id: workflow.request_id,
      title: taskTitleByRequest.get(workflow.request_id) || '未命名任务',
      stage: workflow.stage ?? '',
      startedAt: workflow.created_at,
      presentation: workflowPresentation(workflow, status?.started ?? false),
    }))
  ), [workflows, taskTitleByRequest, status?.started])
  // Pinning the newest workflow is the same view as auto-following, so the
  // "回到最新" reset only matters when an older task is pinned.
  const viewingLatest = pinnedRequestId === null
    || pinnedRequestId === workflows.at(-1)?.request_id
  const backToLatest = () => setPinnedRequestId(null)
  const workflowSubagents = useMemo(() => {
    if (!currentWorkflow) return subagents.slice(-5).reverse()
    const workerIds = new Set(Object.keys(currentWorkflow.subagents))
    return subagents
      .filter((sub) => sub.request_id === currentWorkflow.request_id || workerIds.has(sub.id))
      .sort((left, right) => left.created_at - right.created_at)
  }, [currentWorkflow, subagents])
  const currentTask = useMemo(() => {
    if (!currentWorkflow) return ''
    const message = [...chatMessages].reverse().find((item) => (
      item.role === 'user' && item.request_id === currentWorkflow.request_id
    ))
    return message ? compactTaskText(message.msg) : '当前任务'
  }, [chatMessages, currentWorkflow])
  const visibleChat = useMemo(() => {
    if (!currentWorkflow) return chatMessages
    return chatMessages.filter((item) => item.request_id === currentWorkflow.request_id)
  }, [chatMessages, currentWorkflow])
  const workflowView = workflowPresentation(currentWorkflow, status?.started ?? false)
  const workflowOpen = currentWorkflow !== undefined
    && !WORKFLOW_STAGE_CLOSED.has(currentWorkflow.stage ?? '')
  // Ticks only while an open workflow is on screen; closed workflows show a
  // fixed created→completed duration and need no clock.
  const nowMs = useNowTick(workflowOpen ? 30_000 : null)
  const workflowDuration = (() => {
    if (!currentWorkflow) return ''
    const started = currentWorkflow.created_at
    if (!Number.isFinite(started) || started <= 0) return ''
    if (workflowOpen) {
      return `已进行 ${formatDurationSeconds(nowMs / 1000 - started)}`
    }
    const finished = currentWorkflow.completed_at
    if (typeof finished === 'number' && finished > started) {
      return `用时 ${formatDurationSeconds(finished - started)}`
    }
    return ''
  })()
  const acceptedCount = workflowSubagents.filter((sub) => sub.review_status === 'accepted').length
  const activeSubagents = workflowSubagents.filter((sub) => sub.status === 'running')
  const pendingReview = workflowSubagents.filter(isReviewable)
  const occupiedCount = subagents.filter((sub) => (
    sub.status === 'running'
    || (sub.status === 'stopped' && !['accepted', 'rejected'].includes(sub.review_status))
  )).length
  const selectedWorker = workflowSubagents.find((sub) => sub.id === selectedSid) ?? null

  // Retry entry for a failed workflow: prefill the composer with the task's
  // original wording so the user can adjust it and dispatch a fresh task.
  const retryCurrentWorkflow = () => {
    if (!currentWorkflow) return
    const origin = [...chatMessages].reverse().find((item) => (
      item.role === 'user' && item.request_id === currentWorkflow.request_id
    ))
    setUserMsg(origin ? origin.msg : currentTask)
    chatInputRef.current?.focus()
  }

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

  // Keyboard review shortcuts (2026-09 UI audit): j/k move between workers,
  // A accepts the selected worker, R opens its rework input. They stay off
  // while typing in any field or while the settings dialog is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (subagentSettingsOpen || reworkSid) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return
      if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'BUTTON')) return
      const key = event.key.toLowerCase()
      if (key !== 'j' && key !== 'k' && key !== 'a' && key !== 'r') return
      if (workflowSubagents.length === 0) return
      const index = workflowSubagents.findIndex((sub) => sub.id === selectedSid)
      if (key === 'j' || key === 'k') {
        event.preventDefault()
        const step = key === 'j' ? 1 : -1
        const nextIndex = index === -1
          ? (step === 1 ? 0 : workflowSubagents.length - 1)
          : (index + step + workflowSubagents.length) % workflowSubagents.length
        setSelectedSid(workflowSubagents[nextIndex]?.id ?? null)
        return
      }
      const selected = selectedWorker
      if (!selected || !isReviewable(selected)) return
      if (key === 'a') {
        event.preventDefault()
        void runSubagentAction(selected.id, 'accept')
      } else {
        event.preventDefault()
        setReworkSid(selected.id)
        setReworkReason('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [workflowSubagents, selectedSid, selectedWorker, subagentSettingsOpen, reworkSid, runSubagentAction])

  return (
    <PageShell
      title="Conductor"
      titleExtra={
        <span className={`ga-badge ${status?.started ? 'ga-badge-connected' : 'ga-badge-offline'}`}>
          {status?.started ? '运行中' : '未运行'}
        </span>
      }
      middleArea={
        <span className="text-xs text-ink-muted" aria-label="工人占用">
          {occupiedCount > 0 ? `工人占用 ${occupiedCount}` : '没有占用中的工人'}
        </span>
      }
      actions={
        <div className="flex h-9 items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-ink-muted">主模型</span>
          <MainModelSelect
            llms={llms}
            value={mainLlmKey}
            onChange={selectMainLlm}
            className="w-[240px] max-w-[32vw]"
            title="选择 Conductor 使用的主模型"
            aria-label="Conductor 主模型"
          />
          <button
            ref={subagentSettingsButtonRef}
            type="button"
            className="ga-btn"
            aria-haspopup="dialog"
            aria-expanded={subagentSettingsOpen}
            onClick={openSubagentSettings}
          >
            子代理设置
          </button>
          {status?.started ? (
            <button onClick={stopConductor} disabled={isStopping} className="ga-btn-danger">
              {isStopping ? '停止中…' : '停止'}
            </button>
          ) : (
            <button onClick={startConductor} disabled={isSending} className="ga-btn ga-btn-primary">
              {isSending ? '启动中…' : '启动 / 恢复'}
            </button>
          )}
        </div>
      }
    >
      <div className="flex h-full min-h-0 gap-3 p-4">
        {!leftCollapsed && (
        <div className="flex w-64 min-w-0 shrink-0 flex-col gap-3">
          <nav
            aria-label="任务历史"
            className={clsx('min-h-0 shrink-0 flex-col', historyOpen ? 'flex' : 'hidden')}
          >
            <div className="flex items-center justify-between px-1 pb-1">
              <button
                type="button"
                onClick={() => setHistoryOpen(!historyOpen)}
                aria-expanded={historyOpen}
                className="text-[11px] font-medium uppercase tracking-wide text-ink-muted hover:text-ink"
              >
                任务历史（{workflowHistory.length}）
              </button>
              {!viewingLatest && (
                <button
                  type="button"
                  onClick={backToLatest}
                  className="rounded px-1.5 py-0.5 text-[11px] text-status-info hover:bg-bg-soft"
                >
                  回到最新
                </button>
              )}
            </div>
            <div className="max-h-44 min-h-0 overflow-y-auto pr-0.5">
              <div className="flex flex-col gap-1">
                {workflowHistory.map((entry) => {
                  const isCurrent = entry.request_id === currentWorkflow?.request_id
                  const failed = entry.presentation.tone === 'error'
                  return (
                    <button
                      key={entry.request_id}
                      type="button"
                      onClick={() => setPinnedRequestId(entry.request_id)}
                      aria-current={isCurrent ? 'true' : undefined}
                      aria-label={`切换到任务：${entry.title}`}
                      className={clsx(
                        'flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition',
                        isCurrent
                          ? 'border-accent bg-accent-soft text-ink'
                          : 'border-line bg-bg-card text-ink-muted hover:border-line hover:text-ink',
                      )}
                    >
                      <span
                        className={clsx(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          failed
                            ? 'bg-status-danger'
                            : WORKFLOW_STAGE_CLOSED.has(entry.stage) ? 'bg-ink-faint' : 'bg-status-success-strong',
                        )}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                      <span className="shrink-0 text-[10px] text-ink-faint">{formatRelativeTime(entry.startedAt)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </nav>
          {workflowHistory.length > 0 && !historyOpen && (
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              aria-expanded={historyOpen}
              className="shrink-0 rounded-lg border border-line bg-bg-card px-2.5 py-1.5 text-left text-[11px] text-ink-muted hover:text-ink"
            >
              任务历史（{workflowHistory.length}）
            </button>
          )}
          <section aria-label="当前任务" className="shrink-0 rounded-2xl border border-line bg-bg-card px-3.5 py-3 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">当前任务</h2>
              <WorkflowBadge tone={workflowView.tone} label={workflowView.label} />
            </div>
            <p className="mt-1.5 line-clamp-2 text-sm font-medium leading-5 text-ink">
              {currentTask || '尚未收到任务'}
            </p>
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-ink-muted">{workflowView.detail}</p>
            <p className="mt-1.5 text-[11px] text-ink-muted" aria-label="子代理状态跟踪">
              {workflowSubagents.length === 0
                ? '尚未指派'
                : `${acceptedCount}/${workflowSubagents.length} 已通过${activeSubagents.length > 0 ? ` · ${activeSubagents.length} 执行中` : ''}`}
            </p>
            {workflowDuration && (
              <p className="mt-0.5 text-[11px] text-ink-faint" aria-label="任务耗时">{workflowDuration}</p>
            )}
            {workflowView.tone === 'error' && (
              <button
                type="button"
                className="mt-2 w-full rounded-lg border border-status-danger-line bg-status-danger-soft px-2.5 py-1.5 text-left text-xs text-status-danger-muted hover:border-status-danger/40"
                onClick={retryCurrentWorkflow}
              >
                重新发起这个任务（按原任务措辞重开）
              </button>
            )}
            {workflowSubagents.length > 0 && (
              <div
                className="mt-1.5 h-1 overflow-hidden rounded-full bg-bg-soft"
                role="progressbar"
                aria-label="验收进度"
                aria-valuenow={acceptedCount}
                aria-valuemax={workflowSubagents.length}
              >
                <div
                  className="h-full rounded-full bg-status-success-strong transition-[width] duration-500"
                  style={{ width: `${Math.round((acceptedCount / workflowSubagents.length) * 100)}%` }}
                />
              </div>
            )}
          </section>

          <ActivityTimeline requestId={currentWorkflow?.request_id ?? null} />

          {pendingReview.length > 0 && (
            <button
              type="button"
              className="shrink-0 rounded-xl border border-status-info-line bg-status-info-soft px-3 py-2 text-left text-xs leading-5 text-status-info"
              onClick={() => setSelectedSid(pendingReview[0].id)}
            >
              有 {pendingReview.length} 个子任务等你拍板
              {pendingReview[0] ? ` · 先看「${shortWorkerTitle(pendingReview[0])}」` : ''}
            </button>
          )}

          <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
            <div className="flex items-center justify-between gap-2 border-b border-line/70 px-3.5 py-2.5">
              <h2 className="text-sm font-semibold text-ink">工人</h2>
              {workflowSubagents.length > 0 && (
                <span className="text-[11px] text-ink-muted">{workflowSubagents.length} 项</span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto" aria-label="子任务详情">
              {workflowSubagents.length === 0 ? (
                <div className="px-4 py-8 text-center">
                  {/* Shared neutrals, sanctioned: #4E4233 (empty-state text) and
                       #8A7A63 (placeholder) repeat across this page on purpose. */}
                  <p className="text-sm font-medium text-[#4E4233]">
                    {currentWorkflow ? '尚未指派子代理' : '暂无执行中的任务'}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-ink-muted">
                    {currentWorkflow ? '完成任务拆分后在这里显示。' : '发送任务后可在这里查看进度。'}
                  </p>
                </div>
              ) : (
                workflowSubagents.map((sub) => (
                  <WorkerListRow
                    key={sub.id}
                    sub={sub}
                    selected={sub.id === selectedSid}
                    onSelect={() => setSelectedSid(sub.id)}
                  />
                ))
              )}
            </div>
          </section>
        </div>
        )}

        <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5">
            <h2 className="text-sm font-semibold text-ink">本轮对话</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLeftCollapsed(!leftCollapsed)}
                aria-pressed={leftCollapsed}
                aria-label={leftCollapsed ? '展开左侧栏' : '收起左侧栏'}
                title={leftCollapsed ? '展开左侧栏' : '收起左侧栏'}
                className="ga-btn px-2 py-1 text-xs"
              >
                {leftCollapsed ? '显示侧栏 ⇤' : '收起侧栏 ⇤'}
              </button>
              <button
                type="button"
                onClick={() => setDossierCollapsed(!dossierCollapsed)}
                aria-pressed={dossierCollapsed}
                aria-label={dossierCollapsed ? '展开详情面板' : '收起详情面板'}
                title={dossierCollapsed ? '展开详情面板' : '收起详情面板'}
                className="ga-btn px-2 py-1 text-xs"
              >
                {dossierCollapsed ? '显示详情 ⇥' : '收起详情 ⇥'}
              </button>
              <span className="text-[11px] text-ink-muted">只显示当前任务这一轮</span>
            </div>
          </div>
          <div
            ref={chatScrollRef}
            onScroll={() => {
              if (!isSending) {
                shouldFollowChatRef.current = isNearScrollBottom(chatScrollRef.current)
              }
              scrollMemory.chatTop = chatScrollRef.current?.scrollTop ?? scrollMemory.chatTop
            }}
            className="min-h-0 flex-1 overflow-y-auto divide-y divide-line text-sm"
          >
            {isChatLoading && visibleChat.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-ink-muted">正在加载 Conductor 历史…</div>
            )}
            {isChatError && visibleChat.length === 0 && (
              <div className="px-4 py-8 text-center">
                <p className="text-sm text-status-danger">历史暂时无法加载，Conductor 引擎可能未连接。</p>
                <button type="button" className="ga-btn mt-3" onClick={() => void refetchChat()}>重试</button>
              </div>
            )}
            {!isChatLoading && !isChatError && visibleChat.length === 0 && (
              workflows.length === 0 && chatMessages.length === 0 ? (
                <div className="px-6 py-10 text-center">
                  <p className="text-sm font-medium text-[#4E4233]">把一件事交给指挥</p>
                  <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-ink-muted">
                    描述目标即可：指挥会拆分子任务、派发工人并汇总结果。试试下面的例子，或直接输入你的任务。
                  </p>
                  <div className="mt-4 flex flex-col items-center gap-2">
                    {[
                      '整理下载目录里的 PDF 资料，按主题归档并生成索引',
                      '调研两个候选技术方案，输出对比结论与推荐',
                      '检查这个仓库里未使用的依赖并给出清理建议',
                    ].map((example) => (
                      <button
                        key={example}
                        type="button"
                        data-testid="conductor-example-task"
                        className="max-w-md rounded-lg border border-line bg-bg px-3 py-1.5 text-xs text-ink-muted hover:border-accent hover:text-ink"
                        onClick={() => {
                          setUserMsg(example)
                          chatInputRef.current?.focus()
                        }}
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="px-4 py-8 text-center text-sm text-ink-muted">这一轮还没有对话内容。</div>
              )
            )}
            {visibleChat.map((msg) => (
              msg.role === 'user' ? (
                <div key={msg.id} className="flex justify-end px-4 py-2">
                  <div className={clsx('max-w-[85%] rounded-lg px-3.5 py-2 text-sm leading-7 [overflow-wrap:anywhere]', bubbleTone('user').surfaceClass)}>
                    <MessageContent content={msg.msg} format="text" />
                  </div>
                </div>
              ) : (
                <div key={msg.id} className="flex gap-3 px-4 py-2">
                  <span className="w-10 shrink-0 select-none pt-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-muted">
                    指挥
                  </span>
                  <div className="min-w-0 flex-1 text-sm leading-6 text-ink">
                    <MessageContent content={msg.msg} format="markdown" markdownMode="plain" />
                  </div>
                </div>
              )
            ))}
            <div ref={chatEndRef} />
          </div>
          <form onSubmit={sendChat} className="border-t border-line bg-bg-soft/75 p-3">
            {appendTargetRequestId && (
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate text-xs text-ink-muted">
                  将补充给当前任务，不会另开新任务
                </span>
                <button
                  type="button"
                  onClick={() => void submitChat(null)}
                  disabled={!userMsg.trim() || effectiveLlmIndex === null || isSending}
                  className="ga-btn shrink-0 px-2.5 py-1 text-xs"
                  title="忽略当前任务，另开一个新任务"
                >
                  新任务
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                ref={chatInputRef}
                value={userMsg}
                onChange={(e) => setUserMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }}
                rows={1}
                wrap="soft"
                placeholder={appendTargetRequestId ? '将作为补充发送给当前任务…' : '描述一个新任务…'}
                className="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded border border-line bg-bg px-3 py-2 text-sm leading-6 text-ink placeholder:text-[#8A7A63] [overflow-wrap:anywhere] focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={!userMsg.trim() || effectiveLlmIndex === null || isSending}
                className="shrink-0 rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
              >
                {isSending ? '发送中…' : (appendTargetRequestId ? '发送补充' : '发送')}
              </button>
            </div>
          </form>
        </section>

        {!dossierCollapsed && (
        <aside className="flex w-[24rem] max-w-[42%] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
          {selectedWorker ? (
            <WorkerDossier
              sub={selectedWorker}
              control={{
                evidence: evidenceBySid[selectedWorker.id],
                busy: busySid === selectedWorker.id,
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
            <div className="flex flex-1 items-center justify-center px-6 text-center">
              <div>
                <p className="text-sm font-medium text-[#4E4233]">还没有选中的工人</p>
                <p className="mt-1 text-xs leading-5 text-ink-muted">派工后点左侧一项，这里会显示目标、交付物和完整结果。</p>
              </div>
            </div>
          )}
        </aside>
        )}
      </div>

      {subagentSettingsOpen && (
        <ModalOverlay
          onClose={closeSubagentSettings}
          panelRef={subagentSettingsDialogRef}
          labelledBy="subagent-settings-title"
          panelClassName="w-full max-w-md"
        >
            <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
              <h2 id="subagent-settings-title" className="text-base font-semibold text-ink">子代理设置</h2>
              <button
                type="button"
                onClick={closeSubagentSettings}
                className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-ink-muted hover:bg-bg-soft hover:text-ink"
                aria-label="关闭子代理设置"
                title="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-5 px-5 py-5">
              <label className="block text-sm font-medium text-ink">
                默认模型
                <SubagentModelSelect
                  llms={llms}
                  value={draftSubagentLlmKey}
                  onChange={(key) => {
                    setDraftSubagentLlmKey(key)
                    if (key === null) setDraftSubagentModelLocked(false)
                  }}
                  className="mt-2 w-full"
                  aria-label="子代理默认模型"
                  autoFocus
                />
              </label>
              <label
                className={clsx(
                  'flex items-center gap-2 text-sm text-[#4E4233]',
                  draftSubagentLlmKey === null && 'opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  checked={draftSubagentModelLocked}
                  disabled={draftSubagentLlmKey === null}
                  onChange={(event) => setDraftSubagentModelLocked(event.target.checked)}
                />
                固定使用所选模型
              </label>
              <div className="border-t border-line/70 pt-4">
                <label className="flex items-center gap-2 text-sm text-[#4E4233]">
                  <input
                    type="checkbox"
                    checked={draftAutoAccept}
                    onChange={(event) => setDraftAutoAccept(event.target.checked)}
                    aria-label="质检通过自动验收"
                  />
                  <span className="font-medium text-ink">质检通过自动验收</span>
                </label>
                <p className="mt-1 text-xs leading-5 text-ink-muted">
                  开启后，机器检查全部通过的工人自动放行，无需人工干预；只有检查不通过或执行异常的工人才会等你拍板。
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t border-line/70 px-5 py-4">
              <button type="button" className="ga-btn" onClick={closeSubagentSettings}>取消</button>
              <button type="button" className="ga-btn ga-btn-primary" onClick={saveSubagentSettings}>保存</button>
            </div>
        </ModalOverlay>
      )}
    </PageShell>
  )
}
