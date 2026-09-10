import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowUp, CheckCheck, FileCheck2, LayoutGrid, MessageSquare, Play, Plus, RotateCcw, Settings2, Square, X, Activity } from 'lucide-react'
import '@/styles/conductor.css'
import { api, type ConductorSubagentModelPolicy } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'
import { useConductorStore } from '@/stores/conductorStore'
import { dialog } from '@/stores/dialogStore'
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
  workflowPresentation,
  isWorkflowClosed,
  type SubagentEvidence,
} from '@/components/conductor/presentation'
import { WorkflowBadge } from '@/components/conductor/WorkflowBadge'
import { WorkerCard } from '@/components/conductor/WorkerCard'
import { TaskBoard } from '@/components/conductor/TaskBoard'
import { useConductorData } from '@/hooks/useConductorData'
import { WorkerDossier } from '@/components/conductor/WorkerDossier'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { useNowTick } from '@/hooks/useNowTick'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError, structuredErrorDetailFromError } from '@/utils/sessionUi'
import { formatDurationSeconds } from '@/utils/timeFormat'

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
  const [contextTab, setContextTab] = useState<'chat' | 'delivery' | 'activity'>('chat')
  const [mobileView, setMobileView] = useState<'board' | 'context'>('board')
  const actionInFlightRef = useRef(false)
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


  const { workflows, isChatLoading, isChatError, refetchChat } = useConductorData(() => {
    shouldFollowChatRef.current = isNearScrollBottom(chatScrollRef.current)
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

  useLayoutEffect(() => {
    const el = chatInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [userMsg])

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

  const workflowSubagents = useMemo(() => {
    // No workflow on screen → no worker cards. The earlier slice(-5) fallback
    // orphaned pool/archive workers under a "尚未收到任务" header, which reads
    // as a contradiction now that archived rows persist across engine resets.
    if (!currentWorkflow) return []
    const workerIds = new Set(Object.keys(currentWorkflow.subagents))
    return subagents
      .filter((sub) => sub.request_id === currentWorkflow.request_id || workerIds.has(sub.id))
      .sort((left, right) => left.created_at - right.created_at)
  }, [currentWorkflow, subagents])
  const currentTask = currentWorkflow ? taskTitleByRequest.get(currentWorkflow.request_id) || '当前任务' : ''
  const visibleChat = useMemo(() => {
    if (!currentWorkflow) return chatMessages
    return chatMessages.filter((item) => item.request_id === currentWorkflow.request_id)
  }, [chatMessages, currentWorkflow])
  const workflowView = workflowPresentation(currentWorkflow, status?.started ?? false)
  const workflowOpen = currentWorkflow !== undefined
    && !isWorkflowClosed(currentWorkflow)
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

  // In-place expansion: at most one subagent card shows its execution
  // process at a time; switching tasks collapses it.
  const [expandedSid, setExpandedSid] = useState<string | null>(null)
  useEffect(() => {
    setExpandedSid(null)
  }, [currentWorkflow?.request_id])
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set())
  const deleteWorkflow = async (requestId: string) => {
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
  }


  // Retry entry for a failed workflow: prefill the composer with the task's
  // original wording so the user can adjust it and dispatch a fresh task.
  const retryCurrentWorkflow = () => {
    if (!currentWorkflow) return
    const origin = chatMessages.find((item) => (
      item.role === 'user' && item.request_id === currentWorkflow.request_id
    ))
    setUserMsg(origin ? origin.msg : currentTask)
    setContextTab('chat')
    setMobileView('context')
    requestAnimationFrame(() => chatInputRef.current?.focus())
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
      if (subagentSettingsOpen || reworkSid || actionInFlightRef.current) return
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
      if (!selected || !isReviewable(selected) || selected.archived) return
      if (key === 'a') {
        event.preventDefault()
        void runSubagentAction(selected.id, 'accept')
      } else {
        event.preventDefault()
        setContextTab('delivery')
        setMobileView('context')
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
        <>
        <span className={`ga-badge ${status === undefined ? 'ga-badge-offline' : status.started ? 'ga-badge-connected' : 'ga-badge-offline'}`}>
          {status === undefined ? '连接中' : status.started ? '运行中' : '未运行'}
        </span>
        </>
      }
      actions={
        <div className="conductor-header-actions flex items-center gap-2">
          <span className="text-xs text-ink-muted">主模型</span>
          <MainModelSelect
            llms={llms}
            value={mainLlmKey}
            onChange={selectMainLlm}
            className="w-[210px] max-w-full"
            title="选择 Conductor 使用的主模型"
            aria-label="Conductor 主模型"
          />
          <button
            ref={subagentSettingsButtonRef}
            type="button"
            className="conductor-icon-button"
            title="子代理设置"
            aria-label="子代理设置"
            aria-haspopup="dialog"
            aria-expanded={subagentSettingsOpen}
            onClick={openSubagentSettings}
          >
            <Settings2 size={17} />
          </button>
          {status?.started ? (
            <button onClick={stopConductor} disabled={isStopping} className="ga-btn-danger whitespace-nowrap">
              <Square size={13} />{isStopping ? '停止中…' : '停止'}
            </button>
          ) : (
            <button onClick={startConductor} disabled={isSending} className="ga-btn ga-btn-primary inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"
              title="仅拉起监督者，不会自动重跑任何任务；要续跑某个暂停任务，用任务卡上的“恢复此任务”">
              <Play size={13} />{isSending ? '启动中…' : '启动'}
            </button>
          )}
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
          <main className="conductor-main">
            <TaskBoard workflows={workflows} workers={subagents} titles={taskTitleByRequest}
              selectedId={currentWorkflow?.request_id} started={status?.started ?? false}
              onSelect={id => { setPinnedRequestId(pinnedRequestId === id ? null : id); setSelectedSid(null) }}
              onDelete={(id) => void deleteWorkflow(id)}
              deletingIds={deletingIds} />
            <section aria-label="当前任务" className="conductor-current">
              <div className="conductor-current-title-row">
                <WorkflowBadge tone={workflowView.tone} label={workflowView.label} />
                <p className="conductor-current-title" title={currentTask || undefined}>{currentTask || '尚未收到任务'}</p>
                {/* The single most important next actions ride on the title
                    row itself, where the eye lands first — resume, pending
                    reviews, retry. Absent actions leave no residue. */}
                <span className="conductor-current-actions">
                  {!status?.started && currentWorkflow && !isWorkflowClosed(currentWorkflow) && (
                    <button type="button" className="ga-btn conductor-action-btn" disabled={isResuming}
                      title="只恢复这一个任务：拉起监督者并重放它的原始指令，其他未闭合任务不受影响"
                      onClick={() => void resumeCurrentWorkflow()}>
                      <RotateCcw size={14} />{isResuming ? '恢复中…' : '恢复此任务'}
                    </button>
                  )}
                  {pendingReview.length > 0 && (
                    <button type="button" className="ga-btn conductor-action-btn conductor-action-strong"
                      title="打开右侧交付详情进行验收"
                      onClick={() => { setSelectedSid(pendingReview[0].id); setContextTab('delivery'); setMobileView('context') }}>
                      <CheckCheck size={14} />{pendingReview.length} 个待验收
                    </button>
                  )}
                  {workflowView.tone === 'error' && (
                    <button type="button" className="ga-btn-danger conductor-action-btn" onClick={retryCurrentWorkflow}>
                      <RotateCcw size={14} />重新发起
                    </button>
                  )}
                </span>
              </div>
              <p className="conductor-current-detail">{workflowView.detail}</p>
              {currentWorkflow?.error && <p className="mt-2 text-xs text-status-danger [overflow-wrap:anywhere]">{currentWorkflow.error}</p>}
              {/* The task's live numbers, inlined as one muted strip instead
                  of a four-card grid: a handful of digits does not need a
                  card per digit. */}
              {currentWorkflow && (
                <p className="conductor-current-stats" aria-label="当前任务概览">
                  <span>子任务 {acceptedCount}/{workerCount}{workerCount === 0 && '（未指派）'}</span>
                  {activeSubagents.length > 0 && <span>执行中 {activeSubagents.length}</span>}
                  {pendingReview.length > 0 && <span className="is-attention">待验收 {pendingReview.length}</span>}
                  {workflowDuration && <span>用时 {workflowDuration}</span>}
                </p>
              )}
              <section className="conductor-process" aria-label="实施过程">
                <h3 className="conductor-process-title">实施过程 <span>· {workflowSubagents.length} 个子任务</span></h3>
                <div className="conductor-worker-grid" aria-label="子任务详情">
                {workflowSubagents.map((sub) => <WorkerCard key={sub.id} sub={sub} selected={sub.id === selectedSid}
                  expanded={sub.id === expandedSid}
                  onToggle={() => {
                    // One click is "open this worker": it selects the dossier
                    // AND brings the delivery tab forward, replacing the old
                    // redundant 打开完整卷宗 button. Collapsing leaves the
                    // right panel alone.
                    const willExpand = expandedSid !== sub.id
                    setSelectedSid(sub.id)
                    setExpandedSid(willExpand ? sub.id : null)
                    if (willExpand) {
                      setContextTab('delivery')
                      setMobileView('context')
                    }
                  }} />)}
                </div>
                {workflowSubagents.length === 0 && <div className="conductor-empty"><LayoutGrid size={26} strokeWidth={1.4} /><p>{currentWorkflow && workerCount
                  ? '子代理已从引擎池中清除，且未保留存档明细'
                  : '尚未指派子任务'}</p></div>}
              </section>
            </section>
          </main>
          <aside className="conductor-context" aria-label="任务详情">
            <div className="conductor-context-tabs" role="tablist" aria-label="任务内容">
              <button id="conductor-tab-chat" role="tab" aria-controls="conductor-panel-chat" aria-selected={contextTab === 'chat'} onClick={() => setContextTab('chat')}><MessageSquare size={14} />对话</button>
              <button id="conductor-tab-delivery" role="tab" aria-controls="conductor-panel-delivery" aria-selected={contextTab === 'delivery'} onClick={() => setContextTab('delivery')}><FileCheck2 size={14} />交付详情</button>
              <button id="conductor-tab-activity" role="tab" aria-controls="conductor-panel-activity" aria-selected={contextTab === 'activity'} onClick={() => setContextTab('activity')}><Activity size={14} />动态</button>
            </div>
            <section role="tabpanel" id="conductor-panel-chat" aria-labelledby="conductor-tab-chat" hidden={contextTab !== 'chat'} className="conductor-context-panel">
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
              <div className="conductor-empty"><MessageSquare size={28} strokeWidth={1.4} /><p>暂无对话</p></div>
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
                  当前任务
                </span>
                <button
                  type="button"
                  onClick={() => void submitChat(null)}
                  disabled={!userMsg.trim() || effectiveLlmIndex === null || isSending}
                  className="ga-btn shrink-0 px-2.5 py-1 text-xs"
                  title="忽略当前任务，另开一个新任务"
                >
                  <Plus size={13} />新任务
                </button>
              </div>
            )}
            <div className="flex items-end gap-2">
              <textarea
                aria-label="任务内容"
                ref={chatInputRef}
                value={userMsg}
                onChange={(e) => setUserMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  e.currentTarget.form?.requestSubmit()
                }}
                rows={3}
                wrap="soft"
                placeholder={appendTargetRequestId ? '将作为补充发送给当前任务…' : '描述一个新任务…'}
                className="min-h-24 max-h-60 min-w-0 flex-1 resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded border border-line bg-bg px-3 py-2 text-sm leading-6 text-ink placeholder:text-ink-faint [overflow-wrap:anywhere] focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={!userMsg.trim() || effectiveLlmIndex === null || isSending}
                aria-label={isSending ? '发送中' : (appendTargetRequestId ? '发送补充' : '发送')}
                title={appendTargetRequestId ? '发送补充' : '发送任务'}
                className="conductor-send-button"
              >
                <ArrowUp size={18} />
              </button>
            </div>
          </form>
            </section>
            <section role="tabpanel" id="conductor-panel-delivery" aria-labelledby="conductor-tab-delivery" hidden={contextTab !== 'delivery'} className="conductor-context-panel">
          {selectedWorker ? (
            <WorkerDossier
              sub={selectedWorker}
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
            <div className="conductor-empty"><FileCheck2 size={28} strokeWidth={1.4} /><p>暂无子任务交付</p></div>
          )}
            </section>
            <section role="tabpanel" id="conductor-panel-activity" aria-labelledby="conductor-tab-activity" hidden={contextTab !== 'activity'} className="conductor-context-panel">
              <ActivityTimeline requestId={currentWorkflow?.request_id ?? null} />
            </section>
          </aside>
        </div>
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
                <X size={18} />
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
