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

import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import clsx from 'clsx'
import {
  parseAssistantTranscript,
  renderAskUserPayload,
  type AssistantTranscript,
  type AssistantTranscriptTurn,
} from '@/utils/assistantTranscript'
import { foldTurns } from '@/utils/foldTurns'
import { useCopy } from '@/utils/clipboard'
import { CHAT_FONT_SCALE_EVENT, getChatFontScale } from '@/utils/chatAppearance'
import { FILE_HINT } from '@/utils/sessionPrompt'
import { MessageContent } from './MessageContent'
import { AskUserCard } from './AskUserCard'
import { bubbleTone } from './bubbleTone'
import type { PasteAttachment } from '@/api/types'
import { api } from '@/api/client'

interface Props {
  role: 'user' | 'assistant' | string
  content: string
  streaming?: boolean
  /** 事实标志：这条流被用户手动停止（来自 aborted 事件，客户端内存态）。
   *  与投影层的悬空尾启发式（transcript.stopped）相互独立。 */
  stopped?: boolean
  /** 来源标签（自动继续/定时任务等）：渲染为头部小字，不混入 content。 */
  recoveryNotice?: string
  tagLabel?: string
  timestamp?: number | null
  startedAt?: number | null
  finishedAt?: number | null
  attachments?: PasteAttachment[]
  /** Stream id of this turn — required to enable the rewind chip. */
  streamId?: string
  /** Rewind callback. When provided + streamId set, a "回退" chip appears. */
  onRewind?: (sid: string) => void
  /** Compact mode: hide role labels and reduce padding (rail/compact surfaces) */
  compact?: boolean
  /** Draft-store key (e.g. `liveChat:<id>`) that AskUserCard fills on pick. */
  askUserDraftKey?: string
  /** false = 该消息不是会话末条：卡片降级为归档展示（不可点选）。 */
  askUserInteractive?: boolean
}

const LONG_HISTORY_THRESHOLD = 60_000
const LONG_HISTORY_PREVIEW_CHARS = 20_000

/** 最后一条有效 summary（空白视为无效）。 */
function lastValidSummary(turns: AssistantTranscriptTurn[]): string {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const text = (turns[i].summary || '').trim()
    if (text) return text
  }
  return ''
}

/** 结论区正文（渲染与复制共用）。尾部为悬空工具轮（被停止截断/轮询任务/进程重启同形）
 *  时不再回落"上一轮的完整正文"（实测 34/41 条拿到的都是工具转储），改用最后一条
 *  有效 summary；一条都没有则正文留空。带交互卡片的结论不回落摘要（问题由卡片承载）。 */
function projectConclusionBody(transcript: AssistantTranscript): string {
  const summaryBody = transcript.finalAskUser ? '' : lastValidSummary(transcript.turns)
  return transcript.stopped ? summaryBody : transcript.finalBody || summaryBody
}

/** 复制专用：剥离摘要标签块（含中断留下的未闭合尾巴）。
 *  闭合序列用拼接书写，避免被补丁/传输链吞掉。 */
function stripSummaryBlocks(text: string): string {
  const closeToken = '<' + '/summary>'
  let out = text
  for (let guard = 0; guard < 50; guard += 1) {
    const openIdx = out.indexOf('<summary')
    if (openIdx < 0) break
    const gtIdx = out.indexOf('>', openIdx)
    if (gtIdx < 0) {
      out = out.slice(0, openIdx)
      break
    }
    const closeIdx = out.indexOf(closeToken, gtIdx)
    if (closeIdx < 0) {
      out = out.slice(0, openIdx)
      break
    }
    out = out.slice(0, openIdx) + out.slice(closeIdx + closeToken.length)
  }
  return out.trim()
}

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

export const MessageBubble = memo(function MessageBubble({ role, content, streaming, stopped, recoveryNotice, tagLabel, timestamp, startedAt, finishedAt, attachments, streamId, onRewind, compact, askUserDraftKey, askUserInteractive = true }: Props) {
  const [fontScale, setFontScale] = useState(getChatFontScale)
  const [clock, setClock] = useState(Date.now)
  const [longFinalExpanded, setLongFinalExpanded] = useState(false)

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

  // fontSize 缩放普通文本；--chat-scale 供 CSS 里 rem 字号规则（标题/表格/
  // 代码块/折叠头）做 calc 同步缩放，见 index.css 的 prose-chat 区块注释。
  const messageFontStyle = compact
    ? undefined
    : { fontSize: `${fontScale}%`, '--chat-scale': fontScale / 100 } as CSSProperties
  const isUser = role === 'user'
  const isSystem = role === 'system'
  const tone = bubbleTone(role)
  const timeLabel = formatMessageTime(timestamp)
  const shouldProjectTranscript = Boolean(
    role === 'assistant'
    && !compact
    && !streaming,
  )
  const historyTranscript = useMemo(
    () => shouldProjectTranscript ? parseAssistantTranscript(content) : null,
    [content, shouldProjectTranscript],
  )
  const useHistoryProjection = Boolean(
    historyTranscript
    && (content.length > LONG_HISTORY_THRESHOLD || historyTranscript.turns.length > 0),
  )
  // 复制按钮只带结论段：正常任务=最终结论；中断任务=最后一条有效摘要（结论缺失时的兜底）。
  // 两者都取不到 → 空串（chip 自隐），绝不回退原始转储/带摘要标记的全文。
  const copySource = useMemo(() => {
    if (role !== 'assistant') return content
    if (useHistoryProjection && historyTranscript) {
      if (historyTranscript.finalAskUser) return renderAskUserPayload(historyTranscript.finalAskUser)
      return stripSummaryBlocks(projectConclusionBody(historyTranscript))
    }
    const answerSeg = [...foldTurns(content)].reverse().find((seg) => seg.type === 'text')
    return stripSummaryBlocks(answerSeg?.content || '')
  }, [role, content, useHistoryProjection, historyTranscript])

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
                  "rounded-lg shadow-[0_2px_6px_rgba(45,34,22,0.16)]",
                  tone.surfaceClass,
                  compact ? "px-3 py-2 leading-6" : "px-3.5 py-2.5 leading-7"
                )}
                style={messageFontStyle}
              >
                <MessageContent content={cleaned} format="text" />
              </div>
            )}
          </div>
          {timeLabel && (
            <span className="mb-1 shrink-0 whitespace-nowrap text-[10px] leading-none text-ink-faint">
              {timeLabel}
            </span>
          )}
        </div>
      </div>
    )
  }

  const segs = useHistoryProjection ? [] : foldTurns(content)
  return (
    <div className="flex justify-start group/msg">
      <div className="max-w-full min-w-0 flex flex-col items-start gap-1.5">
        <div className={clsx(
          "min-w-0 max-w-full relative rounded-lg shadow-[0_2px_6px_rgba(45,34,22,0.13)]",
          compact ? "px-3 py-2 text-xs" : "px-3.5 py-3",
          tone.surfaceClass
        )}>
          {/* 2026-09 user ruling: the concentric dot straddling the left border
              is the sole system marker — the in-bubble "• system" header row
              duplicated it and was removed. Pure CSS discs (no emoji) so the
              circles stay concentric. */}
          {isSystem && (
            <div
              data-system-dot
              className="absolute top-1/2 -left-2.5 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-status-warning shadow"
            >
              <span className="block h-2.5 w-2.5 rounded-full bg-status-warning-soft" />
            </div>
          )}
          {!compact && !isSystem && (
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-ink-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-[#54735D]" />
              GA Agent
            </div>
          )}
          {tagLabel && (
            <div className="mb-1.5 text-[11px] font-medium leading-4 text-ink-faint">{tagLabel}</div>
          )}
          {role === 'assistant' && recoveryNotice && (
            <div data-recovery-notice className="mb-2 flex items-center gap-2 text-xs leading-5 text-status-warning-muted">
              <span className="shrink-0 rounded border border-current px-1 text-[10px]">系统</span>
              <span>{recoveryNotice}</span>
            </div>
          )}
          <div className="absolute top-3 right-3 flex items-center gap-2 opacity-0 group-hover/msg:opacity-100 transition-opacity">
            {streamId && onRewind && !streaming && (
              <RewindChip onClick={() => onRewind(streamId)} />
            )}
            <CopyChip text={copySource} />
          </div>
          <div className="min-w-0 max-w-full" style={messageFontStyle}>
            {useHistoryProjection && historyTranscript ? (
              <HistoryTranscriptReply
                transcript={historyTranscript}
                rawContent={content}
                manualStop={Boolean(stopped)}
                finalExpanded={longFinalExpanded}
                onExpandFinal={() => setLongFinalExpanded(true)}
                askUserDraftKey={askUserDraftKey}
                askUserInteractive={askUserInteractive}
              />
            ) : segs.map((seg, i) =>
              seg.type === 'fold' ? (
                <LazyMarkdownFold
                  key={i}
                  title={seg.title || '中间步骤'}
                  content={seg.content}
                  cache={!streaming}
                />
              ) : (
                <div key={i} className={clsx(streaming && i === segs.length - 1 && 'cursor-blink')}>
                  {/* Final segment: auto-detect tool-only tails vs real prose. */}
                  <MessageContent content={seg.content} format="markdown" cache={!streaming} />
                </div>
              ),
            )}
          </div>
          {stopped && !useHistoryProjection && (
            <p className="mt-2 text-xs italic leading-5 text-status-warning-muted">⏹任务中止</p>
          )}
        </div>
        {(timeLabel || startedAt) && (
          <span className={clsx("shrink-0 whitespace-nowrap px-0.5 text-[10px] leading-4 tabular-nums", isSystem ? "text-status-warning-muted" : "text-ink-faint")}>
            {timeLabel}
            {timeLabel && startedAt && ' · '}
            {startedAt && `${streaming ? '已运行' : '用时'} ${formatDuration(Math.max(0, (streaming ? clock : (finishedAt ?? timestamp ?? clock)) - startedAt))}`}
          </span>
        )}
      </div>
    </div>
  )
})

function HistoryTranscriptReply({
  transcript,
  rawContent,
  manualStop,
  finalExpanded,
  onExpandFinal,
  askUserDraftKey,
  askUserInteractive,
}: {
  transcript: AssistantTranscript
  rawContent: string
  manualStop: boolean
  finalExpanded: boolean
  onExpandFinal: () => void
  askUserDraftKey?: string
  askUserInteractive: boolean
}) {
  // 停止态统一呈现：正文=最后一条有效 summary（见 projectConclusionBody），不再回落
  // "上一轮的完整正文"；提示行统一"⏹任务中止"并置于最后，与停止事实是否留存无关。
  const stoppedState = manualStop || transcript.stopped
  const finalBody = projectConclusionBody(transcript)
  const finalDeferred = finalBody.length > LONG_HISTORY_THRESHOLD && !finalExpanded
  const visibleFinal = finalDeferred
    ? `${finalBody.slice(0, LONG_HISTORY_PREVIEW_CHARS)}…`
    : finalBody
  const processTurns = transcript.turns
    .filter((_, index) => index !== transcript.finalTurnIndex)
  const visibleProcessTurns = processTurns.length > 0
    ? processTurns
    : finalBody || transcript.finalAskUser
      ? []
      : [{ turn: 1, summary: '原始执行记录', content: rawContent }]
  // 停止的两个来源——manualStop（abort 事实）与 transcript.stopped（悬空尾启发式）——
  // 共用同一条提示行；呈现与"是否还能拿到停止事实"无关，当场与事后一致。

  return (
    <>
      {visibleProcessTurns.length > 0 && <LazyProcessFold turns={visibleProcessTurns} />}
      {visibleFinal ? (
        <MessageContent content={visibleFinal} format="markdown" />
      ) : stoppedState || transcript.finalAskUser ? null : (
        <p className="text-sm leading-6 text-ink-muted">该条历史回复未包含可提取的最终回答。</p>
      )}
      {transcript.finalAskUser && (
        <AskUserCard
          question={transcript.finalAskUser.question}
          candidates={transcript.finalAskUser.candidates}
          draftKey={askUserDraftKey}
          interactive={askUserInteractive}
        />
      )}
      {finalDeferred && (
        <button
          type="button"
          onClick={onExpandFinal}
          className="mt-3 rounded-md border border-line bg-bg-soft px-3 py-1.5 text-xs text-ink-muted transition-colors hover:bg-bg-card hover:text-ink"
        >
          最终回答较长，展开完整内容
        </button>
      )}
      {stoppedState && (
        <p className="mt-2 text-xs italic leading-5 text-status-warning-muted">⏹任务中止</p>
      )}
    </>
  )
}

function LazyProcessFold({ turns }: { turns: AssistantTranscriptTurn[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-3 border-b border-line/70 pb-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center gap-2 rounded-md border border-line bg-bg-soft px-3 py-2 text-left text-xs font-medium text-ink-muted transition-colors hover:bg-bg-card hover:text-ink"
      >
        <span aria-hidden="true" className={clsx('inline-block transition-transform', open && 'rotate-90')}>›</span>
        <span>{open ? '收起执行过程' : '查看执行过程'}</span>
        <span className="ml-auto shrink-0 tabular-nums text-ink-faint">共 {turns.length} 个 Turn</span>
      </button>
      {open && (
        <div className="mt-1 divide-y divide-line/70 border-t border-line/70">
          {turns.map((turn, index) => (
            <LazyTranscriptTurn key={`${turn.turn}:${index}`} turn={turn} />
          ))}
        </div>
      )}
    </div>
  )
}

function LazyTranscriptTurn({ turn }: { turn: AssistantTranscriptTurn }) {
  const [open, setOpen] = useState(false)
  const title = turn.summary || '执行记录'
  if (!turn.content.trim()) {
    return (
      <div className="flex min-w-0 gap-2 py-2 text-xs leading-5 text-ink-muted">
        <span className="shrink-0 font-medium text-ink-faint">Turn {turn.turn}</span>
        <span className="min-w-0 break-words">{title}</span>
      </div>
    )
  }
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-start gap-2 py-2 text-xs leading-5 text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
        <span aria-hidden="true" className={clsx('mt-0.5 inline-block transition-transform', open && 'rotate-90')}>›</span>
        <span className="shrink-0 font-medium text-ink-faint">Turn {turn.turn}</span>
        <span className="min-w-0 break-words">{title}</span>
      </summary>
      {open && (
        <div className="pb-3 pl-5">
          <MessageContent content={turn.content} format="markdown" markdownMode="plain" />
        </div>
      )}
    </details>
  )
}

function LazyMarkdownFold({ title, content, cache }: { title: string; content: string; cache: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <details className="turn-fold" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && <div><MessageContent content={content} format="markdown" markdownMode="plain" cache={cache} /></div>}
    </details>
  )
}

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
            className="px-3 py-2 rounded-md border border-line bg-bg-card text-xs text-ink hover:bg-bg-soft inline-flex items-center gap-2 max-w-[16rem]"
          >
            <span>📎</span>
            <span className="truncate">{a.name}</span>
            {!!a.size && <span className="text-ink-faint shrink-0">{fmtSize(a.size)}</span>}
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
      title="复制结论"
      className="px-2.5 py-1 text-[11px] leading-none rounded-md
                 bg-bg-soft border border-line text-ink-muted
                 hover:text-ink hover:bg-bg-card transition-colors"
    >
      {copied ? '✓ 已复制' : '⧉ 复制'}
    </button>
  )
}

function RewindChip({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="回退此轮对话（删除本轮提问与回复）"
      className="px-2.5 py-1 text-[11px] leading-none rounded-md
                 bg-bg-soft border border-line text-ink-muted
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
