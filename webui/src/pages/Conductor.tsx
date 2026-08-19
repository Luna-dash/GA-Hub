import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, type ConductorSubagentModelPolicy } from '@/api/client'
import { useConductorStore } from '@/stores/conductorStore'
import type { ConductorApprovalItem, ConductorLogItem, ConductorSubagent } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MarkdownView } from '@/components/MarkdownView'
import { MainModelSelect, SubagentModelSelect } from '@/components/ModelSelect'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { useHubEvent } from '@/hooks/useHubEvent'
import { queryKeys } from '@/queries/queryKeys'

const TECHNICAL_ACTION_RE = /^\s*\[Action\]\s+Running\s+([^:\n]+)(?:\s+in\s+([^:\n]+))?/i
const LLM_RUNNING_RE = /\*{0,2}LLM Running \(Turn \d+\) \.{3}\*{0,2}/gi
const scrollMemory = { chatTop: 0, logTop: 0 }
const SUBAGENT_MODEL_LOCK_KEY = 'gahub.conductor.subagentModelLocked.v1'

function readSubagentModelLock(): boolean {
  try {
    return localStorage.getItem(SUBAGENT_MODEL_LOCK_KEY) === 'true'
  } catch {
    return false
  }
}

function agentTooltip(sub: ConductorSubagent, index: number): string {
  const status = sub.status === 'running' ? '运行中' : '已停止'
  const prompt = sub.prompt?.trim() || '暂无任务内容'
  return `子代理 ${index + 1} · ${status}\n${prompt}`
}

function normalizeLogText(text: string): string {
  return text
    .replace(/<\/?summary>/gi, '')
    .replace(LLM_RUNNING_RE, '')
    .replace(/\[Stdout\][\s\S]*$/i, '')
    .replace(/^\s*(?:system|assistant|user)\s*[:：]\s*/gim, '')
    .replace(/\r?\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarizeTechnicalLog(text: string): string | null {
  const action = text.match(TECHNICAL_ACTION_RE)
  if (!action) return null
  const tool = action[1]?.trim()
  const location = action[2]?.trim()
  if (tool?.toLowerCase().includes('python')) {
    return location ? `执行本地脚本检查（${location}）` : '执行本地脚本检查'
  }
  return tool ? `执行${tool}检查` : '执行技术检查'
}

function logFingerprint(item: Pick<ConductorLogItem, 'event' | 'text'>): string {
  const text = normalizeLogText(item.text)
    .replace(/^已注入\s*/i, '')
    .replace(/^Conductor\s*编排思考\s*/i, '')
    .replace(/任务|布局|反馈|要求/g, '')
    .replace(/[\s，。,.：:；;（）()【】\[\]_*`"'“”]+/g, '')
    .slice(0, 80)
  return text
}

function isUsefulLogItem(item: ConductorLogItem): boolean {
  const text = normalizeLogText(item.text)
  if (!text) return false

  const event = item.event || ''
  const usefulEvents = ['user_msg', 'subagent_done', 'approval', 'chat']
  if (usefulEvents.some((key) => event.includes(key))) return true

  if (summarizeTechnicalLog(item.text)) return true
  return text.length >= 60 && !/^(ok|done|收到|已处理|wake)$/i.test(text)
}

function logEventLabel(event: string): string {
  if (event.includes('user_msg')) return '用户需求'
  if (event.includes('subagent_done')) return '子代理交付'
  if (event.includes('approval')) return '等待审批'
  if (event.includes('chat')) return 'Conductor 回复'
  return '编排摘要'
}

function cleanLogText(text: string): string {
  return summarizeTechnicalLog(text) || normalizeLogText(text)
}

function isNearScrollBottom(el: HTMLDivElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 96
}

function isNearScrollTop(el: HTMLDivElement | null): boolean {
  if (!el) return true
  return el.scrollTop < 96
}

export default function Conductor() {
  const qc = useQueryClient()
  const [userMsg, setUserMsg] = useState('')
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null)
  const [subagentModelLocked, setSubagentModelLocked] = useState(readSubagentModelLock)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatScrollRef = useRef<HTMLDivElement>(null)
  const logScrollRef = useRef<HTMLDivElement>(null)
  const chatInputRef = useRef<HTMLTextAreaElement>(null)
  const shouldFollowChatRef = useRef(false)
  const shouldFollowLogRef = useRef(scrollMemory.logTop < 96)
  const restoredScrollRef = useRef({ chat: false, log: false })

  // Extract store actions (stable references) to avoid socket churn
  const addChatMessage = useConductorStore((s) => s.addChatMessage)
  const hydrateSubagents = useConductorStore((s) => s.hydrateSubagents)
  const hydrateChatMessages = useConductorStore((s) => s.hydrateChatMessages)
  const hydrateLogItems = useConductorStore((s) => s.hydrateLogItems)
  const chatMessages = useConductorStore((s) => s.chatMessages)
  const subagents = useConductorStore((s) => s.subagents)
  const log = useConductorStore((s) => s.log)
  const approvals = useConductorStore((s) => s.approvals)
  const visibleLog = useMemo(() => {
    const seen = new Set<string>()
    return [...log]
      .reverse()
      .filter(isUsefulLogItem)
      .map((item) => ({ ...item, text: cleanLogText(item.text) }))
      .filter((item) => {
        const fingerprint = logFingerprint(item)
        if (!fingerprint || seen.has(fingerprint)) return false
        seen.add(fingerprint)
        return true
      })
  }, [log])

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

  const { data: chatSnapshot } = useQuery({
    queryKey: queryKeys.conductor.chat,
    queryFn: async () => {
      const generation = useConductorStore.getState().generation
      return { items: (await api.conductorChat(200)).items, generation }
    },
    refetchOnMount: 'always',
  })

  const { data: logSnapshot } = useQuery({
    queryKey: queryKeys.conductor.log,
    queryFn: async () => {
      const generation = useConductorStore.getState().generation
      return { items: (await api.conductorLog()).log, generation }
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

  useEffect(() => {
    if (logSnapshot) hydrateLogItems(logSnapshot.items, logSnapshot.generation)
  }, [hydrateLogItems, logSnapshot])

  useHubEvent('conductor:', (event) => {
    if (event.topic === 'conductor:chat' && event.payload.item) {
      shouldFollowChatRef.current = isNearScrollBottom(chatScrollRef.current)
    }
    if (event.topic === 'conductor:log' && event.payload.item) {
      shouldFollowLogRef.current = isNearScrollTop(logScrollRef.current)
    }
  })

  useEffect(() => {
    return () => {
      scrollMemory.chatTop = chatScrollRef.current?.scrollTop ?? scrollMemory.chatTop
      scrollMemory.logTop = logScrollRef.current?.scrollTop ?? scrollMemory.logTop
    }
  }, [])

  useEffect(() => {
    const el = chatScrollRef.current
    if (restoredScrollRef.current.chat || !el) return
    requestAnimationFrame(() => {
      el.scrollTop = Math.min(scrollMemory.chatTop, el.scrollHeight)
      restoredScrollRef.current.chat = true
    })
  }, [chatMessages.length])

  useEffect(() => {
    const el = logScrollRef.current
    if (restoredScrollRef.current.log || !el) return
    requestAnimationFrame(() => {
      el.scrollTop = Math.min(scrollMemory.logTop, el.scrollHeight)
      shouldFollowLogRef.current = isNearScrollTop(el)
      restoredScrollRef.current.log = true
    })
  }, [visibleLog.length])

  // Auto-scroll only while the reader is already at the live edge.
  useEffect(() => {
    if (shouldFollowChatRef.current) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [chatMessages])

  useEffect(() => {
    if (shouldFollowLogRef.current) {
      logScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [visibleLog])

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
      })
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

  const selectedDetail = selectedSubagent
    ? subagents.find((s) => s.id === selectedSubagent)
    : null
  const activeSubagents = useMemo(
    () => subagents.filter((sub) => sub.status === 'running'),
    [subagents]
  )
  const recentSubagents = useMemo(
    () => subagents.filter((sub) => sub.status !== 'running').slice(-4),
    [subagents]
  )
  const visibleSubagents = useMemo(
    () => [...activeSubagents, ...recentSubagents],
    [activeSubagents, recentSubagents]
  )

  useEffect(() => {
    if (selectedSubagent && !visibleSubagents.some((sub) => sub.id === selectedSubagent)) {
      setSelectedSubagent(null)
    }
  }, [selectedSubagent, visibleSubagents])

  const conductorStateLabel = status?.started ? '运行中' : '未运行'

  return (
    <PageShell
      title="Conductor"
      titleExtra={
        <span className={clsx('ga-badge', status?.started ? 'ga-badge-connected' : 'ga-badge-offline')}>
          {status?.started ? '运行中' : '未运行'}
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#7B6D5A]">主模型</span>
          <MainModelSelect
            llms={llms}
            value={mainLlmKey}
            onChange={selectMainLlm}
            className="max-w-[280px]"
            title="选择 Conductor 使用的主模型"
            aria-label="Conductor 主模型"
          />
          <span className="text-xs text-[#7B6D5A]">默认子代理模型</span>
          <SubagentModelSelect
            llms={llms}
            value={subagentLlmKey}
            onChange={selectSubagentLlm}
            className="max-w-[280px]"
            title="选择未显式指定时使用的子代理模型"
            aria-label="Conductor 子代理模型"
          />
          <label
            className={clsx(
              'flex items-center gap-1 text-xs text-[#7B6D5A]',
              subagentLlmKey === null && 'opacity-50',
            )}
            title="锁定后忽略 Conductor 单次派单指定的其他模型"
          >
            <input
              type="checkbox"
              checked={subagentModelLocked}
              disabled={subagentLlmKey === null}
              onChange={(event) => {
                const locked = event.target.checked
                setSubagentModelLocked(locked)
                try {
                  localStorage.setItem(SUBAGENT_MODEL_LOCK_KEY, String(locked))
                } catch {}
              }}
            />
            锁定
          </label>
          <button onClick={stopConductor} disabled={!status?.started} className="ga-btn-danger">停止</button>
        </div>
      }
      middleArea={
        <div className="flex items-center gap-3">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8A7A63]">
            {activeSubagents.length > 0 ? 'subagent' : '最近完成'}
          </span>
          <div className="flex min-w-0 justify-start gap-1.5 overflow-x-auto pb-0.5">
            {visibleSubagents.length === 0 ? (
              <span className="rounded border border-line bg-bg-card/70 px-2 py-1 text-xs text-[#7B6D5A]">
                暂无子代理记录
              </span>
            ) : (
              visibleSubagents.map((sub, index) => (
                <SubagentChip
                  key={sub.id}
                  sub={sub}
                  index={index}
                  selected={selectedSubagent === sub.id}
                  onClick={() => setSelectedSubagent(sub.id)}
                />
              ))
            )}
          </div>
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
                    {msg.role === 'user' ? '' : 'Conductor'}
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

          {/* Right: Details / Log */}
          <div className="flex w-80 flex-col rounded-2xl border border-line bg-bg-card shadow-sm overflow-hidden">
            {selectedDetail ? (
              <>
                <div className="border-b border-line/70 bg-bg-card/70 px-4 py-3">
                  <h2 className="text-sm font-semibold text-[#2C2418]">Subagent 详情</h2>
                </div>
                <div className="flex-1 space-y-4 overflow-y-auto p-4">
                  <div>
                    <div className="mb-1 text-xs text-[#665741]">ID</div>
                    <div className="break-all font-mono text-sm text-[#2C2418]">{selectedDetail.id}</div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-[#665741]">状态</div>
                    <div className="text-sm text-[#2C2418]">{selectedDetail.status}</div>
                  </div>
                  <div>
                    <div className="mb-1 text-xs text-[#665741]">Reply ({selectedDetail.reply.length} chars)</div>
                    <div className="max-h-64 overflow-y-auto rounded border border-line bg-bg-soft p-2 text-xs text-[#2C2418]">
                      <MarkdownView mode="plain" cache>
                        {selectedDetail.reply || '(无回复)'}
                      </MarkdownView>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="border-b border-line/70 bg-bg-card/70 px-4 py-3">
                  <h2 className="text-sm font-semibold text-[#2C2418]">任务编排</h2>
                </div>
                <div
                  ref={logScrollRef}
                  onScroll={() => {
                    shouldFollowLogRef.current = isNearScrollTop(logScrollRef.current)
                    scrollMemory.logTop = logScrollRef.current?.scrollTop ?? scrollMemory.logTop
                  }}
                  className="flex-1 space-y-2 overflow-y-auto p-3"
                >
                  {visibleLog.length === 0 ? (
                    <p className="mt-4 text-center text-xs text-[#665741]">暂无关键事件</p>
                  ) : (
                    visibleLog.map((item) => (
                      <div key={item.id} className="rounded-lg border border-line bg-bg-card p-2 text-xs text-[#2C2418] shadow-[0_2px_6px_rgba(45,34,22,0.10)]">
                        <div className="mb-1 flex items-center gap-2 text-[11px] text-[#665741]">
                          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-accent/80">
                            {logEventLabel(item.event)}
                          </span>
                          <span>T{item.turn}</span>
                        </div>
                        <div className="line-clamp-4 whitespace-pre-wrap break-words">{item.text}</div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
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
    </PageShell>
  )
}

function SubagentChip({
  sub,
  index,
  selected,
  onClick,
}: {
  sub: ConductorSubagent
  index: number
  selected: boolean
  onClick: () => void
}) {
  const running = sub.status === 'running'

  return (
    <button
      type="button"
      onClick={onClick}
      title={agentTooltip(sub, index)}
      aria-label={agentTooltip(sub, index)}
      className={clsx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[11px] font-semibold transition',
        running
          ? 'border-[#B58C43]/45 bg-[#FFF3D8] text-[#7A4F08] shadow-[0_1px_0_rgba(255,255,255,0.55)]'
          : 'border-line bg-bg-card/70 text-[#8A7A63]',
        selected && 'ring-2 ring-accent/45'
      )}
    >
      {index + 1}
    </button>
  )
}
