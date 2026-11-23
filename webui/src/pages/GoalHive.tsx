import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import { MainModelSelect, SubagentModelSelect } from '@/components/ModelSelect'
import { bubbleTone } from '@/components/bubbleTone'
import { MessageContent } from '@/components/MessageContent'
import { ModalOverlay } from '@/components/ModalOverlay'
import { useSharedModelSelection } from '@/hooks/useSharedModelSelection'
import { useDraftStore } from '@/stores/draftStore'
import { useGoalHiveStore } from '@/stores/goalhiveStore'
import { dialog } from '@/stores/dialogStore'
import { GoalHiveSocket } from '@/runtime/goalHiveSocket'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import { CloseIconButton, Play, Settings2, Square, StatusIconBadge, Trash2 } from '@/components/ActionIcons'

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

  const reset = async () => {
    if (!wsRef.current) return
    if (msgs.length > 0 || streaming) {
      const ok = await dialog.confirm(
        '清空 Goal Hive 历史？',
        '将清空当前对话记录及上下文，无法恢复。',
        { confirmText: '清空历史', tone: 'danger' },
      )
      if (!ok) return
    }
    wsRef.current?.send({ type: 'reset' })
  }

  return (
    <PageShell
      title="Goal Hive"
      titleExtra={
        <StatusIconBadge
          kind={streaming ? 'running' : conn === 'connecting' ? 'connecting' : 'idle'}
          label={streaming ? '运行中' : conn === 'connecting' ? '连接中' : '未运行'}
        />
      }
      actions={
        <div className="flex items-center gap-2 whitespace-nowrap">
          <span className="text-xs text-ink-muted">主模型</span>
          <MainModelSelect
            llms={llms}
            value={mainLlmKey}
            onChange={selectMainLlm}
            className="max-w-[400px]"
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
            <Settings2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>子代理设置</span>
          </button>
          <button onClick={abort} disabled={!streaming} className="ga-btn-danger">
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            <span>停止</span>
          </button>
        </div>
      }
    >
      <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[minmax(19rem,23.5rem)_minmax(0,1fr)]">
        <section className="flex flex-col min-h-0 overflow-hidden border-b border-line/55 bg-bg-card/65 md:border-b-0 md:border-r">
          <form onSubmit={submit} className="flex flex-1 min-h-0 flex-col">
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <div className="ga-segmented" role="group" aria-label="Goal Hive 模式">
                  {(['goal', 'hive'] as GoalMode[]).map((item) => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => setMode(item)}
                      aria-pressed={mode === item}
                      className={clsx(
                        'ga-segmented-btn px-4 text-sm',
                        mode === item && 'ga-segmented-btn-active',
                      )}
                    >
                      {item.toUpperCase()}
                    </button>
                  ))}
                </div>
                <span className="text-[11px] font-medium text-accent">{config.title}</span>
              </div>

              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-ink leading-snug">{config.subtitle}</h2>
                <p className="text-xs text-ink-muted leading-5">{config.helper}</p>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {config.chips.map((chip) => (
                  <span key={chip} className="rounded-full bg-bg-soft/85 px-2.5 py-0.5 text-[11px] text-ink-muted">
                    {chip}
                  </span>
                ))}
              </div>

              <hr className="ga-hairline" />

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ink">目标</span>
                <textarea
                  ref={targetRef}
                  value={target}
                  rows={3}
                  onChange={(event) => setTarget(event.target.value)}
                  placeholder={config.placeholder}
                  wrap="soft"
                  className="w-full min-w-0 max-h-[220px] resize-none overflow-y-auto overflow-x-hidden rounded-xl border border-line/75 bg-bg-soft/75 px-3.5 py-2.5 text-sm leading-6 text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-bg-card focus:ring-2 focus:ring-accent/15 whitespace-pre-wrap break-words [overflow-wrap:anywhere] transition-colors"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ink">补充约束（可选）</span>
                <textarea
                  ref={conditionRef}
                  value={condition}
                  rows={2}
                  onChange={(event) => setCondition(event.target.value)}
                  placeholder="例如：先汇报计划；不得修改记忆；预算到期后总结验证结果。"
                  wrap="soft"
                  className="w-full min-w-0 max-h-[180px] resize-none overflow-y-auto overflow-x-hidden rounded-xl border border-line/75 bg-bg-soft/75 px-3.5 py-2.5 text-sm leading-6 text-ink placeholder:text-ink-faint outline-none focus:border-accent focus:bg-bg-card focus:ring-2 focus:ring-accent/15 whitespace-pre-wrap break-words [overflow-wrap:anywhere] transition-colors"
                />
              </label>

              <div className="ga-paper-subcard p-3 space-y-1">
                <div className="text-[11px] font-medium text-ink-faint">指令预览</div>
                <pre className="whitespace-pre-wrap break-words text-xs text-ink font-mono">{preview || `${config.command} ...`}</pre>
              </div>
            </div>

            <div className="shrink-0 bg-bg-soft/45 px-4 py-3 flex items-center justify-between gap-3 border-t border-line/40">
              <p className="min-w-0 text-xs text-ink-muted truncate" title={streaming ? '当前任务输出中，完成后可启动下一项。' : '输出保留在本页面日志区，不混入普通聊天。'}>
                {streaming ? '任务输出中，完成后可继续发起' : '独立工作台输出，不混入普通聊天'}
              </p>
              <button
                type="submit"
                disabled={!canSubmit}
                className="ga-btn-primary shrink-0"
              >
                <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                <span>启动 {config.title}</span>
              </button>
            </div>
          </form>
        </section>

        <section className="flex flex-col min-h-0 overflow-hidden bg-bg-soft/35">
          <div className="px-5 py-3.5 border-b border-line/55 bg-bg-card/45 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-ink">执行输出</h2>
              <span className="text-xs text-ink-faint">· 实时日志</span>
            </div>
            <button type="button" onClick={() => { void reset() }} className="ga-btn-sm">
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>清空历史</span>
            </button>
          </div>
          <div ref={logRef} className="flex-1 min-h-0 overflow-auto p-5 space-y-4">
            {msgs.length === 0 ? (
              <div className="h-full min-h-64 grid place-items-center text-sm text-ink-faint">尚无 Goal / Hive 输出。</div>
            ) : (
              msgs.map((msg) => (
                <article key={msg.id} className={clsx('rounded-xl px-4 py-3', bubbleTone(msg.role, 'card').surfaceClass)}>
                  <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-ink-muted">
                    <span>{msg.role === 'user' ? '你' : mode === 'hive' ? 'Hive 主控' : 'Goal Agent'}</span>
                    {msg.streaming && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-normal text-accent">
                        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" aria-hidden="true" />
                        <span>输出中</span>
                      </span>
                    )}
                  </div>
                  <MessageContent content={msg.content} format="pre" className="text-sm leading-6 text-ink font-sans" />
                </article>
              ))
            )}
          </div>
        </section>
      </div>

      {subagentSettingsOpen && (
        <ModalOverlay
          onClose={closeSubagentSettings}
          panelRef={subagentSettingsDialogRef}
          labelledBy="goal-hive-subagent-settings-title"
          panelClassName="w-full max-w-md"
        >
          <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
            <h2 id="goal-hive-subagent-settings-title" className="text-base font-semibold text-ink">子代理设置</h2>
            <CloseIconButton
              label="关闭子代理设置"
              variant="ghost"
              iconSize={16}
              onClick={closeSubagentSettings}
              className="h-8 w-8 text-ink-muted hover:bg-bg-soft hover:text-ink"
            />
          </div>
          <div className="px-5 py-5">
            <label className="block text-sm font-medium text-ink">
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
            <button type="button" className="ga-btn-primary" onClick={saveSubagentSettings}>保存</button>
          </div>
        </ModalOverlay>
      )}
    </PageShell>
  )
}
