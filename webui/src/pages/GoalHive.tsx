import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChatSocket } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import { useDraftStore } from '@/stores/draftStore'
import type { ChatStreamSnapshot, ChatWSOut } from '@/api/types'

type GoalMode = 'goal' | 'hive'
type ConnState = 'connecting' | 'open' | 'closed'

interface ModeConfig {
  title: string
  subtitle: string
  command: '/goal' | '/hive'
  placeholder: string
  helper: string
  chips: string[]
}

interface GoalMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  streaming?: boolean
}

const GOAL_HIVE_SOURCE = 'goal_hive'

const modeConfigs: Record<GoalMode, ModeConfig> = {
  goal: {
    title: 'Goal',
    subtitle: '单 Agent 长程自驱，按目标与终止条件持续推进。',
    command: '/goal',
    placeholder: '例如：持续优化 GA-Hub 的前端体验，预算 2 小时，完成后给出变更摘要与验证结果',
    helper: '适合单线深挖、迭代优化、代码整理、调研总结等目标明确的长程任务。',
    chips: ['一句话目标', 'condition 约束', '时间 / token 预算'],
  },
  hive: {
    title: 'Goal Hive',
    subtitle: '多 worker 协作版 Goal，由 Master 拆分、调度和验收。',
    command: '/hive',
    placeholder: '例如：并行审查 GA-Hub 的路由、状态管理和构建链路，3 个 worker，终止条件是输出可执行修复清单',
    helper: '适合大范围审计、多模块并行探索、需要 Master/Worker 协同推进的复杂目标。',
    chips: ['集群目标', 'worker 配额', '终止条件'],
  },
}

function snapshotToMessages(streams: ChatStreamSnapshot[]): GoalMessage[] {
  const msgs: GoalMessage[] = []
  streams.forEach((s) => {
    if (s.query) msgs.push({ id: `${s.stream_id}:user`, role: 'user', content: s.query })
    msgs.push({ id: s.stream_id, role: 'assistant', content: s.content || '已启动，等待输出…', streaming: !s.done })
  })
  return msgs
}

function applyGoalEvent(prev: GoalMessage[], evt: ChatWSOut): GoalMessage[] {
  if (evt.type === 'snapshot') return snapshotToMessages(evt.streams)
  if (evt.type === 'started') {
    const sid = evt.stream_id
    const userMsg: GoalMessage = { id: `${sid}:user`, role: 'user', content: evt.query || '' }
    const assistantMsg: GoalMessage = { id: sid, role: 'assistant', content: '已启动，等待输出…', streaming: true }
    return [...prev, userMsg, assistantMsg].filter((m) => m.content)
  }
  if (evt.type === 'next' || evt.type === 'done') {
    const sid = evt.stream_id
    const exists = prev.some((m) => m.id === sid)
    const nextMsg: GoalMessage = {
      id: sid,
      role: 'assistant',
      content: evt.content || '',
      streaming: evt.type !== 'done',
    }
    return exists ? prev.map((m) => (m.id === sid ? nextMsg : m)) : [...prev, nextMsg]
  }
  if (evt.type === 'error') {
    return [...prev, { id: `error:${Date.now()}`, role: 'system', content: `错误：${evt.error}` }]
  }
  return prev
}

export function GoalHive() {
  const [mode, setMode] = useState<GoalMode>('goal')
  const targetDraftKey = `goalHive:${mode}:target`
  const conditionDraftKey = `goalHive:${mode}:condition`
  const target = useDraftStore((state) => state.texts[targetDraftKey] ?? '')
  const condition = useDraftStore((state) => state.texts[conditionDraftKey] ?? '')
  const setTarget = (value: string) => useDraftStore.getState().setText(targetDraftKey, value)
  const setCondition = (value: string) => useDraftStore.getState().setText(conditionDraftKey, value)
  const clearGoalDraft = () => {
    useDraftStore.getState().clearDraft(targetDraftKey)
    useDraftStore.getState().clearDraft(conditionDraftKey)
  }
  const [conn, setConn] = useState<ConnState>('connecting')
  const [msgs, setMsgs] = useState<GoalMessage[]>([])
  const socketRef = useRef<ChatSocket | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<HTMLTextAreaElement | null>(null)
  const conditionRef = useRef<HTMLTextAreaElement | null>(null)

  const config = modeConfigs[mode]
  const streaming = msgs.some((m) => m.streaming)
  const canSubmit = target.trim().length > 0 && conn === 'open' && !streaming

  const preview = useMemo(() => {
    const parts = [target.trim(), condition.trim()].filter(Boolean)
    return `${config.command} ${parts.join('\n')}`.trim()
  }, [condition, config.command, target])

  useEffect(() => {
    const socket = new ChatSocket('/ws/chat?source=goal_hive')
    socket.onMessage = (evt) => setMsgs((prev) => applyGoalEvent(prev, evt))
    socket.onState = setConn
    socketRef.current = socket
    socket.open()
    return () => {
      socketRef.current = null
      socket.close()
    }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [msgs])

  useLayoutEffect(() => {
    for (const el of [targetRef.current, conditionRef.current]) {
      if (!el) continue
      el.style.height = 'auto'
      el.style.height = `${Math.min(el.scrollHeight, 280)}px`
    }
  }, [target, condition])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    socketRef.current?.send({ type: 'submit', text: preview, images: [], source: GOAL_HIVE_SOURCE })
    clearGoalDraft()
  }

  return (
    <PageShell
      title="Goal Hive"
      titleExtra={
        <span className={`ga-badge ${streaming ? 'ga-badge-connected' : conn === 'connecting' ? 'ga-badge-connecting' : 'ga-badge-offline'}`}>
          {streaming ? '运行中' : conn === 'connecting' ? '连接中' : '未运行'}
        </span>
      }
      description="Long-horizon agent mode"
      actions={
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-xl border border-line bg-bg-soft p-1">
            {(['goal', 'hive'] as GoalMode[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setMode(item)}
              className={clsx(
                'px-4 py-1 rounded-lg text-sm transition',
                mode === item ? 'bg-accent text-white shadow-sm' : 'text-[#665741] hover:text-[#2C2418]',
              )}
            >
              {modeConfigs[item].title}
            </button>
          ))}
          </div>
          <button onClick={() => socketRef.current?.close()} disabled={!streaming} className="ga-btn-danger">停止</button>
        </div>
      }
    >
      <div className="grid grid-cols-1 xl:grid-cols-[420px_minmax(0,1fr)] gap-6 h-full min-h-0 p-6">
        <section className="rounded-2xl border border-line bg-bg-card p-5 shadow-sm overflow-auto">
          <div className="space-y-2 mb-5">
            <div className="text-sm text-accent font-medium">{config.title}</div>
            <h2 className="text-2xl font-semibold text-[#2C2418]">{config.subtitle}</h2>
            <p className="text-sm text-[#665741] leading-6">启动输出会留在本页面的独立日志区，不跳转、不混入普通聊天页。</p>
          </div>

          <div className="flex flex-wrap gap-2 mb-5">
            {config.chips.map((chip) => (
              <span key={chip} className="text-xs px-2.5 py-1 rounded-full border border-line bg-bg-soft text-[#665741]">
                {chip}
              </span>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-[#2C2418]">目标</span>
              <textarea
                ref={targetRef}
                value={target}
                rows={4}
                onChange={(event) => setTarget(event.target.value)}
                placeholder={config.placeholder}
                wrap="soft"
                className="w-full min-w-0 max-h-[280px] resize-none overflow-y-auto overflow-x-hidden rounded-xl border border-line bg-bg-soft px-4 py-3 text-sm leading-6 text-[#2C2418] placeholder:text-[#8A7B65] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-[#2C2418]">补充约束（可选）</span>
              <textarea
                ref={conditionRef}
                value={condition}
                rows={3}
                onChange={(event) => setCondition(event.target.value)}
                placeholder="例如：先汇报计划；不得修改记忆；预算到期后总结验证结果。"
                wrap="soft"
                className="w-full min-w-0 max-h-[280px] resize-none overflow-y-auto overflow-x-hidden rounded-xl border border-line bg-bg-soft px-4 py-3 text-sm leading-6 text-[#2C2418] placeholder:text-[#8A7B65] outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              />
            </label>

            <div className="rounded-xl border border-line bg-bg-soft/70 p-4 space-y-2">
              <div className="text-xs uppercase tracking-[0.16em] text-[#8A7B65]">将发送到本页独立通道</div>
              <pre className="whitespace-pre-wrap break-words text-sm text-[#3B3326] font-mono">{preview || `${config.command} ...`}</pre>
            </div>

            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-[#665741]">{streaming ? '当前任务输出中，完成后可启动下一项。' : config.helper}</p>
              <button
                type="submit"
                disabled={!canSubmit}
                className="shrink-0 px-4 py-2 rounded-lg bg-accent text-white text-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                启动 {config.title}
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-line bg-bg-card shadow-sm flex flex-col min-h-0 overflow-hidden">
          <div className="px-5 py-4 border-b border-line flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-[#2C2418]">独立输出</div>
              <div className="text-xs text-[#8A7B65]">source: {GOAL_HIVE_SOURCE}</div>
            </div>
            <button type="button" onClick={() => setMsgs([])} className="text-xs px-3 py-1.5 rounded-lg border border-line text-[#665741] hover:text-[#2C2418]">
              清空本地显示
            </button>
          </div>
          <div ref={logRef} className="flex-1 min-h-0 overflow-auto p-5 space-y-4">
            {msgs.length === 0 ? (
              <div className="h-full min-h-64 grid place-items-center text-sm text-[#8A7B65]">尚无 Goal / Hive 输出。</div>
            ) : (
              msgs.map((msg) => (
                <article key={msg.id} className={clsx('rounded-xl border p-4', msg.role === 'user' ? 'border-accent/30 bg-accent/10' : msg.role === 'system' ? 'border-amber-500/30 bg-amber-500/10' : 'border-line bg-bg-soft/70')}>
                  <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[#8A7B65]">
                    {msg.role}
                    {msg.streaming && <span className="text-accent normal-case tracking-normal">streaming</span>}
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-[#2C2418] font-sans">{msg.content}</pre>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </PageShell>
  )
}
