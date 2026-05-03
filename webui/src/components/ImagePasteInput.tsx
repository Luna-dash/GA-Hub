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
}

export function ImagePasteInput({
  text, onText, attachments, onAttachments, onSubmit,
  placeholder = '输入消息，可粘贴/拖放图片或文件…',
  disabled, acceptFiles = true,
}: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [composing, setComposing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(0)

  // auto-resize
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 240) + 'px'
  }, [text])

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
        'relative rounded-2xl border bg-bg-card transition',
        dragOver ? 'border-accent' : 'border-line',
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
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
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
            if (e.key === 'Enter' && !e.shiftKey && !composing && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!disabled) onSubmit()
            }
          }}
          className="flex-1 bg-transparent resize-none outline-none text-slate-200 placeholder:text-slate-500 px-2 py-1 max-h-60"
        />
        <label className="cursor-pointer text-slate-400 hover:text-slate-200 px-2 py-1.5 rounded-lg hover:bg-white/5 text-sm">
          📎
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => upload(Array.from(e.target.files || []))}
          />
        </label>
        <button
          onClick={onSubmit}
          disabled={disabled || (!text.trim() && attachments.length === 0)}
          className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm hover:brightness-110 disabled:opacity-40"
        >发送</button>
      </div>

      {uploading > 0 && (
        <div className="absolute -top-6 right-2 text-xs text-slate-400 bg-bg/80 backdrop-blur px-2 py-0.5 rounded">
          上传中 {uploading}…
        </div>
      )}
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 rounded-2xl border-2 border-dashed border-accent bg-accent/5 flex items-center justify-center text-accent text-sm">
          松开以上传
        </div>
      )}
    </div>
  )
}
