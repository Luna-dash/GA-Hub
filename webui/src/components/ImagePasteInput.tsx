// Image-paste / drag-drop / file-picker enabled textarea.
//
// Listens to onPaste & onDrop, uploads images via /api/upload, exposes the
// resulting list of attachments via `value`/`onChange`. Parent passes the
// text input separately. Pressing Enter (without Shift, while not composing)
// triggers onSubmit.

import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { api } from '@/api/client'
import type { UploadResult } from '@/api/types'

export interface PasteAttachment extends UploadResult {
  preview?: string
}

interface Props {
  text: string
  onText: (s: string) => void
  attachments: PasteAttachment[]
  onAttachments: (a: PasteAttachment[]) => void
  onSubmit: () => void
  placeholder?: string
  disabled?: boolean
  acceptFiles?: boolean
  /** Auto-focus the textarea when mounted. Default true so chat-style
   *  surfaces (LiveChat, WechatBot reply box) start ready-to-type. */
  autoFocus?: boolean
}

export function ImagePasteInput({
  text, onText, attachments, onAttachments, onSubmit,
  placeholder = '输入消息，可粘贴/拖放图片或文件…',
  disabled, acceptFiles = true, autoFocus = true,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  // IME guard: a state mirror keeps render in sync, but the source of truth
  // for the keydown handler is `composingRef` — state updates are batched
  // and the keydown can fire in the same tick as compositionend before the
  // re-render lands.
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  // macOS WKWebView + 中文输入法 occasionally fires keydown(Enter) AFTER
  // compositionend within the same microtask — at that point isComposing
  // is already false and `composing` state has flipped, so an Enter that
  // was meant to commit IME selection slips through and submits the half-
  // typed message. We record the last compositionend timestamp and reject
  // any Enter that lands within ~80ms of it.
  const lastCompEndRef = useRef(0)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [btwOpen, setBtwOpen] = useState(false)

  // auto-resize
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])

  // Auto-focus on mount + every time we re-enable. Mount focus matters
  // when the user navigates to /chat — pywebview/WKWebView may not have
  // promoted the window to key yet, so we also retry once a frame later.
  // The disabled→false trigger covers the case where the agent finishes
  // streaming: the textarea unlocks, and we want the cursor back so the
  // user can keep typing without clicking.
  const wasDisabled = useRef(disabled)
  useEffect(() => {
    if (!autoFocus) return
    const justReEnabled = wasDisabled.current && !disabled
    wasDisabled.current = !!disabled
    if (disabled) return
    const el = taRef.current
    if (!el) return
    el.focus()
    // Initial mount + re-enable both deserve the rAF retry; cheap.
    const r = requestAnimationFrame(() => el.focus())
    if (justReEnabled) {
      // Place caret at the end so re-focus doesn't lose typing position.
      const len = el.value.length
      try { el.setSelectionRange(len, len) } catch {}
    }
    return () => cancelAnimationFrame(r)
  }, [disabled, autoFocus])

  const upload = async (files: File[]) => {
    if (!files.length) return
    setUploading((n) => n + files.length)
    try {
      const results: PasteAttachment[] = []
      for (const f of files) {
        try {
          const r = await api.upload(f)
          const att: PasteAttachment = { ...r }
          if (r.mime.startsWith('image/')) att.preview = r.url
          results.push(att)
        } catch (e) {
          console.error('upload failed', e)
        }
      }
      onAttachments([...attachments, ...results])
    } finally {
      setUploading((n) => Math.max(0, n - files.length))
    }
  }

  return (
    <div
      className={clsx(
        'relative rounded-3xl border bg-bg-card/85 transition shadow-[0_18px_55px_rgba(2,6,23,0.22)] backdrop-blur-xl',
        dragOver ? 'border-accent ring-4 ring-accent/10' : 'border-line/80 hover:border-accent/25',
        disabled && 'opacity-60',
      )}
      onDragOver={(e) => {
        if (!acceptFiles) return
        e.preventDefault(); e.stopPropagation()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        if (!acceptFiles) return
        e.preventDefault(); e.stopPropagation()
        setDragOver(false)
        const files = Array.from(e.dataTransfer.files || [])
        if (files.length) upload(files)
      }}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 p-2 pb-0">
          {attachments.map((a) => (
            <div key={a.file_id} className="relative group">
              {a.preview ? (
                <img
                  src={a.preview}
                  alt={a.name}
                  className="h-20 w-20 object-cover rounded-lg border border-line"
                />
              ) : (
                <div className="h-20 w-20 rounded-lg border border-line bg-bg-soft flex items-center justify-center text-xs text-slate-400 px-2 text-center break-words">
                  📎 {a.name.slice(0, 18)}
                </div>
              )}
              <button
                onClick={() => onAttachments(attachments.filter((x) => x.file_id !== a.file_id))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-bg border border-line text-slate-300 hover:text-rose-400 hover:border-rose-400 text-xs leading-none"
                aria-label="remove"
              >×</button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 p-2">
        <textarea
          ref={taRef}
          value={text}
          disabled={disabled}
          rows={1}
          placeholder={placeholder}
          onChange={(e) => onText(e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true
            setComposing(true)
          }}
          onCompositionEnd={() => {
            composingRef.current = false
            lastCompEndRef.current = Date.now()
            setComposing(false)
          }}
          onPaste={(e) => {
            const items = Array.from(e.clipboardData.items || [])
            const files: File[] = []
            for (const it of items) {
              if (it.kind === 'file') {
                const f = it.getAsFile()
                if (f) files.push(f)
              }
            }
            if (files.length) {
              e.preventDefault()
              upload(files)
            }
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return
            // Belt-and-braces IME guard. Any of these means "this Enter is
            // for IME selection, not for submitting":
            //   • React state says we're composing
            //   • ref mirror says we're composing (state hasn't flushed)
            //   • DOM-level isComposing flag (most reliable on Chromium)
            //   • Safari/WKWebView quirk: keyCode 229 indicates IME
            //   • we just exited composition — racing keydown sneaks through
            const isImeEnter =
              composing
              || composingRef.current
              || e.nativeEvent.isComposing
              || e.keyCode === 229
              || (Date.now() - lastCompEndRef.current < 80)
            if (isImeEnter) return  // let textarea consume Enter normally
            e.preventDefault()
            if (!disabled) onSubmit()
          }}
          className="flex-1 bg-transparent resize-none outline-none text-slate-200 placeholder:text-slate-500 px-3 py-2 max-h-60 leading-7"
        />
        <label className="cursor-pointer text-slate-400 hover:text-slate-200 px-3 py-2 rounded-xl hover:bg-white/5 text-sm transition">
          📎
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => upload(Array.from(e.target.files || []))}
          />
        </label>
        <button
          type="button"
          onClick={() => setBtwOpen(true)}
          className="px-3 py-2 rounded-xl border border-amber-500/30 bg-amber-500/15 text-amber-200 text-[13px] font-medium hover:bg-amber-500/25 transition"
          title="BTW 旁路提问，不打断主任务"
        >BTW</button>
        <button
          onClick={onSubmit}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          className="px-4 py-2 rounded-xl bg-accent text-white text-sm font-medium shadow-lg shadow-accent/20 hover:brightness-110 disabled:opacity-40 disabled:shadow-none transition"
        >发送</button>
      </div>

      {btwOpen && <BtwDialog onClose={() => setBtwOpen(false)} />}

      {uploading > 0 && (
        <div className="absolute -top-6 right-2 text-xs text-slate-400 bg-bg/80 backdrop-blur px-2 py-0.5 rounded">
          上传中 {uploading}…
        </div>
      )}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 rounded-3xl border-2 border-dashed border-accent bg-accent/5 flex items-center justify-center text-accent text-sm">
          松开以上传
        </div>
      )}
    </div>
  )
}

interface BtwTurn {
  id: number
  q: string
  a?: string
  error?: string
}

function BtwDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [turns, setTurns] = useState<BtwTurn[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [])

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, textarea')) return
    setDragging(true)
    setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y })
  }

  useEffect(() => {
    if (!dragging) return
    const handleMouseMove = (e: MouseEvent) => {
      setPosition({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y })
    }
    const handleMouseUp = () => setDragging(false)
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging, dragStart])

  const ask = async () => {
    const q = text.trim()
    if (!q || loading) return
    const id = Date.now()
    setTurns((xs) => [...xs, { id, q }])
    setText('')
    setLoading(true)
    try {
      const r = await api.btw(q)
      setTurns((xs) => xs.map((x) => x.id === id ? { ...x, a: r.ok ? r.content : '', error: r.ok ? '' : (r.error || 'BTW 请求失败') } : x))
    } catch (e: any) {
      setTurns((xs) => xs.map((x) => x.id === id ? { ...x, error: e?.message || String(e) } : x))
    } finally {
      setLoading(false)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }

  return (
    <div
      ref={dialogRef}
      onMouseDown={handleMouseDown}
      style={{
        transform: `translate(${position.x}px, ${position.y}px)`,
        cursor: dragging ? 'grabbing' : 'grab'
      }}
      className="absolute bottom-full right-2 z-30 mb-2 w-[min(520px,calc(100vw-2rem))] rounded-2xl border border-amber-600/40 bg-amber-600/25 backdrop-blur-sm shadow-2xl shadow-black/40 overflow-hidden">
      <div className="flex items-center justify-between border-b border-amber-600/30 px-3 py-2 bg-amber-600/20">
        <div>
          <div className="text-sm font-medium text-amber-950">BTW 旁路提问</div>
          <div className="text-[11px] text-amber-900/70">不打断主任务，答案只显示在这个小窗里</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="h-7 w-7 rounded-lg text-slate-300 hover:bg-white/10 hover:text-white"
          aria-label="关闭 BTW"
        >×</button>
      </div>

      <div className="max-h-80 overflow-y-auto p-3 space-y-3 text-sm">
        {turns.length === 0 && (
          <div className="text-xs text-slate-400 leading-relaxed">
            可以问：当前做到哪一步？为什么要这样做？有没有风险？
          </div>
        )}
        {turns.map((t) => (
          <div key={t.id} className="space-y-2">
            <div className="ml-auto max-w-[85%] rounded-xl bg-amber-400/15 border border-amber-400/20 px-3 py-2 text-amber-950 whitespace-pre-wrap break-words">
              {t.q}
            </div>
            <div className="max-w-[92%] rounded-xl bg-bg-soft border border-line px-3 py-2 text-slate-200 whitespace-pre-wrap break-words">
              {t.error ? <span className="text-rose-300">{t.error}</span> : (t.a ?? '思考中…')}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-line p-2 flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={text}
          rows={2}
          disabled={loading}
          placeholder="输入旁路问题…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              ask()
            }
          }}
          className="flex-1 resize-none rounded-xl border border-line bg-bg px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-600 focus:border-amber-400/50 disabled:opacity-60"
        />
        <button
          type="button"
          onClick={ask}
          disabled={loading || !text.trim()}
          className="px-3 py-2 rounded-xl bg-amber-500 text-slate-950 text-sm font-medium hover:brightness-110 disabled:opacity-40"
        >提问</button>
      </div>
    </div>
  )
}

