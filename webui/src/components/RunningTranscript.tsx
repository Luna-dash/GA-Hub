import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { renderAskUserPayload, type AssistantTranscript } from '@/utils/assistantTranscript'
import { formatToolHint, projectRunningTurn, runningTurnTitle } from '@/utils/runningTranscript'
import { MessageContent } from './MessageContent'
import { TranscriptRecordContent } from './TranscriptRecordContent'
import { AskUserCard } from './AskUserCard'
import { CollapseToLatestButton } from './CollapseToLatestButton'

/** One chronological process. Only the running view uses this light projection. */
export function RunningTranscript({ transcript, askUserDraftKey, askUserInteractive, recoveryStatus, recoveryBeforeTurn, recoveryTitle = '自动重连' }: {
  recoveryTitle?: string
  recoveryBeforeTurn?: number
  recoveryStatus?: ReactNode
  transcript: AssistantTranscript
  askUserDraftKey?: string
  askUserInteractive: boolean
}) {
  const turns = useMemo(() => (transcript.turns.length ? transcript.turns : [
    { turn: 1, summary: '', content: transcript.finalBody },
  ]).map(turn => ({ ...turn, ...projectRunningTurn(turn.rawContent ?? turn.content) })), [transcript])
  const visibleTurns = turns.filter(turn => turn.summary.trim() || turn.parts.length || turn.askUser || turn.thinking)
  const current = visibleTurns.at(-1)
  const askUser = current?.askUser || transcript.finalAskUser
  const viewportRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [heightCap, setHeightCap] = useState(() => window.innerHeight * 0.8)
  useLayoutEffect(() => {
    // Use the chat output viewport, not the whole window or the growing message body.
    const output = viewportRef.current?.closest<HTMLElement>('[data-live-chat-scroll]')
    const updateCap = () => setHeightCap((output?.clientHeight || window.innerHeight) * 0.8)
    updateCap()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateCap) : null
    if (output) observer?.observe(output)
    window.addEventListener('resize', updateCap)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateCap)
    }
  }, [])
  const latestRef = useRef<HTMLDivElement>(null)
  const [jumpRequest, setJumpRequest] = useState(0)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [fullTurns, setFullTurns] = useState<Record<number, boolean>>({})
  const collapseAnchor = useRef<number | null>(null)
  const isOpen = (turn: number) => expanded[turn] ?? current?.turn === turn
  const [recoveryExpanded, setRecoveryExpanded] = useState<boolean | null>(null)
  const retryHasOutput = recoveryBeforeTurn !== undefined && turns.slice(recoveryBeforeTurn).some(turn => visibleTurns.includes(turn))
  const recoveryOpen = recoveryExpanded ?? !retryHasOutput
  const recoveryRow = recoveryStatus && <div data-recovery-turn className="min-w-0 text-xs text-ink-muted">
    <button type="button" aria-expanded={recoveryOpen} className="flex w-full gap-2 px-1 py-2 text-left" onClick={() => setRecoveryExpanded(!recoveryOpen)}>
      <span aria-hidden="true">{recoveryOpen ? '▾' : '▸'}</span><span>{recoveryTitle}</span>
    </button>
    {recoveryOpen && <div className="pb-2 pl-5">{recoveryStatus}</div>}
  </div>

  // Real output, not a bare marker, retires previously expanded records.
  const previousCurrent = useRef(current?.turn)
  useLayoutEffect(() => {
    if (previousCurrent.current === current?.turn) return
    previousCurrent.current = current?.turn
    setExpanded({})
    setFullTurns({})
    setRecoveryExpanded(null)
  }, [current?.turn])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const body = bodyRef.current
    if (!viewport || !body) return
    // Let CSS size the viewport from the current visible content, not a historical peak.
    if (collapseAnchor.current !== null) {
      const title = body.querySelector<HTMLElement>(`[data-running-turn="${collapseAnchor.current}"] > button`)
      if (title) viewport.scrollTop += title.getBoundingClientRect().top - viewport.getBoundingClientRect().top - viewport.clientTop
      collapseAnchor.current = null
    } else if (following.current) viewport.scrollTop = viewport.scrollHeight
  }, [transcript, expanded, fullTurns, heightCap])

  const detach = () => {
    if (!following.current) return
    following.current = false
    // Detach only scrolling. Previous rounds still retire when real new output arrives.
  }
  const toggleFull = (turn: number) => {
    detach()
    if (fullTurns[turn]) {
      // Explicit collapse hides both the full record and its simple preview.
      collapseAnchor.current = turn
      setExpanded(value => ({ ...value, [turn]: false }))
    } else {
      setExpanded(value => ({ ...value, [turn]: true }))
    }
    setFullTurns(value => ({ ...value, [turn]: !value[turn] }))
  }
  const collapseToLatest = () => {
    following.current = true
    collapseAnchor.current = null
    setExpanded(Object.fromEntries(turns.map(turn => [turn.turn, false])))
    setFullTurns({})
    setRecoveryExpanded(false)
    setJumpRequest(value => value + 1)
  }
  useLayoutEffect(() => {
    if (!jumpRequest) return
    const viewport = viewportRef.current
    if (viewport) viewport.scrollTop = viewport.scrollHeight
    latestRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' })
  }, [jumpRequest])

  return (
    <section data-running-transcript className="relative min-w-0">
      <div ref={viewportRef} data-running-preview hidden={!visibleTurns.length && !transcript.leading && !(recoveryStatus && recoveryBeforeTurn !== undefined && recoveryBeforeTurn < turns.length)} tabIndex={0} aria-label="执行过程"
        style={{ maxHeight: heightCap }}
        className="min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
        onWheel={event => { if (event.deltaY < 0) detach() }}
        onScroll={event => {
          const el = event.currentTarget
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 24) detach()
          // Only the explicit latest action re-enables following while inspecting a record.
        }}>
        <div ref={bodyRef} className="min-w-0 space-y-1 pb-1">
          {transcript.leading && <MessageContent content={transcript.leading} format="markdown" cache />}
          {turns.map((turn, index) => {
            const active = current?.turn === turn.turn
            const open = isOpen(turn.turn)
            const full = !!fullTurns[turn.turn]
            const visible = visibleTurns.includes(turn)
            const toolTitle = !turn.summary && !open && !full && expanded[turn.turn] !== false
              ? formatToolHint(turn.parts.flatMap(part => part.kind === 'tools' ? part.labels : []))
              : ''
            return (
              <Fragment key={turn.turn}>
                {recoveryStatus && recoveryBeforeTurn === index && recoveryRow}
                {visible && <div data-running-turn={turn.turn} className="min-w-0">
                <button type="button" aria-expanded={full} aria-label={`${full ? '收起完整记录' : '展开完整记录'} · Turn ${turn.turn}`} aria-controls={`running-${askUserDraftKey || 'turn'}-${turn.turn}`}
                  className="flex w-full items-start gap-2 rounded px-1 py-2 text-left text-xs text-ink-muted hover:bg-bg-soft"
                  onClick={() => toggleFull(turn.turn)}>
                  <span aria-hidden="true" className="shrink-0 text-ink-faint">{full ? '▾' : '▸'}</span>
                  <span className="shrink-0 text-ink-faint">Turn {turn.turn}</span>
                  <span className="min-w-0 break-words text-ink">{toolTitle || (runningTurnTitle(turn.summary, turn.rawContent ?? turn.content) === '执行记录' && expanded[turn.turn] === false ? '' : runningTurnTitle(turn.summary, turn.rawContent ?? turn.content))}</span>
                  {active && <span aria-label="正在输出" className="ml-auto mt-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
                </button>
                {open && <div id={`running-${askUserDraftKey || 'turn'}-${turn.turn}`} className="min-w-0 space-y-2 pb-2 pl-5 pr-2">
                  {full ? <div data-full-record>
                    <TranscriptRecordContent content={turn.rawContent ?? turn.content} cache={!active} />
                    <button type="button" aria-label={`收起完整记录 · Turn ${turn.turn}`}
                      className="mt-3 flex items-center gap-1 rounded px-2 py-1 text-xs text-ink-muted hover:bg-bg-soft"
                      onClick={() => toggleFull(turn.turn)}><span aria-hidden="true">⌃</span> 收起完整记录</button>
                  </div> : <>{turn.parts.map((part, partIndex) => part.kind === 'text'
                    ? <MessageContent key={partIndex} content={part.text} format="markdown" cache={!active} />
                    : <p key={partIndex} data-tool-hint className="break-words text-[11px] leading-relaxed text-ink-faint">↳ {formatToolHint(part.labels)}</p>)}
                  {turn.thinking && <p data-thinking-hint className="text-xs text-ink-faint">思考内容已隐藏，可展开完整记录查看</p>}
                  {!active && turn.askUser && <MessageContent content={renderAskUserPayload(turn.askUser)} format="markdown" cache />}</>}
                </div>}
                </div>}
              </Fragment>
            )
          })}
        </div>
      </div>
      {recoveryStatus && (recoveryBeforeTurn === undefined || recoveryBeforeTurn >= turns.length) && <div className="mt-2 text-xs text-ink-muted">{recoveryRow}</div>}
      {askUser && <div className="mt-2"><AskUserCard question={askUser.question} candidates={askUser.candidates} draftKey={askUserDraftKey} interactive={askUserInteractive} /></div>}
      <CollapseToLatestButton onClick={collapseToLatest} />
      <div ref={latestRef} data-transcript-latest />
    </section>
  )
}
