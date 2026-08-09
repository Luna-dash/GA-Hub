// MessageBubble — single chat bubble (user / assistant).
//
// Responsibilities:
//   • Render attachment thumbnails inside *user* bubbles (image preview +
//     non-image chips). Snapshot-restored bubbles have no `attachments`,
//     so we additionally strip `[用户发送文件: ...]` / `[FILE:...]` /
//     hint preamble lines from the visible text — those tokens are
//     prompt-engineering for the LLM, not for the human reader.
//   • Fold long assistant streams via foldTurns(). The last segment shows
//     a blinking caret while streaming.
//   • Fold / tool-trace segments render MarkdownView mode=plain (no math/hljs).
//   • Hover-revealed "复制" button on assistant messages.

import { memo, useEffect, useState } from 'react'
import clsx from 'clsx'
import { foldTurns } from '@/utils/foldTurns'
import { useCopy } from '@/utils/clipboard'
import { CHAT_FONT_SCALE_EVENT, getChatFontScale } from '@/utils/chatAppearance'
import { MarkdownView } from './MarkdownView'
import type { PasteAttachment } from './ImagePasteInput'
import { api } from '@/api/client'

interface Props {
  role: 'user' | 'assistant' | string
  content: string
  streaming?: boolean
  timestamp?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  attachments?: PasteAttachment[]
  /** Stream id of this turn — required to enable the rewind chip. */
  streamId?: string
  /** Rewind callback. When provided + streamId set, a "回退" chip appears. */
  onRewind?: (sid: string) => void
  /** Compact mode: hide role labels and reduce padding (for FeishuBot) */
  compact?: boolean
}

const FILE_HINT = 'If you need to show files to user, use [FILE:filepath] in your response.'

/** Strip prompt-engineering tokens from a user message before showing it. */
function cleanUserContent(s: string): string {
  if (!s) return ''
  let out = s
  // FILE_HINT preamble — plain string, drop it from the head if present
  if (out.startsWith(FILE_HINT)) {
    out = out.slice(FILE_HINT.length).replace(/^\s*\n+/, '')
  }
  return out
    .replace(/^\[?用户发送文件:[^\]\n]*\]?\s*$/gm, '')
    .replace(/\[FILE:[^\]\n]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatMessageTime(timestamp: number | null | undefined): string | null {
  if (timestamp === undefined) return null
  if (timestamp === null || !Number.isFinite(timestamp)) return '时间未知'
  const date = new Date(timestamp)
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === now.toDateString()) return time
  const day = date.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${day} ${time}`
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

export const MessageBubble = memo(function MessageBubble({ role, content, streaming, timestamp, startedAt, finishedAt, attachments, streamId, onRewind, compact }: Props) {
  const [fontScale, setFontScale] = useState(getChatFontScale)
  const [clock, setClock] = useState(Date.now)

  useEffect(() => {
    const sync = (event: Event) => setFontScale((event as CustomEvent<number>).detail || getChatFontScale())
    window.addEventListener(CHAT_FONT_SCALE_EVENT, sync)
    return () => window.removeEventListener(CHAT_FONT_SCALE_EVENT, sync)
  }, [])

  useEffect(() => {
    if (!streaming || !startedAt) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming, startedAt])

  const messageFontStyle = compact ? undefined : { fontSize: `${fontScale}%` }
  const isUser = role === 'user'
  const isSystem = role === 'system'
  const timeLabel = formatMessageTime(timestamp)

  if (isUser) {
    const cleaned = cleanUserContent(content)
    return (
      <div className="flex justify-start group/msg">
        <div className="max-w-[80%] flex items-end gap-1.5">
          <div className="min-w-0 flex flex-col items-start gap-2">
            {attachments && attachments.length > 0 && (
              <UserAttachments atts={attachments} />
            )}
            {cleaned && (
              <div
                className={clsx(
                  "rounded-lg bg-[#8A6438] text-[#FFF4DF] whitespace-pre-wrap break-words shadow-[0_2px_6px_rgba(45,34,22,0.16)] border border-[#6F4D28]",
                  compact ? "px-3 py-2 leading-6" : "px-3.5 py-2.5 leading-7"
                )}
                style={messageFontStyle}
              >
                {cleaned}
              </div>
            )}
          </div>
          {timeLabel && (
            <span className="mb-1 shrink-0 whitespace-nowrap text-[10px] leading-none text-[#8A7B65]">
              {timeLabel}
            </span>
          )}
        </div>
      </div>
    )
  }

  const segs = foldTurns(content)
  return (
    <div className="flex justify-start group/msg">
      <div className="max-w-full min-w-0 flex flex-col items-start gap-1.5">
        <div className={clsx(
          "min-w-0 max-w-full relative rounded-lg shadow-[0_2px_6px_rgba(45,34,22,0.13)]",
          compact ? "px-3 py-2 text-xs" : "px-3.5 py-3",
          isSystem
            ? "bg-[#E8D8B8] border border-[#B69761] text-[#3C2C19]"
            : "bg-bg-card border border-line text-[#2C2418]"
        )}>
          {isSystem && (
            <div className="absolute -top-2 -left-2 w-6 h-6 rounded-full bg-amber-400 flex items-center justify-center text-sm shadow">
              🟡
            </div>
          )}
          {!compact && (
            <div className={clsx("mb-2 flex items-center gap-2 text-[11px] font-medium", isSystem ? "text-[#7B5A2E]" : "text-[#665741]")}>
              <span className={clsx("h-1.5 w-1.5 rounded-full", isSystem ? "bg-[#A2783F]" : "bg-[#54735D]")} />
              {isSystem ? 'System Event' : 'GA Agent'}
            </div>
          )}
          <div className="absolute top-3 right-3 flex items-center gap-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
            {streamId && onRewind && !streaming && (
              <RewindChip onClick={() => onRewind(streamId)} />
            )}
            <CopyChip text={content} />
          </div>
          <div className="min-w-0 max-w-full" style={messageFontStyle}>
            {segs.map((seg, i) =>
              seg.type === 'fold' ? (
                <details key={i} className="turn-fold">
                  <summary>{seg.title || '中间步骤'}</summary>
                  {/* Intermediate turns are mostly tool dumps — no math / hljs. */}
                  <div><MarkdownView mode="plain">{seg.content}</MarkdownView></div>
                </details>
              ) : (
                <div key={i} className={clsx(streaming && i === segs.length - 1 && 'cursor-blink')}>
                  {/* Final segment: auto-detect tool-only tails vs real prose. */}
                  <MarkdownView mode="auto">{seg.content}</MarkdownView>
                </div>
              ),
            )}
          </div>
        </div>
        {(timeLabel || startedAt) && (
          <span className={clsx("shrink-0 whitespace-nowrap px-0.5 text-[10px] leading-4 tabular-nums", isSystem ? "text-[#8A6B3E]" : "text-[#8A7B65]")}>
            {timeLabel}
            {timeLabel && startedAt && ' · '}
            {startedAt && `${streaming ? '已运行' : '用时'} ${formatDuration(Math.max(0, (streaming ? clock : (finishedAt ?? timestamp ?? clock)) - startedAt))}`}
          </span>
        )}
      </div>
    </div>
  )
})

function UserAttachments({ atts }: { atts: PasteAttachment[] }) {
  return (
    <div className="flex flex-wrap gap-2 justify-start">
      {atts.map((a) => {
        // Prefer the local upload-result url; fall back to files-by-path for
        // restored snapshots where only the abs path is around.
        const src = a.preview || (a.path ? api.fileUrlByPath(a.path) : '')
        const isImg = a.mime?.startsWith('image/')
        if (isImg && src) {
          return (
            <a
              key={a.file_id}
              href={src}
              target="_blank"
              rel="noreferrer"
              title={a.name}
              className="block"
            >
              <img
                src={src}
                alt={a.name}
                className="max-h-44 max-w-[14rem] rounded-md border border-line object-cover shadow-sm"
              />
            </a>
          )
        }
        return (
          <a
            key={a.file_id}
            href={src || '#'}
            target="_blank"
            rel="noreferrer"
            title={a.name}
            className="px-3 py-2 rounded-md border border-line bg-bg-card text-xs text-[#2C2418] hover:bg-bg-soft inline-flex items-center gap-2 max-w-[16rem]"
          >
            <span>📎</span>
            <span className="truncate">{a.name}</span>
            {!!a.size && <span className="text-[#86775F] shrink-0">{fmtSize(a.size)}</span>}
          </a>
        )
      })}
    </div>
  )
}

function CopyChip({ text }: { text: string }) {
  const { copied, copy } = useCopy()
  if (!text?.trim()) return null
  return (
    <button
      onClick={() => copy(text)}
      title="复制完整回复"
      className="px-2.5 py-1 text-[11px] leading-none rounded-md
                 bg-bg-soft border border-line text-[#665741]
                 hover:text-[#2C2418] hover:bg-bg-card transition-colors"
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  )
}

function RewindChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="回退此轮对话（删除本轮提问与回复）"
      className="px-2.5 py-1 text-[11px] leading-none rounded-md
                 bg-bg-soft border border-line text-[#665741]
                 hover:text-accent hover:bg-bg-card transition-colors"
    >
      ↺ 回退
    </button>
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
