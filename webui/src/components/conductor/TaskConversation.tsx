// TaskConversation — the conversation panel: the message transcript plus the
// composer. Owns the scroll-follow machinery (restore remembered position,
// follow the live edge only while the reader is at the bottom); the refs are
// owned by the page because the data hook also consults the scroll position
// right before a background refetch.
import { useLayoutEffect, useEffect, useRef } from 'react'
import { ArrowUp, MessageSquare, Plus } from 'lucide-react'
import { MessageContent } from '@/components/MessageContent'
import { collapseBlankLines, isNearScrollBottom } from './presentation'

type ChatMessage = { id: string; role: string; msg: string }

/** Reading-position memory across route unmount/remount (module scope on
 *  purpose: it must outlive the page component without hitting storage). */
const scrollMemory: { chatTop: number | null } = { chatTop: null }

export function TaskConversation({ messages, isLoading, isError, onRetry, followRef, scrollRef, endRef, userMsg, onUserMsgChange, onSubmit, appendMode, llmReady, sending, focusSignal }: {
  messages: ChatMessage[]
  isLoading: boolean
  isError: boolean
  onRetry: () => void
  followRef: { current: boolean }
  scrollRef: { current: HTMLDivElement | null }
  endRef: { current: HTMLDivElement | null }
  userMsg: string
  onUserMsgChange: (value: string) => void
  /** Submit the composer; `null` targets a brand-new task. */
  onSubmit: (targetRequestId: string | null) => void
  appendMode: boolean
  llmReady: boolean
  sending: boolean
  /** Increment to move focus into the composer (retry prefill). */
  focusSignal: number
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const restoredRef = useRef(false)

  // Retry prefill asks for the composer.
  useEffect(() => {
    if (focusSignal) inputRef.current?.focus()
  }, [focusSignal])

  // Restore the remembered reading position (or open at the live edge) once
  // the first messages are on screen.
  useEffect(() => {
    const el = scrollRef.current
    if (restoredRef.current || !el || messages.length === 0) return
    const frame = requestAnimationFrame(() => {
      const rememberedTop = scrollMemory.chatTop
      el.scrollTop = rememberedTop === null
        ? el.scrollHeight
        : Math.min(rememberedTop, el.scrollHeight)
      followRef.current = isNearScrollBottom(el)
      restoredRef.current = true
    })
    return () => cancelAnimationFrame(frame)
    // Fires once per mount, on the first batch of messages.
  }, [messages.length])

  // Auto-scroll only while the reader is already at the live edge.
  useEffect(() => {
    if (followRef.current) {
      // Instant scrolling avoids a smooth-scroll/onScroll feedback loop that
      // could silently disable live following while messages stream in.
      endRef.current?.scrollIntoView({ behavior: 'auto' })
    }
  }, [messages])

  // Save the reading position for the next mount of this page.
  useEffect(() => () => {
    if (restoredRef.current) {
      scrollMemory.chatTop = scrollRef.current?.scrollTop ?? scrollMemory.chatTop
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount only
  }, [])

  // Composer grows from one row as the draft fills; hard cap keeps the
  // composer from eating the transcript.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [userMsg])

  const canSend = Boolean(userMsg.trim()) && llmReady && !sending

  return (
    <section aria-label="任务对话" className="conductor-main-chat">
      <div
        ref={scrollRef}
        onScroll={() => {
          followRef.current = isNearScrollBottom(scrollRef.current)
          scrollMemory.chatTop = scrollRef.current?.scrollTop ?? scrollMemory.chatTop
        }}
        className="min-h-0 flex-1 overflow-y-auto divide-y divide-line text-sm"
      >
        {isLoading && messages.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-ink-muted">正在加载 Conductor 历史…</div>
        )}
        {isError && messages.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-sm text-status-danger">历史暂时无法加载，Conductor 引擎可能未连接。</p>
            <button type="button" className="ga-btn mt-3" onClick={onRetry}>重试</button>
          </div>
        )}
        {!isLoading && !isError && messages.length === 0 && (
          <div className="conductor-empty"><MessageSquare size={28} strokeWidth={1.4} /><p>暂无对话</p></div>
        )}
        {messages.map((msg) => (
          msg.role === 'user' ? (
            <div key={msg.id} className="px-4 py-1.5">
              {/* The chat is one work log, not a two-sided messenger: a
                  prompt is a full-width block told apart by its background
                  alone — no right-alignment, no width cap, no role gutter.
                  A prompt is also literal text: emoji, paths and
                  angle-bracket tokens must survive verbatim, so no
                  markdown pipeline; only the blank-line runs of a pasted
                  block collapse. */}
              <div className="rounded-md bg-accent-soft px-3 py-1.5 text-sm leading-[1.45] [overflow-wrap:anywhere]">
                <MessageContent content={collapseBlankLines(msg.msg)} format="text" />
              </div>
            </div>
          ) : (
            <div key={msg.id} className="px-4 py-1.5">
              <div className="min-w-0 text-sm leading-[1.45] text-ink">
                <MessageContent content={msg.msg} format="markdown" markdownMode="plain" />
              </div>
            </div>
          )
        ))}
        <div ref={endRef} />
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit(appendMode ? 'append' : 'new')
        }}
        className="border-t border-line bg-bg-soft/75 px-3 py-2"
      >
        {appendMode && (
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="truncate text-xs text-ink-muted">
              当前任务
            </span>
            <button
              type="button"
              onClick={() => onSubmit('new')}
              disabled={!userMsg.trim() || !llmReady || sending}
              className="ga-btn shrink-0 px-2.5 py-1 text-xs"
              title="忽略当前任务，另开一个新任务"
            >
              <Plus size={13} />新任务
            </button>
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            aria-label="任务内容"
            ref={inputRef}
            value={userMsg}
            onChange={(e) => onUserMsgChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }}
            rows={1}
            wrap="soft"
            placeholder={appendMode ? '将作为补充发送给当前任务…' : '描述一个新任务…'}
            className="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words rounded border border-line bg-bg px-3 py-2 text-sm leading-[1.45] text-ink placeholder:text-ink-faint [overflow-wrap:anywhere] focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={!canSend}
            aria-label={sending ? '发送中' : (appendMode ? '发送补充' : '发送')}
            title={appendMode ? '发送补充' : '发送任务'}
            className="conductor-send-button"
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </form>
    </section>
  )
}
