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
//   • Hover-revealed "复制" button on assistant messages.

import clsx from 'clsx'
import { foldTurns } from '@/utils/foldTurns'
import { useCopy } from '@/utils/clipboard'
import { MarkdownView } from './MarkdownView'
import type { PasteAttachment } from './ImagePasteInput'
import { api } from '@/api/client'

interface Props {
  role: 'user' | 'assistant' | string
  content: string
  streaming?: boolean
  attachments?: PasteAttachment[]
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

export function MessageBubble({ role, content, streaming, attachments }: Props) {
  const isUser = role === 'user'
  if (isUser) {
    const cleaned = cleanUserContent(content)
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] flex flex-col items-end gap-2">
          {attachments && attachments.length > 0 && (
            <UserAttachments atts={attachments} />
          )}
          {cleaned && (
            <div className="rounded-2xl bg-accent text-white px-4 py-2.5 leading-7 whitespace-pre-wrap break-words shadow">
              {cleaned}
            </div>
          )}
        </div>
      </div>
    )
  }

  const segs = foldTurns(content)
  return (
    <div className="flex justify-start group/msg">
      <div className="max-w-[92%] relative rounded-2xl bg-bg-card border border-line px-4 py-3 shadow-sm">
        <CopyChip text={content} />
        {segs.map((seg, i) =>
          seg.type === 'fold' ? (
            <details key={i} className="turn-fold">
              <summary>{seg.title || '中间步骤'}</summary>
              <div><MarkdownView>{seg.content}</MarkdownView></div>
            </details>
          ) : (
            <div key={i} className={clsx(streaming && i === segs.length - 1 && 'cursor-blink')}>
              <MarkdownView>{seg.content}</MarkdownView>
            </div>
          ),
        )}
      </div>
    </div>
  )
}

function UserAttachments({ atts }: { atts: PasteAttachment[] }) {
  return (
    <div className="flex flex-wrap gap-2 justify-end">
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
                className="max-h-44 max-w-[14rem] rounded-xl border border-line object-cover shadow"
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
            className="px-3 py-2 rounded-xl border border-line bg-bg-card text-xs text-slate-300 hover:bg-white/5 inline-flex items-center gap-2 max-w-[16rem]"
          >
            <span>📎</span>
            <span className="truncate">{a.name}</span>
            {!!a.size && <span className="text-slate-500 shrink-0">{fmtSize(a.size)}</span>}
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
      className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded
                 bg-bg-soft/80 backdrop-blur border border-line text-slate-400
                 opacity-0 group-hover/msg:opacity-100 transition hover:text-slate-200"
    >
      {copied ? '✓ 已复制' : '复制'}
    </button>
  )
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}
