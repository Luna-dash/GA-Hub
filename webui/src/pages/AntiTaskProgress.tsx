import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { components } from '@/api/generated/schema'
import { ChevronRight } from 'lucide-react'
import clsx from 'clsx'

type Step = components['schemas']['AntiStep']
export type AntiEvent = components['schemas']['AntiMessageDelta' | 'AntiStepUpdate']

type TimelineStep = Omit<Step, 'text_delta'> & { description: string }

const toolLabels = new Map([
  ['view_file', '读取文件'], ['list_dir', '查看目录'], ['grep_search', '搜索内容'],
  ['find_by_name', '查找文件'], ['run_command', '运行命令'],
  ['replace_file_content', '修改文件'], ['multi_replace_file_content', '批量修改文件'],
  ['write_to_file', '写入文件'], ['runtime_notice', '策略降级提示'],
])

function stepLabel(step: TimelineStep) {
  if (step.tool) return toolLabels.get(step.tool) ?? step.tool
  switch (step.kind) {
    case 'thought': return '思考过程'
    case 'planner_response': return '任务计划'
    case 'agent_response': return '生成回复'
    case 'tool_call': return '调用工具'
    default: return step.kind
  }
}

function stepStatus(state: string) {
  switch (state) {
    case 'ACTIVE': return '进行中'
    case 'DONE': return '已完成'
    case 'FAILED': case 'ERROR': return '失败'
    case 'CANCELLED': case 'CANCELED': return '已取消'
    default: return state
  }
}

function collectEvents(events: AntiEvent[] = []) {
  const steps = new Map<number, TimelineStep>()
  const reply: string[] = []
  for (const event of events) {
    if (event.type === 'message.delta') reply.push(event.text)
    if (!event.step) continue
    const { text_delta, ...update } = event.step
    const previous = steps.get(update.index)
    steps.set(update.index, {
      ...previous,
      ...update,
      description: (previous?.description ?? '') + (text_delta ?? ''),
      command: update.command ?? previous?.command,
      cwd: update.cwd ?? previous?.cwd,
      output: update.output ?? previous?.output,
      exit_code: update.exit_code ?? previous?.exit_code,
      diff: update.diff ?? previous?.diff,
      detail: update.detail ?? previous?.detail,
    })
  }
  return { steps: [...steps.values()], partial: reply.join('') }
}

function DiffBlock({ diff }: { diff: string }) {
  return (
    <pre className="mt-1.5 max-h-64 overflow-auto rounded-md border border-line/60 bg-bg-soft p-2 font-mono text-[11px] leading-4">
      {diff.split('\n').map((line, i) => {
        const cls = line.startsWith('+') && !line.startsWith('+++')
          ? 'text-status-success'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'text-status-danger'
            : line.startsWith('@@')
              ? 'text-accent'
              : 'text-ink-muted'
        return <div key={i} className={clsx('whitespace-pre-wrap break-all', cls)}>{line || ' '}</div>
      })}
    </pre>
  )
}

export function AntiTaskProgress({ active, runKey, loadEvents, streamUrl, onEventsChanged, onApprovalRequested, children }: {
  active: boolean
  runKey: string
  loadEvents: (signal: AbortSignal) => Promise<AntiEvent[]>
  streamUrl?: string
  onEventsChanged: () => void
  onApprovalRequested?: () => void
  children: (partial: string) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [startedLive] = useState(active)
  const [streamEvents, setStreamEvents] = useState<AntiEvent[]>([])
  const [streamConnected, setStreamConnected] = useState(false)

  useEffect(() => {
    setStreamEvents([])
    setStreamConnected(false)
    if (!active || !streamUrl || typeof EventSource === 'undefined') return
    const source = new EventSource(streamUrl)
    const onPayload = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as AntiEvent | { type?: string }
        if (parsed && (parsed.type === 'message.delta' || parsed.type === 'step.update')) {
          setStreamEvents(old => [...old, parsed as AntiEvent])
        }
      } catch {
        // Ignore malformed or keepalive SSE frames; polling fallback recovers full state.
      }
    }
    const handleEvent = (event: MessageEvent<string>) => onPayload(event.data)
    source.onopen = () => setStreamConnected(true)
    source.onmessage = handleEvent
    source.addEventListener('message.delta', handleEvent as EventListener)
    source.addEventListener('step.update', handleEvent as EventListener)
    source.addEventListener('approval.requested', (() => onApprovalRequested?.()) as EventListener)
    source.onerror = () => {
      setStreamConnected(false)
      source.close()
    }
    return () => {
      setStreamConnected(false)
      source.close()
    }
  }, [active, runKey, streamUrl, onApprovalRequested])

  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['anti-run-events', runKey, active ? 'active' : 'terminal'],
    queryFn: ({ signal }) => loadEvents(signal),
    enabled: active || startedLive || open,
    refetchInterval: active && !streamConnected ? 900 : false,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
    retry: false,
  })
  const events = streamEvents.length >= (data?.length ?? 0) && streamEvents.length > 0 ? streamEvents : data
  useEffect(() => {
    if (active || startedLive) onEventsChanged()
  }, [events, active, startedLive, onEventsChanged])
  const { steps, partial } = useMemo(() => collectEvents(events), [events])
  const latest = steps.at(-1)

  return <>
    <details className="group rounded-xl bg-bg-soft/60 text-xs text-ink-muted ring-1 ring-line/45" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="shrink-0 text-ink-faint transition-transform duration-150 group-open:rotate-90" aria-hidden="true" />
        <span className="font-medium text-ink">任务过程</span>
        {steps.length > 0 && <span className="rounded-full bg-bg-card/80 px-1.5 py-0.5 text-[11px] tabular-nums">{steps.length} 步</span>}
        {active && <span className="[overflow-wrap:anywhere]">{latest ? stepLabel(latest) : '等待步骤事件…'}</span>}
      </summary>
      <div className="space-y-2.5 border-t border-line/40 px-3 py-2.5">
        {isError && <p role="alert">过程记录加载失败。<button type="button" className="ga-btn-link ml-2" onClick={() => void refetch()}>重试</button></p>}
        {steps.length > 0 ? <ol className="space-y-2.5" aria-label="任务步骤">
          {steps.map(step => <li key={step.index} className="border-l-2 border-accent/25 pl-2.5 [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium text-ink" title={step.tool ?? undefined}>{stepLabel(step)}</span>
              {step.state && <span>{stepStatus(step.state)}</span>}
              {typeof step.exit_code === 'number' && <span className={step.exit_code === 0 ? 'text-status-success' : 'text-status-danger'}>exit {step.exit_code}</span>}
              {typeof step.duration_seconds === 'number' && <span>{step.duration_seconds.toLocaleString(undefined, { maximumFractionDigits: 2 })} 秒</span>}
            </div>
            {step.command && <div className="mt-1 rounded bg-bg-soft px-2 py-1 font-mono text-[11px] text-ink">{step.command}</div>}
            {!step.command && step.detail && <div className="mt-0.5 text-[11px] text-ink-muted">{step.detail}</div>}
            {step.description && <p className="mt-1 whitespace-pre-wrap text-ink">{step.description}</p>}
            {step.diff && <DiffBlock diff={step.diff} />}
            {step.output && (
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-bg-soft p-2 font-mono text-[11px] text-ink-muted whitespace-pre-wrap break-all">
                {step.output}
              </pre>
            )}
          </li>)}
        </ol> : !isError && <p>{isPending ? '正在加载过程…' : active ? '等待步骤事件…' : '此轮没有步骤记录。'}</p>}
      </div>
    </details>
    {children(partial)}
  </>
}
