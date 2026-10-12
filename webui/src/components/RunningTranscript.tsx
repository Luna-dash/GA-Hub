import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { AssistantTranscript } from '@/utils/assistantTranscript'
import { parseAssistantTranscript } from '@/utils/assistantTranscript'
import { MessageContent } from './MessageContent'
import { AskUserCard } from './AskUserCard'

function OutputDetails({ title, content }: { title: string; content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="turn-fold" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && <MessageContent content={content} format="markdown" cache />}
    </details>
  )
}

/** Only mounted for an executing assistant message. Completion uses the existing reply view. */
export function RunningTranscript({ transcript, askUserDraftKey, askUserInteractive, recoveryStatus }: {
  recoveryStatus?: ReactNode
  transcript: AssistantTranscript
  askUserDraftKey?: string
  askUserInteractive: boolean
}) {
  const current = transcript.turns.at(-1)
  const completed = transcript.turns.slice(0, -1)
  const content = current ? current.content : transcript.finalBody
  const askUser = parseAssistantTranscript(content).finalAskUser
  const viewportRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const highWater = useRef(0)
  const following = useRef(true)
  const lastOutput = useRef({ turn: current?.turn ?? 1, content: '' })
  const [heldHeight, setHeldHeight] = useState(0)
  const [paused, setPaused] = useState(false)
  const [frozen, setFrozen] = useState<typeof lastOutput.current | null>(null)
  const turn = current?.turn ?? 1
  if (content.trim()) lastOutput.current = { turn, content }
  const output = frozen || (content.trim() ? { turn, content } : lastOutput.current)
  const previous = output.turn !== turn
  const summary = current?.summary || completed.at(-1)?.summary || '正在继续…'
  const summaryIsPrevious = !current?.summary && Boolean(completed.at(-1)?.summary)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const body = bodyRef.current
    if (!viewport || !body) return
    const measure = () => {
      // Responsive cap is controlled by CSS; remember only this preview's
      // attained height, never the whole task or expanded history height.
      const cap = parseFloat(getComputedStyle(viewport).maxHeight) || 240
      const height = Math.min(cap, Math.max(44, body.getBoundingClientRect().height))
      highWater.current = Math.min(cap, Math.max(highWater.current, height))
      setHeldHeight(highWater.current)
      if (following.current) viewport.scrollTop = viewport.scrollHeight
    }
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(body)
    observer?.observe(viewport)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [output.content, turn])

  const resume = () => {
    following.current = true
    setPaused(false)
    setFrozen(null)
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
  }

  return (
    <section data-running-transcript className="min-w-0 space-y-3">
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-success" aria-hidden="true" />
        <span>执行中 · Turn {turn}</span>
      </div>
      <div className="h-10 overflow-y-auto break-words text-sm leading-relaxed" data-running-summary>
        <span className="mr-1.5 text-ink-faint">{summaryIsPrevious ? '上一轮：' : '当前进展：'}</span>
        {summary}
      </div>
      <details className="turn-fold" data-running-history>
        <summary>已完成步骤 · {completed.length}轮</summary>
        <div className="space-y-2 pt-2">
          {transcript.leading && <OutputDetails title="前置内容" content={transcript.leading} />}
          {completed.map((step) => (
            <OutputDetails key={step.turn} title={`Turn ${step.turn} · ${step.summary || '执行过程'}`} content={step.content} />
          ))}
          {!completed.length && <p className="text-xs text-ink-faint">首轮正在执行</p>}
        </div>
      </details>
      {recoveryStatus}
      {askUser && (
        <AskUserCard question={askUser.question} candidates={askUser.candidates} draftKey={askUserDraftKey} interactive={askUserInteractive} />
      )}
      <div className="min-w-0" data-running-output>
        <div className="mb-1.5 flex h-6 items-center justify-between gap-2 text-xs text-ink-muted">
          <span>{paused ? `回看中 · Turn ${output.turn}` : previous ? `上一轮输出 · Turn ${output.turn}` : '实时输出'}</span>
          <button type="button" onClick={resume} disabled={!paused}
            className="shrink-0 text-accent disabled:invisible">回到最新</button>
        </div>
        <div ref={viewportRef} data-running-preview tabIndex={0} aria-label="实时输出预览"
          style={{ minHeight: heldHeight || 44, maxHeight: 'min(240px, 35vh)' }}
          className="min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain rounded-md border border-line bg-bg-soft [overflow-anchor:none]"
          onScroll={(event) => {
            const el = event.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
            if (!atBottom && following.current) {
              following.current = false
              setPaused(true)
              setFrozen(output)
            }
          }}>
          <div ref={bodyRef} className="min-w-0 p-3">
            {output.content ? <MessageContent content={output.content} format="markdown" cache={paused || previous} />
              : <p className="text-xs text-ink-faint">正在继续…</p>}
          </div>
        </div>
        <OutputDetails title={`查看详情 · Turn ${turn}`} content={content} />
      </div>
    </section>
  )
}
