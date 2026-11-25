import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { components } from '@/api/generated/schema'
import { ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { CollapseToLatestButton } from '@/components/CollapseToLatestButton'
import { useConversationCollapse } from '@/components/ConversationCollapse'

type Step = components['schemas']['AntiStep'] & { image_path?: string | null }
export type AntiEvent =
  | (Omit<components['schemas']['AntiMessageDelta'], 'step'> & { step?: Step | null })
  | (Omit<components['schemas']['AntiStepUpdate'], 'step'> & { step: Step })

type TimelineStep = Omit<Step, 'text_delta'> & { description: string; image_path?: string | null }

const toolLabels = new Map([
  ['view_file', '读取文件'], ['list_dir', '查看目录'], ['grep_search', '搜索内容'],
  ['find_by_name', '查找文件'], ['run_command', '运行命令'],
  ['replace_file_content', '修改文件'], ['multi_replace_file_content', '批量修改文件'],
  ['write_to_file', '写入文件'], ['runtime_notice', '运行时提示'],
  ['user_steer', '运行中插话纠偏'],
])

function stepLabel(step: TimelineStep) {
  if (step.tool) return toolLabels.get(step.tool) ?? step.tool
  switch (step.kind) {
    case 'thought': return '思考过程'
    case 'planner_response': return '任务计划'
    case 'agent_response': return '生成回复'
    case 'tool_call': return '调用工具'
    case 'user_steer': return '运行中插话纠偏'
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

type ReplySegment = {
  index: number
  chunks: string[]
  followedByActivity: boolean
}

function collectEvents(events: AntiEvent[] = []) {
  const steps = new Map<number, TimelineStep>()
  const replySegments: ReplySegment[] = []
  const replyByIndex = new Map<number, ReplySegment>()
  for (const event of events) {
    if (event.type === 'message.delta') {
      const segIdx = event.step?.index ?? Number.MAX_SAFE_INTEGER
      let seg = replyByIndex.get(segIdx)
      if (!seg) {
        seg = { index: segIdx, chunks: [], followedByActivity: false }
        replyByIndex.set(segIdx, seg)
        replySegments.push(seg)
      }
      seg.chunks.push(event.text)
    }
    if (!event.step) continue
    if (event.step.kind === 'thought' || event.step.kind === 'tool_call' || event.step.kind === 'user_steer') {
      for (const seg of replySegments) {
        if (seg.index < event.step.index) {
          seg.followedByActivity = true
        }
      }
    }
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
      image_path: update.image_path ?? previous?.image_path,
    })
  }
  const progressMessages = replySegments
    .filter(seg => seg.followedByActivity)
    .map(seg => seg.chunks.join('').trim())
    .filter(Boolean)
  const partial = replySegments
    .filter(seg => !seg.followedByActivity)
    .map(seg => seg.chunks.join(''))
    .join('')
  return { steps: [...steps.values()], partial, progressMessages }
}

function splitDescriptionParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[ \t]*\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
}

function isRedundantDetail(label: string, detail: string): boolean {
  const normLabel = label.trim().replace(/\\/g, '/').replace(/[`'"]/g, ' ').toLowerCase()
  const normDetail = detail.trim().replace(/\\/g, '/').toLowerCase()
  if (!normLabel || !normDetail) return false
  if (normLabel === normDetail || normLabel.includes(normDetail)) return true
  if (normLabel.endsWith('...')) {
    const prefix = normLabel.slice(0, -3).trim()
    const lastSpace = prefix.lastIndexOf(' ')
    const pathPart = lastSpace >= 0 ? prefix.slice(lastSpace + 1) : prefix
    if (pathPart.length >= 6 && normDetail.startsWith(pathPart)) return true
  }
  const base = normDetail.split('/').filter(Boolean).pop() ?? ''
  if (base.length >= 3 && (
    normLabel === base
    || normLabel.endsWith(`/${base}`)
    || normLabel.endsWith(` ${base}`)
    || normLabel.includes(`/${base}`)
    || normLabel.includes(` ${base}`)
    || (base.includes('.') && normLabel.includes(base))
  )) {
    return true
  }
  return false
}

function TerminalOutputPre({ output, active }: { output: string; active: boolean }) {
  const preRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (active && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [active, output])
  return (
    <pre
      ref={preRef}
      data-live-terminal-output={active ? 'streaming' : 'settled'}
      className="mt-1 max-h-40 overflow-auto rounded bg-bg-soft p-2 font-mono text-[11px] text-ink-muted whitespace-pre-wrap break-all"
    >
      {output}
    </pre>
  )
}

export function AntiTaskProgress({ active, runKey, loadEvents, streamUrl, onEventsChanged, onApprovalRequested, onStreamEnded, children }: {
  active: boolean
  runKey: string
  loadEvents: (signal: AbortSignal) => Promise<AntiEvent[]>
  streamUrl?: string
  onEventsChanged: () => void
  onApprovalRequested?: () => void
  onStreamEnded?: () => void
  children: (partial: string, progressMessages: string[]) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [collapseVersion, setCollapseVersion] = useState(0)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const latestRef = useRef<HTMLDivElement>(null)
  const collapseProcess = useCallback(() => {
    if (detailsRef.current) detailsRef.current.open = false
    setOpen(false)
    setCollapseVersion(value => value + 1)
  }, [])
  const conversationManaged = useConversationCollapse(open, collapseProcess)
  useLayoutEffect(() => {
    if (collapseVersion && !conversationManaged) {
      latestRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
    }
  }, [collapseVersion, conversationManaged])
  const [startedLive] = useState(active)
  const [streamEvents, setStreamEvents] = useState<AntiEvent[]>([])
  const [streamConnected, setStreamConnected] = useState(false)
  const onEventsChangedRef = useRef(onEventsChanged)
  const onApprovalRequestedRef = useRef(onApprovalRequested)
  const onStreamEndedRef = useRef(onStreamEnded)
  onEventsChangedRef.current = onEventsChanged
  onApprovalRequestedRef.current = onApprovalRequested
  onStreamEndedRef.current = onStreamEnded

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
    source.addEventListener('approval.requested', (() => onApprovalRequestedRef.current?.()) as EventListener)
    source.onerror = () => {
      setStreamConnected(false)
      source.close()
      onStreamEndedRef.current?.()
    }
    return () => {
      setStreamConnected(false)
      source.close()
    }
  }, [active, runKey, streamUrl])

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
    if (active || startedLive) onEventsChangedRef.current()
  }, [events, active, startedLive])
  const { steps, partial, progressMessages } = useMemo(() => collectEvents(events), [events])
  const latest = steps.at(-1)

  return <>
    <details ref={detailsRef} className="group mb-3 border-b border-line/70 pb-2 text-xs text-ink-muted" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-line bg-bg-soft px-3 py-2 text-left text-xs font-medium text-ink-muted transition-colors hover:bg-bg-card hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} className="shrink-0 text-ink-faint transition-transform duration-150 group-open:rotate-90" aria-hidden="true" />
        <span>{open ? '收起任务过程' : '查看任务过程'}</span>
        {active && <span className="min-w-0 truncate font-normal text-ink-faint">· {latest ? stepLabel(latest) : '等待步骤事件…'}</span>}
        {steps.length > 0 && <span className="ml-auto shrink-0 tabular-nums text-ink-faint">共 {steps.length} 步</span>}
        {active && <span aria-label="正在输出" className={clsx('h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent', steps.length === 0 && 'ml-auto')} />}
      </summary>
      <div className="mt-1.5 space-y-2 px-1 py-1">
        {isError && <p role="alert">过程记录加载失败。<button type="button" className="ga-btn-link ml-2" onClick={() => void refetch()}>重试</button></p>}
        {steps.length > 0 ? <ol className="space-y-2" aria-label="任务步骤">
          {steps.map(step => {
            const label = stepLabel(step)
            const isNotice = step.tool === 'runtime_notice'
            const isSteer = step.kind === 'user_steer'
            const isLiveOutput = step.state === 'ACTIVE' && Boolean(step.output)
            const showDetail = Boolean(
              step.detail
              && !(step.image_path && step.detail === step.image_path)
              && (isNotice || (!step.command && !isRedundantDetail(label, step.detail))),
            )
            const descriptionParagraphs = step.description ? splitDescriptionParagraphs(step.description) : []
            return <li
              key={step.index}
              data-step-kind={step.kind}
              className={clsx(
                'pl-2.5 [overflow-wrap:anywhere]',
                isSteer ? 'rounded-r-lg border-l-2 border-accent bg-accent-soft/25 py-1 pr-2' : 'border-l-2 border-accent/25',
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-medium text-ink" title={step.detail || step.tool || undefined}>{label}</span>
                {step.state && <span>{stepStatus(step.state)}</span>}
                {isLiveOutput && (
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium text-accent">
                    实时输出
                  </span>
                )}
                {typeof step.exit_code === 'number' && <span className={step.exit_code === 0 ? 'text-status-success' : 'text-status-danger'}>exit {step.exit_code}</span>}
                {typeof step.duration_seconds === 'number' && <span>{step.duration_seconds.toLocaleString(undefined, { maximumFractionDigits: 2 })} 秒</span>}
              </div>
              {step.command && <div className="mt-1 rounded bg-bg-soft px-2 py-1 font-mono text-[11px] text-ink">{step.command}</div>}
              {showDetail && !isSteer && (
                <div
                  data-step-detail
                  className={clsx('mt-0.5 text-[11px]', isNotice ? 'text-status-warning' : 'text-ink-muted')}
                >
                  {step.detail}
                </div>
              )}
              {step.image_path && (
                <div
                  data-step-image-path
                  className="mt-0.5 font-mono text-[11px] text-ink-muted"
                >
                  图片路径：{step.image_path}
                </div>
              )}
              {descriptionParagraphs.length > 0 && (
                <div
                  data-step-description
                  className={clsx(
                    'mt-1 text-ink',
                    step.kind === 'thought' ? 'space-y-1 leading-snug' : 'space-y-1 leading-relaxed',
                  )}
                >
                  {descriptionParagraphs.map((paragraph, idx) => (
                    <p key={idx} className="whitespace-pre-wrap">{paragraph}</p>
                  ))}
                </div>
              )}
              {step.output && (
                <TerminalOutputPre output={step.output} active={isLiveOutput} />
              )}
            </li>
          })}
        </ol> : !isError && <p>{isPending ? '正在加载过程…' : active ? '等待步骤事件…' : '此轮没有步骤记录。'}</p>}
      </div>
    </details>
    {!conversationManaged && open && <CollapseToLatestButton onClick={collapseProcess} />}
    <div ref={latestRef} data-transcript-latest />
    {children(partial, progressMessages)}
  </>
}
