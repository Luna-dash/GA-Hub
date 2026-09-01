import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, type ConductorSubagentModelPolicy } from '@/api/client'
import { useConductorStore } from '@/stores/conductorStore'
import type {
  ConductorSubagent,
  ConductorWorkflow,
} from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MarkdownView } from '@/components/MarkdownView'
import { MainModelSelect, SubagentModelSelect } from '@/components/ModelSelect'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { useHubEvent } from '@/hooks/useHubEvent'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import { toast } from '@/stores/toastStore'

const scrollMemory: { chatTop: number | null } = {
  chatTop: null,
}
const SUBAGENT_MODEL_LOCK_KEY = 'gahub.conductor.subagentModelLocked.v1'

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

function compactTaskText(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:#{1,6}|[-*])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) return '未提供任务说明'
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact
}

/** Engine verification payload from a 409 completion_unverified accept. */
type SubagentEvidence = {
  error?: string
  checks_ok?: boolean
  deliverables_missing?: string[]
  deliverables_stale?: string[]
  quality_checks?: {
    checks?: Array<{
      kind?: string
      path?: string
      passed?: boolean
      status?: string
      severity?: string
      detail?: string
    }>
    checks_ok?: boolean
  }
  verification?: { verified?: boolean }
  [key: string]: unknown
}

/** Snapshot fields the engine already sends; OpenAPI extra:allow. */
type SubagentManifest = {
  goal?: string
  done_when?: string
  deliverables?: Array<{ path?: string; desc?: string }>
}

type SubagentReviewFacts = ConductorSubagent & {
  deliverables_missing?: string[]
  deliverables_stale?: string[]
  done_marker?: boolean
  quality_checks?: SubagentEvidence['quality_checks']
  manifest?: SubagentManifest
  verification?: { verified?: boolean; done_marker?: boolean }
}

function reviewFacts(sub: ConductorSubagent): SubagentReviewFacts {
  return sub as SubagentReviewFacts
}

function basenamePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

function isReviewable(sub: ConductorSubagent): boolean {
  return sub.status === 'stopped' && !['accepted', 'rejected'].includes(sub.review_status)
}

function workerTitle(sub: ConductorSubagent): string {
  const facts = reviewFacts(sub)
  return compactTaskText(facts.manifest?.goal || sub.prompt)
}

/** FastAPI wraps dict details in {detail}; plain dicts pass through. */
function subagentActionErrorDetail(err: unknown): SubagentEvidence | null {
  const body = (err as { body?: { detail?: SubagentEvidence } } | null)?.body
  if (!body) return null
  return body.detail ?? (body as SubagentEvidence)
}

/** Actions the review row can offer; the page supplies the implementations. */
type SubagentRowControl = {
  evidence?: SubagentEvidence
  busy: boolean
  reworkOpen: boolean
  reworkReason: string
  onAccept: () => void
  onForceAccept: () => void
  onAbort: () => void
  onReworkOpen: () => void
  onReworkReasonChange: (value: string) => void
  onReworkCancel: () => void
  onReworkSubmit: () => void
  onEvidenceDismiss: () => void
}

type SubagentPhase = 'running' | 'reworking' | 'reviewing' | 'accepted' | 'stopped'

function subagentPhase(sub: ConductorSubagent): {
  phase: SubagentPhase
  label: string
  detail: string
} {
  if (sub.status === 'running' && sub.attempt > 1) {
    return { phase: 'reworking', label: '返工中', detail: '正在按验收意见重新处理' }
  }
  if (sub.status === 'running') {
    return { phase: 'running', label: '执行中', detail: '子代理正在处理这项任务' }
  }
  if (sub.review_status === 'accepted') {
    return { phase: 'accepted', label: '已通过', detail: '结果已通过验收' }
  }
  if (sub.review_status === 'pending') {
    return { phase: 'reviewing', label: '待你验收', detail: '工人已交活，请看右侧卷宗后决定通过或打回' }
  }
  return { phase: 'stopped', label: '已停止', detail: '这项任务当前没有继续执行' }
}

function workflowPresentation(
  workflow: ConductorWorkflow | undefined,
  workers: ConductorSubagent[],
  started = true,
): { label: string; detail: string; tone: 'active' | 'review' | 'done' | 'error' | 'idle' } {
  if (!workflow) {
    return { label: '等待任务', detail: '发送任务后，这里会显示分派和执行进度。', tone: 'idle' }
  }
  if (!started && !['completed', 'failed', 'cancelled', 'killed'].includes(workflow.status)) {
    return { label: '已暂停', detail: 'Conductor 已停止；点击“启动 / 恢复”后可继续处理。', tone: 'idle' }
  }
  if (workflow.status === 'completed') {
    return { label: '已完成', detail: '所有子任务已通过验收，交付结果已发送。', tone: 'done' }
  }
  if (['failed', 'cancelled', 'killed'].includes(workflow.status)) {
    // A worker failure is recoverable (rework or a fresh dispatch can still
    // finish the workflow); only terminal_event marks a closed workflow.
    if (workflow.status === 'failed' && !workflow.terminal_event) {
      return { label: '子代理失败', detail: '子代理处理失败，Conductor 正在决定返工或补派。', tone: 'active' }
    }
    // Surface the tracker-persisted reason directly: a page opened after the
    // failure never saw the live transition, so the reason must come from the
    // workflow snapshot itself.
    if (workflow.error) {
      return { label: '执行失败', detail: `失败原因：${workflow.error}`, tone: 'error' }
    }
    return { label: '执行失败', detail: '工作流未能完成，原因已写入本轮对话。', tone: 'error' }
  }
  const accepted = workers.filter((sub) => sub.review_status === 'accepted').length
  if (workers.length > 0 && accepted === workers.length) {
    return { label: '正在汇总', detail: '子任务均已通过，Conductor 正在整理最终交付。', tone: 'review' }
  }
  if (workflow.status === 'reworking' || workers.some((sub) => sub.status === 'running' && sub.attempt > 1)) {
    return { label: '返工中', detail: '未通过的部分已交回子代理继续处理。', tone: 'active' }
  }
  if (workflow.status === 'awaiting_review') {
    return { label: '待你验收', detail: '子代理已交活，请查看右侧卷宗后决定通过或打回。', tone: 'review' }
  }
  if (workflow.status === 'supervising') {
    return { label: '执行中', detail: 'Conductor 已完成分派，子代理正在处理。', tone: 'active' }
  }
  return { label: '正在规划', detail: 'Conductor 正在理解需求并准备分派。', tone: 'active' }
}

function isNearScrollBottom(el: HTMLDivElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 96
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
  const [draftSubagentLlmKey, setDraftSubagentLlmKey] = useState<string | null>(null)
  const [draftSubagentModelLocked, setDraftSubagentModelLocked] = useState(false)
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
    closeSubagentSettings()
  }

  useEffect(() => {
    if (!subagentSettingsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeSubagentSettings()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        subagentSettingsDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled])',
        ) ?? [],
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [subagentSettingsOpen])

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
      || (
        event.topic.startsWith('conductor:subagent_')
        && !event.topic.endsWith('_running')
      )
    ) {
      void qc.invalidateQueries({ queryKey: queryKeys.conductor.workflows })
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

  const sendChat = async (e: FormEvent) => {
    e.preventDefault()
    if (!userMsg.trim() || effectiveLlmIndex === null || isSending) return
    const msg = userMsg.trim()
    setUserMsg('')
    setIsSending(true)

    // Send and use returned item (with real id) for instant display.
    // The EventBus and snapshot bootstrap merge by id, so this stays unique.
    try {
      const item = await api.conductorSendChat(msg, 'user', conductorModelSettings)
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
      toast.success('Conductor 已启动，可继续处理任务')
    } catch (err) {
      console.error('startConductor failed', err)
      toast.error('启动 Conductor 失败，请稍后重试。')
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
    } catch (err) {
      const detail = subagentActionErrorDetail(err)
      if (action === 'accept' && detail?.error === 'completion_unverified') {
        setEvidenceBySid((prev) => ({ ...prev, [sid]: detail }))
        toast.error('机器验收未通过，已展示证据；可人工核对后强制通过。')
      } else {
        console.error('subagent action failed', action, sid, err)
        toast.error(detail?.error || '操作失败，请稍后重试。')
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

  const workflows = workflowSnapshot?.items ?? []
  const currentWorkflow = useMemo(() => {
    const active = [...workflows].reverse().find((workflow) => (
      !['completed', 'failed', 'cancelled', 'killed'].includes(workflow.status)
    ))
    return active ?? workflows.at(-1)
  }, [workflows])
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
  const workflowView = workflowPresentation(currentWorkflow, workflowSubagents, status?.started ?? false)
  const acceptedCount = workflowSubagents.filter((sub) => sub.review_status === 'accepted').length
  const activeSubagents = workflowSubagents.filter((sub) => sub.status === 'running')
  const pendingReview = workflowSubagents.filter(isReviewable)
  const occupiedCount = subagents.filter((sub) => (
    sub.status === 'running'
    || (sub.status === 'stopped' && !['accepted', 'rejected'].includes(sub.review_status))
  )).length
  const selectedWorker = workflowSubagents.find((sub) => sub.id === selectedSid) ?? null

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

  return (
    <PageShell
      title="Conductor"
      titleExtra={
        <span className={`ga-badge ${status?.started ? 'ga-badge-connected' : 'ga-badge-offline'}`}>
          {status?.started ? '运行中' : '未运行'}
        </span>
      }
      middleArea={
        <span className="text-xs text-[#7B6D5A]" aria-label="工人占用">
          {occupiedCount > 0 ? `工人占用 ${occupiedCount}` : '没有占用中的工人'}
        </span>
      }
      actions={
        <div className="flex h-9 items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-[#7B6D5A]">主模型</span>
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
      <div className="flex h-full min-h-0 flex-col gap-3 p-4">
        {pendingReview.length > 0 && (
          <button
            type="button"
            className="shrink-0 rounded-xl border border-[#D7E4EE] bg-[#EAF2F8] px-4 py-2 text-left text-sm text-[#285A78]"
            onClick={() => setSelectedSid(pendingReview[0].id)}
          >
            有 {pendingReview.length} 个子任务等你拍板
            {pendingReview[0] ? ` · 先看「${workerTitle(pendingReview[0])}」` : ''}
          </button>
        )}

        <div className="flex min-h-0 flex-1 gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden">
            <section className="shrink-0 rounded-2xl border border-line bg-bg-card px-4 py-3 shadow-sm" aria-label="当前任务">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-[#2C2418]">当前任务</h2>
                <WorkflowBadge tone={workflowView.tone} label={workflowView.label} />
              </div>
              <p className="line-clamp-3 text-sm font-medium leading-5 text-[#2C2418]">
                {currentTask || '尚未收到任务'}
              </p>
              <p className="mt-1.5 text-xs leading-5 text-[#665741]">{workflowView.detail}</p>
              <p className="mt-1 text-[11px] text-[#7B6D5A]" aria-label="子代理状态跟踪">
                {workflowSubagents.length === 0
                  ? '尚未指派'
                  : `${acceptedCount}/${workflowSubagents.length} 已通过${activeSubagents.length > 0 ? ` · ${activeSubagents.length} 执行中` : ''}`}
              </p>
            </section>

            <section className="flex min-h-0 flex-[1.1] flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-[#2C2418]">工人</h2>
                <span className="text-[11px] text-[#7B6D5A]">点一项看右侧卷宗</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto" aria-label="子任务详情">
                {workflowSubagents.length === 0 ? (
                  <div className="px-5 py-10 text-center">
                    <p className="text-sm font-medium text-[#4E4233]">
                      {currentWorkflow ? '尚未指派子代理' : '暂无执行中的任务'}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#7B6D5A]">
                      {currentWorkflow ? 'Conductor 完成任务拆分后会在这里显示。' : '发送任务后可在这里查看具体进度。'}
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

            <section className="flex min-h-0 flex-[0.9] flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
              <div className="border-b border-line/70 px-4 py-2.5">
                <h2 className="text-sm font-semibold text-[#2C2418]">本轮对话</h2>
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
                  <div className="px-4 py-8 text-center text-sm text-[#7B6D5A]">正在加载 Conductor 历史…</div>
                )}
                {isChatError && visibleChat.length === 0 && (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm text-[#9E3328]">历史暂时无法加载，Conductor 引擎可能未连接。</p>
                    <button type="button" className="ga-btn mt-3" onClick={() => void refetchChat()}>重试</button>
                  </div>
                )}
                {!isChatLoading && !isChatError && visibleChat.length === 0 && (
                  <div className="px-4 py-8 text-center text-sm text-[#7B6D5A]">还没有任务，先向指挥描述你要完成的工作。</div>
                )}
                {visibleChat.map((msg) => (
                  <div
                    key={msg.id}
                    className={clsx(
                      'flex gap-3 px-4 py-2',
                      msg.role === 'user'
                        ? 'bg-[#8A6438] text-[#FFF4DF]'
                        : 'bg-bg-card text-[#2C2418]',
                    )}
                  >
                    <span
                      className={clsx(
                        'w-16 shrink-0 select-none pt-0.5 text-xs font-medium uppercase tracking-wide',
                        msg.role === 'user' ? 'text-[#FFF4DF]/70' : 'text-[#665741]',
                      )}
                    >
                      {msg.role === 'user' ? '' : '指挥'}
                    </span>
                    <MarkdownView mode="plain" cache>
                      {msg.msg}
                    </MarkdownView>
                  </div>
                ))}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={sendChat} className="border-t border-line bg-bg-soft/75 p-3">
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
                    placeholder="向指挥补充一句，或开一个新任务…"
                    className="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded border border-line bg-bg px-3 py-2 text-sm leading-6 text-[#2C2418] placeholder:text-[#8A7A63] [overflow-wrap:anywhere] focus:border-accent focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={!userMsg.trim() || effectiveLlmIndex === null || isSending}
                    className="shrink-0 rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
                  >
                    {isSending ? '发送中…' : '发送'}
                  </button>
                </div>
              </form>
            </section>
          </div>

          <aside className="flex w-[28rem] max-w-[46%] shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
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
                  <p className="mt-1 text-xs leading-5 text-[#7B6D5A]">派工后点左侧一项，这里会显示目标、交付物和完整结果。</p>
                </div>
              </div>
            )}
          </aside>
        </div>
      </div>

      {subagentSettingsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeSubagentSettings()
          }}
        >
          <div
            ref={subagentSettingsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="subagent-settings-title"
            className="w-full max-w-md rounded-xl border border-line bg-bg-card shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
              <h2 id="subagent-settings-title" className="text-base font-semibold text-[#2C2418]">子代理设置</h2>
              <button
                type="button"
                onClick={closeSubagentSettings}
                className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-[#7B6D5A] hover:bg-bg-soft hover:text-[#2C2418]"
                aria-label="关闭子代理设置"
                title="关闭"
              >
                ×
              </button>
            </div>
            <div className="space-y-5 px-5 py-5">
              <label className="block text-sm font-medium text-[#2C2418]">
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
            </div>
            <div className="flex justify-end gap-2 border-t border-line/70 px-5 py-4">
              <button type="button" className="ga-btn" onClick={closeSubagentSettings}>取消</button>
              <button type="button" className="ga-btn ga-btn-primary" onClick={saveSubagentSettings}>保存</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}

function WorkflowBadge({
  tone,
  label,
}: {
  tone: 'active' | 'review' | 'done' | 'error' | 'idle'
  label: string
}) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded px-2 py-0.5 text-[11px] font-medium',
        tone === 'active' && 'bg-[#FFF3D8] text-[#7A4F08]',
        tone === 'review' && 'bg-[#EAF2F8] text-[#285A78]',
        tone === 'done' && 'bg-[#E8F4EA] text-[#2D6A3F]',
        tone === 'error' && 'bg-[#FFF0ED] text-[#9E3328]',
        tone === 'idle' && 'bg-bg-soft text-[#7B6D5A]',
      )}
    >
      {label}
    </span>
  )
}

function phaseTone(phase: SubagentPhase): string {
  return clsx(
    phase === 'running' && 'text-[#7A4F08]',
    phase === 'reworking' && 'text-[#9A5315]',
    phase === 'reviewing' && 'text-[#285A78]',
    phase === 'accepted' && 'text-[#2D6A3F]',
    phase === 'stopped' && 'text-[#7B6D5A]',
  )
}

function phaseDot(phase: SubagentPhase): string {
  return clsx(
    'h-1.5 w-1.5 shrink-0 rounded-full',
    phase === 'running' && 'bg-[#B47A16]',
    phase === 'reworking' && 'bg-[#C4681C]',
    phase === 'reviewing' && 'bg-[#3E7C9E]',
    phase === 'accepted' && 'bg-[#3C8A52]',
    phase === 'stopped' && 'bg-[#9A8E7D]',
  )
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path)
    toast.success('已复制路径')
  } catch {
    toast.error('复制失败，请手动选中路径')
  }
}

function WorkerListRow({
  sub,
  selected,
  onSelect,
}: {
  sub: ConductorSubagent
  selected: boolean
  onSelect: () => void
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const missing = facts.deliverables_missing?.length ?? 0
  const stale = facts.deliverables_stale?.length ?? 0
  const failed = (facts.quality_checks?.checks ?? []).filter((check) => check.passed === false).length

  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'block w-full border-b border-line/70 px-4 py-3 text-left last:border-b-0',
        selected ? 'bg-[#F4EDE3]' : 'hover:bg-bg-soft',
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 flex-1 truncate text-sm font-medium text-[#2C2418]">{workerTitle(sub)}</p>
        <span className={clsx('flex shrink-0 items-center gap-1.5 text-[11px] font-medium', phaseTone(view.phase))}>
          <span className={phaseDot(view.phase)} />
          {view.label}
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-[#7B6D5A]">
        {sub.attempt > 1 ? `第 ${sub.attempt} 次` : view.detail}
        {missing > 0 ? ` · ${missing} 项缺失` : ''}
        {stale > 0 ? ` · ${stale} 项未更新` : ''}
        {failed > 0 ? ` · ${failed} 项检查失败` : ''}
      </p>
    </button>
  )
}

function WorkerDossier({
  sub,
  control,
}: {
  sub: ConductorSubagent
  control: SubagentRowControl
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.conductor.subagent(sub.id),
    queryFn: () => api.conductorSubagent(sub.id, 20_000),
  })
  const detail = reviewFacts(data ?? sub)
  const deliverables = detail.manifest?.deliverables ?? facts.manifest?.deliverables ?? []
  const missing = new Set(detail.deliverables_missing ?? facts.deliverables_missing ?? [])
  const stale = new Set(detail.deliverables_stale ?? facts.deliverables_stale ?? [])
  const checks = detail.quality_checks?.checks ?? facts.quality_checks?.checks ?? []
  const reply = (detail.reply || sub.reply || '').trim()
  const reviewable = isReviewable(sub)
  const abortable = sub.status === 'running' || reviewable

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line/70 px-4 py-3">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[#2C2418]">工人卷宗</h2>
          <span className={clsx('flex items-center gap-1.5 text-[11px] font-medium', phaseTone(view.phase))}>
            <span className={phaseDot(view.phase)} />
            {view.label}
          </span>
        </div>
        <p className="text-sm font-medium leading-5 text-[#2C2418]">{workerTitle(sub)}</p>
        <p className="mt-1 text-xs leading-5 text-[#7B6D5A]">
          {view.detail}{sub.attempt > 1 ? ` · 第 ${sub.attempt} 次处理` : ''}
          {detail.done_marker === false && sub.status === 'stopped' ? ' · 未确认完成' : ''}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-6 text-[#2C2418]">
        {isLoading && <p className="mb-3 text-xs text-[#7B6D5A]">正在拉取完整回复…</p>}
        {error && <p className="mb-3 text-xs text-[#9E3328]">完整结果暂时拉不到，先显示列表里已有的摘要。</p>}

        {detail.manifest?.done_when && (
          <section className="mb-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-[#7B6D5A]">完成条件</h3>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5">{detail.manifest.done_when}</p>
          </section>
        )}

        {deliverables.length > 0 && (
          <section className="mb-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-[#7B6D5A]">约定交付物</h3>
            <ul className="mt-1 space-y-1 text-xs" aria-label="约定交付物">
              {deliverables.map((item, index) => {
                const path = item.path || `交付物 ${index + 1}`
                const gone = missing.has(path)
                const untouched = stale.has(path)
                return (
                  <li key={path} className={clsx('break-all', gone && 'text-[#9E3328]', untouched && !gone && 'text-[#9A5315]')}>
                    {gone ? '✗ 缺失' : untouched ? '△ 未更新' : '✓'} {path}
                    {item.desc ? ` · ${item.desc}` : ''}
                    {item.path && (
                      <button
                        type="button"
                        className="ml-2 text-[11px] text-[#285A78] underline-offset-2 hover:underline"
                        onClick={() => void copyPath(item.path!)}
                      >
                        复制路径
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {checks.length > 0 && (
          <section className="mb-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-[#7B6D5A]">机器检查</h3>
            <ul className="mt-1 space-y-1 text-xs" aria-label="机器检查">
              {checks.map((check, index) => (
                <li key={`${check.kind}-${index}`} className={check.passed === false ? 'text-[#9E3328]' : ''}>
                  {check.passed === false ? '✗' : '✓'} {check.kind}
                  {check.path ? ` · ${basenamePath(check.path)}` : ''}
                  {check.detail ? ` — ${check.detail}` : ''}
                  {check.severity === 'advisory' ? '（提示项）' : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-[#7B6D5A]">
            {sub.status === 'running' ? '进行中摘要' : '文字结果'}
          </h3>
          {reply ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{reply}</div>
          ) : (
            <p className="mt-1 text-xs text-[#7B6D5A]">
              {sub.status === 'running'
                ? '还没有可展示的中间结果。'
                : '没有文字结果。请对照上面的交付物路径直接打开文件核对。'}
            </p>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-line/70 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          {reviewable && !control.reworkOpen && (
            <>
              <button
                type="button"
                className="ga-btn ga-btn-primary px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onAccept}
              >
                通过
              </button>
              <button
                type="button"
                className="ga-btn px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onReworkOpen}
              >
                打回返工
              </button>
            </>
          )}
          {abortable && (
            <button
              type="button"
              className="ga-btn px-3 py-1 text-xs text-[#9E3328]"
              disabled={control.busy}
              onClick={control.onAbort}
            >
              终止
            </button>
          )}
          {control.busy && <span className="text-xs text-[#7B6D5A]">处理中…</span>}
        </div>
        {control.reworkOpen && (
          <div className="mt-2 rounded-lg border border-line bg-bg-soft px-3 py-2">
            <textarea
              aria-label="打回原因"
              value={control.reworkReason}
              placeholder="说明打回原因与整改要求（必填）"
              className="min-h-16 w-full resize-none rounded border border-line bg-bg px-2 py-1.5 text-xs leading-5 text-[#2C2418] placeholder:text-[#8A7A63] focus:border-accent focus:outline-none"
              onChange={(event) => control.onReworkReasonChange(event.target.value)}
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" className="ga-btn px-3 py-1 text-xs" onClick={control.onReworkCancel}>取消</button>
              <button
                type="button"
                className="ga-btn ga-btn-primary px-3 py-1 text-xs"
                disabled={!control.reworkReason.trim() || control.busy}
                onClick={control.onReworkSubmit}
              >
                确认打回
              </button>
            </div>
          </div>
        )}
        {control.evidence && (
          <div
            role="alert"
            data-testid={`subagent-evidence-${sub.id}`}
            className="mt-2 rounded-lg border border-[#E8CFC7] bg-[#FFF7F5] px-3 py-2 text-xs leading-5 text-[#6B3A30]"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-[#9E3328]">机器验收未通过 · 证据</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-[#7B6D5A] hover:bg-bg-soft"
                onClick={control.onEvidenceDismiss}
              >
                收起
              </button>
            </div>
            <ul className="mt-1 space-y-0.5">
              {(control.evidence.deliverables_missing ?? []).map((path) => (
                <li key={`missing-${path}`}>✗ 交付物缺失：{path}</li>
              ))}
              {(control.evidence.deliverables_stale ?? []).map((path) => (
                <li key={`stale-${path}`}>✗ 交付物未更新：{path}</li>
              ))}
              {(control.evidence.quality_checks?.checks ?? [])
                .filter((check) => check.passed === false)
                .map((check, checkIndex) => (
                  <li key={`check-${checkIndex}`}>
                    ✗ {check.kind}{check.path ? ` · ${check.path}` : ''}
                    {check.detail ? ` — ${check.detail}` : ''}
                    {check.severity === 'advisory' ? '（提示项，不阻塞）' : ''}
                  </li>
                ))}
            </ul>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <button
                type="button"
                className="ga-btn px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onForceAccept}
              >
                强制通过（人工核对后）
              </button>
              <button
                type="button"
                className="ga-btn px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onReworkOpen}
              >
                打回返工
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
