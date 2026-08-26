import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import { MainModelSelect, SubagentModelSelect } from '@/components/ModelSelect'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { useDraftStore } from '@/stores/draftStore'
import { useGoalHiveStore } from '@/stores/goalhiveStore'
import { GoalHiveSocket } from '@/runtime/goalHiveSocket'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'

type GoalMode = 'goal' | 'hive'

interface ModeConfig {
  title: string
  subtitle: string
  command: '/goal' | '/hive'
  placeholder: string
  helper: string
  chips: string[]
}

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

export default function GoalHive() {
  const [mode, setMode] = usePageState<GoalMode>('goalhive.mode', 'goal')
  const [subagentSettingsOpen, setSubagentSettingsOpen] = useState(false)
  const [draftSubagentLlmKey, setDraftSubagentLlmKey] = useState<string | null>(null)
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

  // Independent WebSocket state from zustand
  const { messages: msgs, conn, setMessages, setConn } = useGoalHiveStore()
  const wsRef = useRef<GoalHiveSocket | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const targetRef = useRef<HTMLTextAreaElement | null>(null)
  const conditionRef = useRef<HTMLTextAreaElement | null>(null)
  const subagentSettingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const subagentSettingsDialogRef = useRef<HTMLDivElement | null>(null)

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
    selectMainLlm,
    selectSubagentLlm,
  } = useSharedModelSelection(llms)

  const openSubagentSettings = () => {
    setDraftSubagentLlmKey(subagentLlmKey)
    setSubagentSettingsOpen(true)
  }

  const closeSubagentSettings = () => {
    setSubagentSettingsOpen(false)
    requestAnimationFrame(() => subagentSettingsButtonRef.current?.focus())
  }

  const saveSubagentSettings = () => {
    selectSubagentLlm(draftSubagentLlmKey)
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
          'button:not([disabled]), select:not([disabled])',
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

  const config = modeConfigs[mode]
  const streaming = msgs.some((m) => m.streaming)
  const canSubmit = target.trim().length > 0 && conn === 'open' && !streaming && effectiveLlmIndex !== null

  const preview = useMemo(() => {
    const parts = [target.trim(), condition.trim()].filter(Boolean)
    return `${config.command} ${parts.join('\n')}`.trim()
  }, [condition, config.command, target])

  // Independent /ws/goalhive WebSocket connection
  useEffect(() => {
    const socket = new GoalHiveSocket()
    socket.onState = setConn
    socket.onMessages = setMessages
    wsRef.current = socket
    socket.open()

    return () => {
      if (wsRef.current === socket) wsRef.current = null
      socket.close()
    }
  }, [setConn, setMessages])

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
    if (!canSubmit || !wsRef.current) return
    
    // Build combined text for goal/hive prompt
    const parts = [target.trim(), condition.trim()].filter(Boolean)
    const text = parts.join('\n')
    
    const sent = wsRef.current.send({
      type: 'submit',
      text,
      mode,
      llm_index: effectiveLlmIndex,
      subagent_llm_index: effectiveSubagentLlmIndex,
    })
    if (sent) clearGoalDraft()
  }

  const abort = () => {
    if (wsRef.current) {
      wsRef.current.send({ type: 'abort' })
    }
  }

  const reset = () => {
    if (wsRef.current) {
      wsRef.current.send({ type: 'reset' })
    }
  }

  return (
    <PageShell
      title="Goal Hive"
      titleExtra={
        <span className={`ga-badge ${streaming ? 'ga-badge-connected' : conn === 'connecting' ? 'ga-badge-connecting' : 'ga-badge-offline'}`}>
          {streaming ? '运行中' : conn === 'connecting' ? '连接中' : '未运行'}
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
            title="选择 Goal / Hive 使用的主模型"
            aria-label="Goal / Hive 主模型"
          />
          <button
            ref={subagentSettingsButtonRef}
            type="button"
            disabled={mode !== 'hive'}
            className="ga-btn"
            title={mode === 'hive' ? '选择 Hive 子代理使用的模型' : 'Goal 模式不启动子代理'}
            aria-haspopup="dialog"
            aria-expanded={subagentSettingsOpen}
            onClick={openSubagentSettings}
          >
            子代理设置
          </button>
          <button onClick={abort} disabled={!streaming} className="ga-btn-danger">停止</button>
        </div>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-1 gap-3 p-3 md:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] lg:gap-5 lg:p-5">
        <section className="overflow-auto rounded-2xl border border-line bg-bg-card p-4 shadow-sm lg:p-5">
          <div className="mb-4 inline-flex rounded-xl border border-line bg-bg-soft p-1" role="group" aria-label="Goal Hive 模式">
            {(['goal', 'hive'] as GoalMode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(item)}
                aria-pressed={mode === item}
                className={clsx(
                  'rounded-lg px-4 py-1 text-sm transition',
                  mode === item ? 'bg-accent text-white shadow-sm' : 'text-[#665741] hover:text-[#2C2418]',
                )}
              >
                {item.toUpperCase()}
              </button>
            ))}
          </div>

          <div className="mb-4 space-y-2 lg:mb-5">
            <div className="text-sm text-accent font-medium">{config.title}</div>
            <h2 className="text-lg font-semibold text-[#2C2418]">{config.subtitle}</h2>
            <p className="text-sm text-[#665741] leading-6">启动输出会留在本页面的独立日志区，不跳转、不混入普通聊天页。</p>
          </div>

          <div className="mb-4 flex flex-wrap gap-2 lg:mb-5">
            {config.chips.map((chip) => (
              <span key={chip} className="text-xs px-2.5 py-1 rounded-full border border-line bg-bg-soft text-[#665741]">
                {chip}
              </span>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3 lg:space-y-4">
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
              <div className="text-xs text-[#8A7B65]">独立 GoalHive 通道</div>
            </div>
            <button type="button" onClick={reset} className="text-xs px-3 py-1.5 rounded-lg border border-line text-[#665741] hover:text-[#2C2418]">
              清空历史
            </button>
          </div>
          <div ref={logRef} className="flex-1 min-h-0 overflow-auto p-5 space-y-4">
            {msgs.length === 0 ? (
              <div className="h-full min-h-64 grid place-items-center text-sm text-[#8A7B65]">尚无 Goal / Hive 输出。</div>
            ) : (
              msgs.map((msg) => (
                <article key={msg.id} className={clsx('rounded-xl border p-4', msg.role === 'user' ? 'border-accent/30 bg-accent/10' : msg.role === 'system' ? 'border-amber-500/30 bg-amber-500/10' : 'border-line bg-bg-soft/70')}>
                  <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.16em] text-[#8A7B65]">
                    {msg.role === 'user' ? 'YOU' : mode === 'hive' ? 'HIVE MASTER' : 'GOAL AGENT'}
                    {msg.streaming && <span className="text-accent normal-case tracking-normal">streaming</span>}
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-sm leading-6 text-[#2C2418] font-sans">{msg.content}</pre>
                </article>
              ))
            )}
          </div>
        </section>
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
            aria-labelledby="goal-hive-subagent-settings-title"
            className="w-full max-w-md rounded-xl border border-line bg-bg-card shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
              <h2 id="goal-hive-subagent-settings-title" className="text-base font-semibold text-[#2C2418]">子代理设置</h2>
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
            <div className="px-5 py-5">
              <label className="block text-sm font-medium text-[#2C2418]">
                默认模型
                <SubagentModelSelect
                  llms={llms}
                  value={draftSubagentLlmKey}
                  onChange={setDraftSubagentLlmKey}
                  className="mt-2 w-full"
                  aria-label="Hive 子代理默认模型"
                  autoFocus
                />
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
