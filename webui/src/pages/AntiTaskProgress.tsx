import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { components } from '@/api/generated/schema'
import { ChevronRight } from 'lucide-react'

type Step = components['schemas']['AntiStep']
export type AntiEvent = components['schemas']['AntiMessageDelta' | 'AntiStepUpdate']

type TimelineStep = Omit<Step, 'text_delta'> & { description: string }

const toolLabels = new Map([
  ['view_file', '读取文件'], ['list_dir', '查看目录'], ['grep_search', '搜索内容'],
  ['find_by_name', '查找文件'], ['run_command', '运行命令'],
])

function stepLabel(step: TimelineStep) {
  if (step.tool) return toolLabels.get(step.tool) ?? `调用 ${step.tool}`
  switch (step.kind) {
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
      ...previous, ...update,
      description: (previous?.description ?? '') + (text_delta ?? ''),
    })
  }
  return { steps: [...steps.values()], partial: reply.join('') }
}

export function AntiTaskProgress({ active, runKey, loadEvents, streamUrl, onEventsChanged, children }: {
  active: boolean
  runKey: string
  loadEvents: (signal: AbortSignal) => Promise<AntiEvent[]>
  streamUrl?: string
  onEventsChanged: () => void
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
    source.onerror = () => {
      setStreamConnected(false)
      source.close()
    }
    return () => {
      setStreamConnected(false)
      source.close()
    }
  }, [active, runKey, streamUrl])

  const { data, isPending, isError, refetch } = useQuery({
    // A separate terminal request cannot reuse an in-flight live poll.
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
    <details className="group rounded-lg border border-line/60 text-xs text-ink-muted" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={14} className="shrink-0 group-open:rotate-90" aria-hidden="true" />
        <span className="font-medium text-ink">任务过程</span>
        {steps.length > 0 && <span>{steps.length} 个步骤</span>}
        {active && <span className="[overflow-wrap:anywhere]">{latest ? stepLabel(latest) : '等待步骤事件…'}</span>}
      </summary>
      <div className="space-y-2 border-t border-line/60 px-2.5 py-2">
        {isError && <p role="alert">过程记录加载失败。<button type="button" className="ml-2 text-accent underline" onClick={() => void refetch()}>重试</button></p>}
        {steps.length > 0 ? <ol className="space-y-2" aria-label="任务步骤">
          {steps.map(step => <li key={step.index} className="border-l border-line pl-2 [overflow-wrap:anywhere]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="font-medium text-ink" title={step.tool ?? undefined}>{stepLabel(step)}</span>
              {step.state && <span>{stepStatus(step.state)}</span>}
              {typeof step.duration_seconds === 'number' && <span>{step.duration_seconds.toLocaleString(undefined, { maximumFractionDigits: 2 })} 秒</span>}
            </div>
            {step.description && <p className="mt-1 whitespace-pre-wrap text-ink">{step.description}</p>}
          </li>)}
        </ol> : !isError && <p>{isPending ? '正在加载过程…' : active ? '等待步骤事件…' : '此轮没有步骤记录。'}</p>}
      </div>
    </details>
    {children(partial)}
  </>
}
