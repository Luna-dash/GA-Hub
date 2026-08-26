import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, type ConductorSubagentModelPolicy } from '@/api/client'
import { useConductorStore } from '@/stores/conductorStore'
import type {
  ConductorApprovalItem,
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
    return { phase: 'accepted', label: '已通过', detail: '结果已通过 Conductor 验收' }
  }
  if (sub.review_status === 'pending') {
    return { phase: 'reviewing', label: '正在验收', detail: '子代理已提交，Conductor 正在检查' }
  }
  return { phase: 'stopped', label: '已停止', detail: '这项任务当前没有继续执行' }
}

function workflowPresentation(
  workflow: ConductorWorkflow | undefined,
  workers: ConductorSubagent[],
): { label: string; detail: string; tone: 'active' | 'review' | 'done' | 'error' | 'idle' } {
  if (!workflow) {
    return { label: '等待任务', detail: '发送任务后，这里会显示分派和执行进度。', tone: 'idle' }
  }
  if (workflow.status === 'completed') {
    return { label: '已完成', detail: '所有子任务已通过验收，交付结果已发送。', tone: 'done' }
  }
  if (['failed', 'cancelled', 'killed'].includes(workflow.status)) {
    return { label: '执行失败', detail: '工作流未能完成，原因已写入左侧对话。', tone: 'error' }
  }
  const accepted = workers.filter((sub) => sub.review_status === 'accepted').length
  if (workers.length > 0 && accepted === workers.length) {
    return { label: '正在汇总', detail: '子任务均已通过，Conductor 正在整理最终交付。', tone: 'review' }
  }
  if (workflow.status === 'reworking' || workers.some((sub) => sub.status === 'running' && sub.attempt > 1)) {
    return { label: '返工中', detail: '未通过的部分已交回子代理继续处理。', tone: 'active' }
  }
  if (workflow.status === 'awaiting_review') {
    return { label: '正在验收', detail: '子代理已提交结果，Conductor 正在检查。', tone: 'review' }
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
  const approvals = useConductorStore((s) => s.approvals)

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
  })

  const { data: chatSnapshot } = useQuery({
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
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  const sendChat = async (e: FormEvent) => {
    e.preventDefault()
    if (!userMsg.trim() || effectiveLlmIndex === null) return
    const msg = userMsg.trim()
    setUserMsg('')

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
    } catch (err) {
      console.error('sendChat failed', err)
      setUserMsg(msg)  // restore on failure
    }
  }

  const stopConductor = async () => {
    await api.conductorStop()
    qc.invalidateQueries({ queryKey: queryKeys.conductor.status })
  }

  const removeApproval = useConductorStore((s) => s.removeApproval)

  useLayoutEffect(() => {
    const el = chatInputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [userMsg])

  const approveTask = async (item: ConductorApprovalItem) => {
    if (effectiveSubagentLlmIndex === null) return
    await api.conductorStartSubagent(
      item.prompt,
      effectiveSubagentLlmIndex,
      conductorModelSettings,
    )
    removeApproval(item.id)
    qc.invalidateQueries({ queryKey: queryKeys.conductor.subagents })
  }

  const rejectTask = (item: ConductorApprovalItem) => {
    removeApproval(item.id)
  }

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
  const workflowView = workflowPresentation(currentWorkflow, workflowSubagents)
  const acceptedCount = workflowSubagents.filter((sub) => sub.review_status === 'accepted').length
  const activeSubagents = workflowSubagents.filter((sub) => sub.status === 'running')

  return (
    <PageShell
      title="Conductor"
      titleExtra={
        <span className={`ga-badge ${status?.started ? 'ga-badge-connected' : 'ga-badge-offline'}`}>
          {status?.started ? '运行中' : '未运行'}
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
          <button onClick={stopConductor} disabled={!status?.started} className="ga-btn-danger">停止</button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 gap-6 p-6">
          {/* Main: Chat */}
          <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-line bg-bg-card shadow-sm overflow-hidden">
            <div
              ref={chatScrollRef}
              onScroll={() => {
                shouldFollowChatRef.current = isNearScrollBottom(chatScrollRef.current)
                scrollMemory.chatTop = chatScrollRef.current?.scrollTop ?? scrollMemory.chatTop
              }}
              className="flex-1 overflow-y-auto divide-y divide-line border-y border-line text-sm"
            >
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  className={clsx(
                    'flex gap-3 px-4 py-2',
                    msg.role === 'user'
                      ? 'bg-[#8A6438] text-[#FFF4DF]'
                      : 'bg-bg-card text-[#2C2418]'
                  )}
                >
                  <span
                    className={clsx(
                      'shrink-0 w-16 select-none text-xs font-medium uppercase tracking-wide pt-0.5',
                      msg.role === 'user' ? 'text-[#FFF4DF]/70' : 'text-[#665741]'
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
            <form onSubmit={sendChat} className="rounded-b-2xl border-t border-line bg-bg-soft/75 p-4 shadow-[0_-12px_36px_rgba(15,23,42,0.20)] backdrop-blur-xl">
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
                  placeholder="向 Conductor 发送消息..."
                  className="min-h-10 max-h-40 flex-1 min-w-0 resize-none overflow-y-auto overflow-x-hidden rounded border border-line bg-bg px-3 py-2 text-sm leading-6 text-[#2C2418] placeholder:text-[#8A7A63] focus:border-accent focus:outline-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                />
                <button
                  type="submit"
                  disabled={!userMsg.trim() || effectiveLlmIndex === null}
                  className="shrink-0 rounded bg-accent px-4 py-2 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
                >
                  发送
                </button>
              </div>
            </form>
          </div>

          {/* Right: subagent tracking + semantic workflow progress */}
          <div className="flex w-[22rem] max-w-[40%] shrink-0 flex-col gap-3 overflow-hidden">
            <section className="shrink-0 overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm" aria-live="polite" aria-label="子代理状态跟踪">
              <div className="flex items-center justify-between gap-3 border-b border-line/70 px-4 py-2.5">
                <h2 className="shrink-0 text-sm font-semibold text-[#2C2418]">子代理状态</h2>
                <span className="text-[11px] text-[#7B6D5A]">
                  {workflowSubagents.length === 0
                    ? '尚未指派'
                    : `${acceptedCount}/${workflowSubagents.length} 已通过${activeSubagents.length > 0 ? ` · ${activeSubagents.length} 执行中` : ''}`}
                </span>
              </div>
              {workflowSubagents.length === 0 ? (
                <div className="px-4 py-3 text-xs text-[#7B6D5A]">等待 Conductor 分派子任务</div>
              ) : (
                <div className="flex min-h-[3.75rem] divide-x divide-line/70 overflow-x-auto">
                  {workflowSubagents.map((sub, index) => (
                    <SubagentStatusCell key={sub.id} sub={sub} index={index} />
                  ))}
                </div>
              )}
            </section>

            <aside className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-line bg-bg-card shadow-sm">
            <div className="border-b border-line/70 px-4 py-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-[#2C2418]">任务进度</h2>
                <WorkflowBadge tone={workflowView.tone} label={workflowView.label} />
              </div>
              <p className="line-clamp-3 text-sm font-medium leading-5 text-[#2C2418]">
                {currentTask || '尚未收到任务'}
              </p>
              <p className="mt-1.5 text-xs leading-5 text-[#665741]">{workflowView.detail}</p>
            </div>

            <div className="flex-1 overflow-y-auto" aria-label="子任务详情">
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
                workflowSubagents.map((sub, index) => (
                  <SubagentProgressRow key={sub.id} sub={sub} index={index} />
                ))
              )}
            </div>
            </aside>
          </div>
          </div>

      {/* Approval floating cards */}
      {approvals.length > 0 && (
        <div className="fixed bottom-6 right-6 z-30 w-96 space-y-2">
          {approvals.map((item) => (
            <div key={item.id} className="rounded-lg border border-accent/45 bg-bg-card p-4 shadow-[0_6px_18px_rgba(45,34,22,0.16)]">
              <div className="mb-2 text-sm font-semibold text-[#2C2418]">待批准任务</div>
              <div className="mb-1 text-xs text-[#665741]">来源: {item.source}</div>
              <pre className="mb-3 max-h-32 overflow-y-auto rounded border border-line bg-bg-soft p-2 text-xs whitespace-pre-wrap text-[#2C2418]">
                {item.prompt}
              </pre>
              <div className="flex gap-2">
                <button
                  onClick={() => approveTask(item)}
                  disabled={effectiveSubagentLlmIndex === null}
                  className="flex-1 rounded bg-accent px-3 py-1.5 text-sm text-white hover:bg-accent/90 disabled:opacity-50"
                >
                  批准
                </button>
                <button
                  onClick={() => rejectTask(item)}
                  className="flex-1 rounded border border-line bg-bg-card/80 px-3 py-1.5 text-sm text-[#9E3328] hover:border-[#E1B5A9] hover:bg-[#FFF2EF]"
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

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

function SubagentStatusCell({
  sub,
  index,
}: {
  sub: ConductorSubagent
  index: number
}) {
  const view = subagentPhase(sub)

  return (
    <div className="min-w-[7rem] flex-1 px-3 py-2.5" title={compactTaskText(sub.prompt)}>
      <div className="truncate text-[11px] text-[#7B6D5A]">子代理 {index + 1}</div>
      <div
        className={clsx(
          'mt-1 flex items-center gap-1.5 text-xs font-medium',
          view.phase === 'running' && 'text-[#7A4F08]',
          view.phase === 'reworking' && 'text-[#9A5315]',
          view.phase === 'reviewing' && 'text-[#285A78]',
          view.phase === 'accepted' && 'text-[#2D6A3F]',
          view.phase === 'stopped' && 'text-[#7B6D5A]',
        )}
      >
        <span
          className={clsx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            view.phase === 'running' && 'bg-[#B47A16]',
            view.phase === 'reworking' && 'bg-[#C4681C]',
            view.phase === 'reviewing' && 'bg-[#3E7C9E]',
            view.phase === 'accepted' && 'bg-[#3C8A52]',
            view.phase === 'stopped' && 'bg-[#9A8E7D]',
          )}
        />
        <span className="truncate">{view.label}</span>
      </div>
    </div>
  )
}

function SubagentProgressRow({
  sub,
  index,
}: {
  sub: ConductorSubagent
  index: number
}) {
  const view = subagentPhase(sub)

  return (
    <div className="border-b border-line/70 px-4 py-3 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium text-[#7B6D5A]">子代理 {index + 1}</span>
        <span
          className={clsx(
            'flex shrink-0 items-center gap-1.5 text-[11px] font-medium',
            view.phase === 'running' && 'text-[#7A4F08]',
            view.phase === 'reworking' && 'text-[#9A5315]',
            view.phase === 'reviewing' && 'text-[#285A78]',
            view.phase === 'accepted' && 'text-[#2D6A3F]',
            view.phase === 'stopped' && 'text-[#7B6D5A]',
          )}
        >
          <span
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              view.phase === 'running' && 'bg-[#B47A16]',
              view.phase === 'reworking' && 'bg-[#C4681C]',
              view.phase === 'reviewing' && 'bg-[#3E7C9E]',
              view.phase === 'accepted' && 'bg-[#3C8A52]',
              view.phase === 'stopped' && 'bg-[#9A8E7D]',
            )}
          />
          {view.label}
        </span>
      </div>
      <p className="line-clamp-4 break-words text-sm leading-5 text-[#2C2418]">
        {compactTaskText(sub.prompt)}
      </p>
      <p className="mt-1.5 text-xs leading-5 text-[#7B6D5A]">
        {view.detail}{sub.attempt > 1 ? ` · 第 ${sub.attempt} 次处理` : ''}
      </p>
    </div>
  )
}
