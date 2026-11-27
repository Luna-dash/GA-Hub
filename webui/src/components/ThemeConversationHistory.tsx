import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/api/client'
import type { SessionMessagesResponse } from '@/api/types'
import { ChatSocket } from '@/runtime/chatSocket'
import { applyEvent, historyToMessages, type ChatMsg } from '@/stores/chatStore'
import { parseAssistantTranscript, renderAskUserPayload } from '@/utils/assistantTranscript'
import { errorMessageFromError } from '@/utils/sessionUi'
import { replySegmentsTurns } from '@/utils/replySegments'
import { MessageContent } from './MessageContent'
import { ChevronLeft, ChevronRight, RefreshIcon } from './ActionIcons'

type ConversationSection = { id: string; question: string; answers: ChatMsg[] }

/** User messages, not model turns or run ids, delimit a conversation section. */
function conversationSections(messages: ChatMsg[], hasMore: boolean): ConversationSection[] {
  const sections: ConversationSection[] = []
  for (const message of messages) {
    if (message.role === 'user') {
      sections.push({ id: message.streamId ?? `user:${sections.length}:${message.timestamp}`, question: message.content, answers: [] })
    } else if (message.role === 'assistant') {
      // A page can begin halfway through an answer. Do not attach it to the
      // next question; it becomes a section only after its user page is read.
      if (!sections.length && !hasMore) sections.push({ id: `orphan:${message.streamId}`, question: '', answers: [] })
      sections.at(-1)?.answers.push(message)
    }
  }
  return sections
}

function SectionConclusion({ answers }: { answers: ChatMsg[] }) {
  const answer = answers.at(-1)
  const pending = answers.some(message => message.streaming)
  const transcript = useMemo(() => answer && !pending ? parseAssistantTranscript(answer.content, false,
    answer.segments?.length ? replySegmentsTurns(answer.segments) : answer.turnSegments,
  ) : null, [answer, pending])
  const content = transcript ? [transcript.finalBody, transcript.finalAskUser && renderAskUserPayload(transcript.finalAskUser)].filter(Boolean).join('\n\n') : ''
  return content ? <MessageContent content={content} format="markdown" markdownMode="chat" /> : <p className="text-sm text-ink-faint">{pending ? '正在执行，尚无结论' : '本节未记录结论'}</p>
}

const navigation = 'ga-btn-ghost disabled:cursor-default disabled:opacity-30'

/** Read-only archive projection, independent of the active chat session. */
export function ThemeConversationHistory({ sessionId, enabled }: { sessionId: string; enabled: boolean }) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const archive = useRef<SessionMessagesResponse['items']>([])
  const page = useRef<SessionMessagesResponse | null>(null)
  const controller = useRef<AbortController | null>(null)
  const navigating = useRef(false)
  const viewport = useRef<HTMLDivElement>(null)

  const load = useCallback(async (before?: number) => {
    controller.current?.abort()
    const request = new AbortController(); controller.current = request
    setLoading(true); setError('')
    try {
      let result = await api.getSessionMessages(sessionId, { limit: 60, before, signal: request.signal })
      if (request.signal.aborted) return
      const generation = result.items.find(item => item.archive_generation)?.archive_generation
      const oldGeneration = archive.current.find(item => item.archive_generation)?.archive_generation
      const changed = (page.current?.total != null && result.total != null && result.total < page.current.total)
        || !!(generation && oldGeneration && generation !== oldGeneration)
      const oldItems = changed ? [] : archive.current
      const oldUsers = oldItems.filter(item => item.role === 'user').length
      const items = new Map(oldItems.map(item => [item.id, item]))
      const cursors = new Set<number>(before === undefined ? [] : [before])
      for (;;) {
        result.items.forEach(item => items.set(item.id, item))
        const users = [...items.values()].filter(item => item.role === 'user').length
        // Initial load needs a question; an upper-boundary navigation needs
        // one additional question, even if its answer spans many API pages.
        if (!result.has_more || result.next_before == null || (before === undefined ? users > 0 : users > oldUsers)) break
        const cursor = result.next_before
        if (cursors.has(cursor)) throw new Error('历史分页未能前进，请重试。')
        cursors.add(cursor)
        result = await api.getSessionMessages(sessionId, { limit: 60, before: cursor, signal: request.signal })
        if (request.signal.aborted) return
      }
      if (before !== undefined && result.has_more && result.next_before != null && cursors.has(result.next_before)) {
        throw new Error('历史分页未能前进，请重试。')
      }
      archive.current = [...items.values()]
      const history = [...archive.current].sort((a, b) => a.ordinal - b.ordinal).flatMap(item => historyToMessages([item]))
      // Latest-page refresh must not discard the cursor of pages already read.
      const nextPage = before === undefined && page.current && !changed
        ? { ...result, has_more: page.current.has_more, next_before: page.current.next_before }
        : result
      page.current = nextPage
      setHasMore(!!nextPage.has_more && nextPage.next_before != null)
      setMessages(old => {
        const ids = new Set(history.map(message => `${message.streamId}:${message.role}`))
        return [...history, ...(changed ? [] : old.filter(message => message.source !== 'history' && !ids.has(`${message.streamId}:${message.role}`)))]
      })
      if (changed) setSelected(null)
      return conversationSections(history, !!nextPage.has_more)
    } catch (e) {
      if (!request.signal.aborted) setError(errorMessageFromError(e))
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    if (!enabled) return
    void load()
    const socket = new ChatSocket(`/ws/sessions/${encodeURIComponent(sessionId)}`)
    socket.onMessage = event => {
      if (event.session_id && event.session_id !== sessionId) return
      if (event.type === 'resync_required' || event.type === 'rewound' || event.type === 'reset') {
        archive.current = []; page.current = null; setMessages([]); setSelected(null); setHasMore(false)
        void load(); return
      }
      setMessages(old => applyEvent(old, event))
      if (event.type === 'done' || (event.type === 'session_runtime' && event.status === 'idle')) void load()
    }
    socket.open()
    return () => { controller.current?.abort(); socket.close() }
  }, [enabled, sessionId, load])

  const sections = useMemo(() => conversationSections(messages, hasMore), [messages, hasMore])
  const found = selected === null ? -1 : sections.findIndex(section => section.id === selected)
  const index = found < 0 ? sections.length - 1 : found
  const section = sections[index]
  useEffect(() => { if (viewport.current) viewport.current.scrollTop = 0 }, [section?.id])

  async function previous() {
    if (loading || navigating.current) return
    if (index > 0) { setSelected(sections[index - 1].id); return }
    const cursor = page.current?.next_before
    if (!hasMore || cursor == null) return
    navigating.current = true
    try {
      const older = await load(cursor)
      if (!older) return
      const oldIndex = older.findIndex(item => item.id === section?.id)
      if (oldIndex > 0) setSelected(older[oldIndex - 1].id)
      else if (!section && older.length) setSelected(older.at(-1)!.id)
    } finally { navigating.current = false }
  }

  return <section className="overflow-hidden rounded-2xl border border-line" aria-label="对话分节">
    <nav aria-label="会话历史分节导航" className="flex items-center justify-between border-b border-line px-2 py-2">
      <button type="button" className={navigation} disabled={loading || (index <= 0 && !hasMore)} onClick={() => void previous()}><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /><span>上节</span></button>
      <span className="text-xs text-ink-faint">{section ? `${hasMore ? '… / ' : ''}${index + 1} / ${sections.length}` : '暂无对话'}</span>
      <button type="button" className={navigation} disabled={loading || index < 0 || index >= sections.length - 1} onClick={() => setSelected(index + 1 === sections.length - 1 ? null : sections[index + 1].id)}><span>下节</span><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
    </nav>
    {error && <div role="alert" className="flex items-center justify-between gap-3 px-5 py-3 text-xs text-status-danger"><span>{error}</span><button className={navigation} onClick={() => void load()}><RefreshIcon spinning={loading} size={12} /><span>重试</span></button></div>}
    <div ref={viewport} data-chat-scope className="max-h-[65vh] min-h-48 overflow-y-auto px-5 py-5 sm:px-6" aria-busy={loading}>
      {loading && <p role="status" className="mb-3 text-xs text-ink-faint">正在读取…</p>}
      {section ? <article data-chat-box className="min-w-0 space-y-6">
        <div><h3 data-chat-box-chrome className="mb-2 select-none text-xs font-medium text-ink-faint">问题</h3><div className="whitespace-pre-wrap break-words text-sm leading-relaxed">{section.question || '未记录问题'}</div></div>
        <div className="min-w-0 border-t border-line/60 pt-5"><h3 data-chat-box-chrome className="mb-3 select-none text-xs font-medium text-ink-faint">结论</h3><SectionConclusion answers={section.answers} /></div>
      </article> : !loading && <p className="py-16 text-center text-sm text-ink-faint">暂无会话历史</p>}
    </div>
  </section>
}
