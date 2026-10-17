import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '@/api/client'
import type { SessionMessagesResponse } from '@/api/types'
import { ChatSocket } from '@/runtime/chatSocket'
import { applyEvent, historyToMessages, prependUniqueHistory, type ChatMsg } from '@/stores/chatStore'
import { scanTranscript } from '@/utils/transcriptProtocol'
import { errorMessageFromError } from '@/utils/sessionUi'
import { ThemeConversationHistory } from './ThemeConversationHistory'

const action = 'rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg-soft disabled:opacity-40'

/** Read-only session projection. Never activates or mutates the global chat store. */
export type ThemeTaskTab = 'report' | 'current' | 'history'
export function ThemeTaskTabs({ tab, onChange }: { tab: ThemeTaskTab; onChange: (tab: ThemeTaskTab) => void }) {
  return <div role="tablist" aria-label="任务内容" className="flex min-w-0 items-center gap-1">
    {([['report', '结论'], ['current', '本次过程'], ['history', '会话历史']] as const).map(([key, label]) => <button key={key} type="button" role="tab" tabIndex={tab === key ? 0 : -1} aria-selected={tab === key} onKeyDown={event => {
      const keys: ThemeTaskTab[] = ['report', 'current', 'history']
      const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (!direction && event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (keys.indexOf(key) + direction + 3) % 3
      onChange(keys[index]); (event.currentTarget.parentElement?.children[index] as HTMLElement)?.focus()
    }} className={`whitespace-nowrap rounded-md px-3 py-2 text-xs transition-colors ${tab === key ? 'bg-accent/10 font-medium text-accent' : 'text-slate-500 hover:bg-bg-soft hover:text-accent'}`} onClick={() => onChange(key)}>{label}</button>)}
  </div>
}
export function ThemeTaskHistory({ sessionId, runId, active, children, expanded = true, selectedTab, onTabChange }: {
  sessionId: string; runId?: string | null; active: boolean; children: ReactNode; expanded?: boolean
  selectedTab?: ThemeTaskTab; onTabChange?: (tab: ThemeTaskTab) => void
}) {
  const [localTab, setLocalTab] = useState<ThemeTaskTab>('report')
  const tab = selectedTab ?? localTab
  const [opened, setOpened] = useState({ current: false, history: false })
  useEffect(() => { if (tab !== 'report') setOpened(value => value[tab] ? value : { ...value, [tab]: true }) }, [tab])
  return <div className="theme-task-content min-w-0">
    {selectedTab === undefined && <div className="mb-3"><ThemeTaskTabs tab={tab} onChange={onTabChange ?? setLocalTab} /></div>}
    <div role="tabpanel" aria-label="结论" hidden={tab !== 'report'}>{children}</div>
    {opened.current && <div role="tabpanel" aria-label="本次过程" hidden={tab !== 'current'}><SessionTimeline sessionId={sessionId} runId={runId} current enabled={expanded && tab === 'current'} active={active} onShowReport={() => (onTabChange ?? setLocalTab)('report')} /></div>}
    {opened.history && <div role="tabpanel" aria-label="会话历史" hidden={tab !== 'history'}><ThemeConversationHistory sessionId={sessionId} enabled={expanded && tab === 'history'} /></div>}
  </div>
}

// Current-run view is a summary projection, never a second transcript/report.
function ProcessSummary({ message }: { message: ChatMsg }) {
  const rows = useMemo(() => {
    const nodes = scanTranscript(message.content)
    let turn: number | undefined
    return nodes.flatMap(node => {
      if (node.kind === 'turn') turn = node.turn
      if (node.kind !== 'summary' || !node.complete) return []
      return [{ label: turn != null ? `Turn ${turn}` : '', summary: node.raw.replace(/^<summary>|<\/summary>$/gi, '').trim() }]
    })
  }, [message.content, message.streaming])
  return <article className="min-w-0">
    <ol className="space-y-2 text-sm leading-relaxed">
      {rows.map((row, index) => <li key={index} className="flex items-baseline gap-3">
        <span aria-hidden="true" className="shrink-0 text-xs text-slate-500">{row.label || '·'}</span>
        <span className="min-w-0 whitespace-pre-wrap break-words">{row.summary || '本轮未记录摘要'}</span>
      </li>)}
    </ol>
    {!rows.length && <p className="text-xs text-slate-500">{message.streaming ? '等待过程摘要…' : '未记录过程摘要'}</p>}
  </article>
}

function SessionTimeline({ sessionId, runId, current, enabled, active, onShowReport }: {
  sessionId: string; runId?: string | null; current: boolean; enabled: boolean; active: boolean; onShowReport?: () => void
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [page, setPage] = useState<SessionMessagesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [connection, setConnection] = useState('connecting')
  const [unseen, setUnseen] = useState(false)
  const viewport = useRef<HTMLDivElement>(null)
  const position = useRef(0)
  const follow = useRef(true)
  const prepend = useRef<{ height: number; top: number } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const archive = useRef<SessionMessagesResponse['items']>([])
  const total = useRef<number | null>(null)
  const load = useCallback(async (before?: number) => {
    controller.current?.abort()
    const request = new AbortController(); controller.current = request
    setLoading(true); setError('')
    try {
      let result = await api.getSessionMessages(sessionId, { limit: 60, before, signal: request.signal })
      if (request.signal.aborted) return
      // A run may span archive pages. Complete that run automatically, without
      // offering a history cursor that usually only loads unrelated older runs.
      const cursors = new Set<number>()
      while (current && runId && result.items.length > 0 && result.items.every(item => item.run_id === runId)
        && result.has_more && result.next_before != null) {
        const cursor = result.next_before
        if (cursors.has(cursor)) throw new Error('本次过程未能完整读取，请刷新重试。')
        cursors.add(cursor)
        const older = await api.getSessionMessages(sessionId, { limit: 60, before: cursor, signal: request.signal })
        if (request.signal.aborted) return
        result = { ...result, items: [...older.items, ...result.items], has_more: older.has_more, next_before: older.next_before }
      }
      const el = viewport.current
      if (before !== undefined && el) prepend.current = { height: el.scrollHeight, top: el.scrollTop }
      // Revision is a content hash: normal appends change it too. Retain older
      // pages by archive identity, and let historyToMessages restore ordinal order.
      const generation = result.items.find(item => item.archive_generation)?.archive_generation
      const previousGeneration = archive.current.find(item => item.archive_generation)?.archive_generation
      const changed = (total.current !== null && result.total != null && result.total < total.current)
        || !!(generation && previousGeneration && generation !== previousGeneration)
      const items = new Map((changed ? [] : archive.current).map(item => [item.id, item]))
      result.items.forEach(item => items.set(item.id, item))
      archive.current = [...items.values()]
      total.current = result.total ?? null
      const history = historyToMessages([...archive.current])
      setMessages(old => changed ? history : prependUniqueHistory(history, old.filter(message => message.source !== 'history')))
      // Refresh the latest page without losing the cursor of already loaded older pages.
      setPage(old => before === undefined && old && !changed ? { ...result, has_more: old.has_more, next_before: old.next_before } : result)
    } catch (e) {
      if (!request.signal.aborted) setError(errorMessageFromError(e))
    } finally { if (!request.signal.aborted) setLoading(false) }
  }, [sessionId, current, runId])
  useEffect(() => {
    if (!enabled) return
    void load()
    const socket = new ChatSocket(`/ws/sessions/${encodeURIComponent(sessionId)}`)
    socket.onState = setConnection
    socket.onMessage = event => {
      if (event.session_id && event.session_id !== sessionId) return
      if (event.type === 'resync_required' || event.type === 'rewound' || event.type === 'reset') {
        setMessages([]); setPage(null); archive.current = []; total.current = null; void load(); return
      }
      setMessages(old => applyEvent(old, event))
      if (event.type === 'done' || (event.type === 'session_runtime' && event.status === 'idle')) void load()
    }
    socket.open()
    return () => { controller.current?.abort(); socket.close() }
  }, [sessionId, enabled, load])
  const visible = useMemo(() => current ? (runId ? messages.filter(message => message.runId === runId && message.role === 'assistant') : []) : messages, [messages, current, runId])
  const previousRun = useRef(runId)
  useLayoutEffect(() => {
    if (previousRun.current !== runId) { previousRun.current = runId; position.current = 0; follow.current = true }
    if (!enabled || !viewport.current) return
    const el = viewport.current
    if (prepend.current) {
      el.scrollTop = prepend.current.top + el.scrollHeight - prepend.current.height
      prepend.current = null
    } else if (follow.current) {
      el.scrollTop = el.scrollHeight; setUnseen(false)
    } else { el.scrollTop = position.current; setUnseen(true) }
    position.current = el.scrollTop
  }, [visible, enabled, runId])
  return <section className="overflow-hidden rounded-2xl border border-border">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-soft/30 px-4 py-3 text-xs text-slate-500">
      <span>{current ? (active ? '本次执行 · 实时过程' : '最近一次执行') : '原会话历史 · 只读'}</span>
      <span>{connection === 'open' ? (active ? '实时连接' : '已同步') : '连接中'}<button className={`${action} ml-2`} disabled={loading} onClick={() => void load()}>刷新</button></span>
    </div>
    {error && <p role="alert" className="px-4 py-3 text-xs text-status-danger">读取失败：{error}<button className={`${action} ml-2`} disabled={loading} onClick={() => void load()}>重试</button></p>}
    <div ref={viewport} tabIndex={0} aria-label={current ? '本次过程时间线' : '会话历史时间线'} className="max-h-[65dvh] min-h-64 overflow-y-auto overscroll-contain p-4 sm:p-5 [overflow-anchor:none]" onScroll={event => {
      const el = event.currentTarget; position.current = el.scrollTop; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 64
      if (follow.current) setUnseen(false)
    }}>
      {!current && page?.has_more && page.next_before != null && <div className="mb-4 text-center"><button className={action} disabled={loading} onClick={() => void load(page.next_before!)}>加载更早消息</button></div>}
      {loading && <p role="status" className="mb-3 text-center text-xs text-slate-500">正在读取…</p>}
      {!visible.length && !loading && <p className="py-16 text-center text-sm text-slate-500">{current ? !runId ? '暂无可关联的执行记录，可在会话历史中查看。' : active ? '等待本次执行内容…' : '暂无本次执行记录，可在会话历史中查看。' : '暂无会话历史'}</p>}
      {visible.filter(message => !current || message.role === 'assistant').map((message, index) => current
        ? <ProcessSummary key={`${message.runId ?? ''}:${message.streamId ?? message.timestamp ?? index}:${message.role}`} message={message} />
        : null)}
    </div>
    {current && visible.length > 0 && !active && !visible.some(message => message.streaming) && <div className="border-t border-border px-4 py-3 text-sm">
      <span className="mr-3 text-slate-500">结果</span><button className="text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={onShowReport}>查看结论 →</button>
    </div>}
    {unseen && <div className="border-t border-border p-2 text-center"><button className={action} onClick={() => {
      follow.current = true; setUnseen(false)
      if (viewport.current) { viewport.current.scrollTop = viewport.current.scrollHeight; position.current = viewport.current.scrollTop }
    }}>有新内容 · 回到底部 ↓</button></div>}
  </section>
}
