// Image-paste / drag-drop / file-picker enabled textarea.
//
// Desktop actions reference original paths; browser/blob inputs use /api/upload, exposing the
// resulting list of attachments via `value`/`onChange`. Parent passes the
// text input separately. Pressing Enter (without Shift, while not composing)
// triggers onSubmit.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { LoaderCircle, RotateCw, X } from 'lucide-react'
import { api } from '@/api/client'
import { AttachmentImage, isImageAttachment } from './AttachmentImage'
import type { PasteAttachment, UploadResult } from '@/api/types'
import { canReferenceLocalFiles, selectAttachmentPaths, clipboardAttachmentPaths, referenceAttachments } from '@/utils/desktop'
import { errorMessageFromError } from '@/utils/sessionUi'
import {
  filterSlashCommands,
  handleSlashMenuKey,
  type SlashCommand,
} from '@/components/slashCommands'

const MAX_ATTACHMENTS = 256
const ATTACHMENT_LIMIT_HINT = `一次最多添加${MAX_ATTACHMENTS}个附件，请移除多余附件后重试`

interface Props {
  text: string
  onText: (s: string) => void
  attachments: PasteAttachment[]
  onAttachments: (a: PasteAttachment[]) => void
  onSubmit: () => void
  onSchedule?: () => void
  onStop?: () => void
  stopActive?: boolean
  /** Session runtime used by /btw. Omit on non-session chat surfaces. */
  btwSessionId?: string
  onSlashCommand?: (command: Exclude<SlashCommand['name'], '/btw'>) => void
  placeholder?: string
  disabled?: boolean
  submitDisabled?: boolean
  acceptFiles?: boolean
  /** Auto-focus the textarea when mounted. Default true so chat-style
   *  surfaces (LiveChat reply box) start ready-to-type. */
  autoFocus?: boolean
}

interface PendingUpload {
  id: number
  file: File
  preview?: string
  controller?: AbortController
  error?: string
}

export function ImagePasteInput({
  text, onText, attachments, onAttachments, onSubmit, onSchedule, onStop, stopActive = false, btwSessionId, onSlashCommand,
  placeholder = '输入消息，可粘贴/拖放图片或文件…',
  disabled, submitDisabled, acceptFiles = true, autoFocus = true,
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
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([])
  const pendingUploadsRef = useRef<PendingUpload[]>([])
  const nextUploadId = useRef(0)
  const [referenceBusy, setReferenceBusy] = useState(false)
  const [referenceError, setReferenceError] = useState<string>()
  const referenceBusyRef = useRef(false)
  const alive = useRef(true)
  const actionRef = useRef(0)
  const addPathsRef = useRef<(paths: string[]) => Promise<void>>(async () => {})
  const attachmentsOverLimit = attachments.length + pendingUploads.length > MAX_ATTACHMENTS
  const attachmentsBlocked = pendingUploads.length > 0 || referenceBusy || attachmentsOverLimit
  const attachmentHint = attachmentsOverLimit ? ATTACHMENT_LIMIT_HINT : pendingUploads.some((item) => item.error)
    ? '请重试或移除上传失败的附件'
    : attachmentsBlocked ? '请等待附件上传完成' : undefined
  const [btwOpen, setBtwOpen] = useState(false)
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [dismissedSlashText, setDismissedSlashText] = useState<string | null>(null)
  const slashCommands = onSlashCommand && dismissedSlashText !== text
    ? filterSlashCommands(text).filter((command) => command.name !== '/btw' || !!btwSessionId)
    : []

  useEffect(() => {
    setSlashActiveIndex(0)
  }, [text])

  useEffect(() => {
    if (!btwSessionId) setBtwOpen(false)
  }, [btwSessionId])

  const selectSlashCommand = (command: SlashCommand) => {
    setDismissedSlashText(null)
    setSlashActiveIndex(0)
    if (command.name === '/btw') {
      if (!btwSessionId) return
      onText('')
      setBtwOpen(true)
    } else {
      onSlashCommand?.(command.name)
    }
  }

  // Auto-resize the main chat textarea before paint so long input adds
  // visual rows (growing the composer upward) instead of briefly scrolling
  // horizontally or squeezing neighboring controls.
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

  // Auto-focus on mount + every time we re-enable. Mount focus matters
  // when the user navigates to /chat — the WebView may not have
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

  // Keep a live mirror of `attachments` so concurrent / rapid-fire uploads
  // (e.g. paste then drop before React re-renders) accumulate onto the latest
  // list instead of a stale closure value — otherwise the second upload would
  // overwrite the first batch.
  const attachmentsRef = useRef(attachments)
  useEffect(() => { attachmentsRef.current = attachments }, [attachments])

  const updatePending = (items: PendingUpload[]) => {
    pendingUploadsRef.current = items
    setPendingUploads(items)
  }

  const releaseUpload = (item: PendingUpload) => {
    item.controller?.abort()
    if (item.preview) URL.revokeObjectURL(item.preview)
  }

  useEffect(() => {
    alive.current = true
    return () => {
    alive.current = false
    actionRef.current++
    for (const item of pendingUploadsRef.current) {
      item.controller?.abort()
      if (item.preview) URL.revokeObjectURL(item.preview)
    }
    // Invalidate late completions even if the transport ignores abort.
    pendingUploadsRef.current = []
    }
  }, [])

  const removePending = (id: number) => {
    const item = pendingUploadsRef.current.find((entry) => entry.id === id)
    if (!item) return
    updatePending(pendingUploadsRef.current.filter((entry) => entry.id !== id))
    releaseUpload(item)
  }

  const removeAttachment = (id: string) => {
    const next = attachmentsRef.current.filter((item) => item.file_id !== id)
    attachmentsRef.current = next
    onAttachments(next)
  }

  const activeUploads = useRef(new Set<number>())
  const runUpload = async (item: PendingUpload) => {
    if (activeUploads.current.size >= 2 || activeUploads.current.has(item.id)) return
    activeUploads.current.add(item.id)
    const controller = new AbortController()
    updatePending(pendingUploadsRef.current.map((entry) => entry.id === item.id
      ? { ...entry, controller, error: undefined } : entry))
    try {
      const result = await api.upload(item.file, { signal: controller.signal })
      if (controller.signal.aborted || !pendingUploadsRef.current.some((entry) => entry.id === item.id)) return
      const attachment: PasteAttachment = {
        ...result,
        source: 'managed_upload',
        ...(result.mime.startsWith('image/') ? { preview: result.url } : {}),
      }
      const next = [...attachmentsRef.current, attachment]
      attachmentsRef.current = next
      onAttachments(next)
      removePending(item.id)
    } catch (error) {
      if (controller.signal.aborted || !alive.current) return
      updatePending(pendingUploadsRef.current.map((entry) => entry.id === item.id
        ? { ...entry, controller: undefined, error: errorMessageFromError(error, '上传失败') } : entry))
    } finally {
      activeUploads.current.delete(item.id)
      if (alive.current) {
        for (const next of pendingUploadsRef.current) {
          if (!next.controller && !next.error) void runUpload(next)
        }
      }
    }
  }

  // Include pending/failed uploads; refs close same-tick event races.
  const capacityExceeded = (additional: number) =>
    attachmentsRef.current.length + pendingUploadsRef.current.length + additional > MAX_ATTACHMENTS

  const upload = (files: File[]) => {
    if (disabled || !acceptFiles || !files.length) return
    if (capacityExceeded(files.length)) {
      setReferenceError(ATTACHMENT_LIMIT_HINT)
      return
    }
    setReferenceError(undefined)
    const added = files.map((file) => ({
      id: ++nextUploadId.current,
      file,
      preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
    }))
    updatePending([...pendingUploadsRef.current, ...added])
    for (const item of added) void runUpload(item)
  }

  const withReference = async (action: () => Promise<void>) => {
    if (disabled || !acceptFiles || referenceBusyRef.current) return
    referenceBusyRef.current = true
    setReferenceBusy(true)
    setReferenceError(undefined)
    try { await action() } catch (e) {
      if (alive.current) setReferenceError(errorMessageFromError(e, '文件引用失败'))
    } finally {
      referenceBusyRef.current = false
      if (alive.current) setReferenceBusy(false)
    }
  }
  const addPaths = async (paths: string[]) => {
    if (!paths.length) return
    const token = actionRef.current
    const items = await referenceAttachments(paths)
    if (!alive.current || token !== actionRef.current) return
    const next = [...attachmentsRef.current]
    for (const item of items) if (!next.some((a) => a.path === item.path)) next.push(item)
    // Recheck after async metadata lookup, deduplicating before counting.
    // Reject the whole batch instead of silently dropping selected files.
    if (next.length + pendingUploadsRef.current.length > MAX_ATTACHMENTS) {
      setReferenceError(ATTACHMENT_LIMIT_HINT)
      return
    }
    attachmentsRef.current = next
    onAttachments(next)
  }
  addPathsRef.current = async (paths) => withReference(() => addPaths(paths))
  useEffect(() => {
    if (!canReferenceLocalFiles() || !acceptFiles || disabled) return
    let disposed = false
    let stop: (() => void) | undefined
    void import('@tauri-apps/api/webviewWindow').then(async ({ getCurrentWebviewWindow }) => {
      const unlisten = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'drop' && taRef.current && document.hasFocus()) {
          const { x, y } = event.payload.position
          const bounds = taRef.current.closest('[data-file-composer]')?.getBoundingClientRect()
          const scale = window.devicePixelRatio || 1
          if (bounds && x / scale >= bounds.left && x / scale <= bounds.right && y / scale >= bounds.top && y / scale <= bounds.bottom) {
            void addPathsRef.current(event.payload.paths)
          }
        }
      })
      if (disposed) unlisten(); else stop = unlisten
    }).catch((e) => { if (!disposed) setReferenceError(errorMessageFromError(e, '文件拖放不可用')) })
    return () => { disposed = true; stop?.() }
  }, [acceptFiles, disabled])
  const pasteFiles = async (files: File[], clipboardVersion: number) => withReference(async () => {
    const paths = await clipboardAttachmentPaths()
    if (!alive.current || clipboardVersion !== actionRef.current) return
    if (paths.length) await addPaths(paths)
    else upload(files)
  })
  const submit = () => {
    if (!disabled && !submitDisabled && pendingUploadsRef.current.length === 0 && !referenceBusyRef.current && !capacityExceeded(0)
      && (text.trim() || attachmentsRef.current.length > 0)) onSubmit()
  }

  return (
    <div
      data-file-composer
      className={clsx(
        'relative rounded-xl bg-transparent transition-colors',
        dragOver ? 'bg-accent/10 ring-2 ring-accent/30' : '',
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
        if (!canReferenceLocalFiles() && files.length) upload(files)
      }}
    >
      {referenceBusy && <div role="status" className="px-3 pt-2 text-xs text-text-muted">正在读取文件引用…</div>}
      {referenceError && <div role="alert" className="px-3 pt-2 text-xs text-status-danger">{referenceError}<button type="button" onClick={() => setReferenceError(undefined)} className="ml-2">关闭</button></div>}
      {/* Align with the input: 4px row inset + 40px picker + 8px gap. */}
      {(attachments.length > 0 || attachmentsBlocked) && (
        <div className={clsx('flex flex-wrap items-start gap-1.5 pr-1 pt-2', acceptFiles ? 'pl-[3.25rem]' : 'pl-1')}>
          {attachments.map((a) => isImageAttachment(a) ? (
            <div
              key={a.file_id}
              className="group relative h-14 w-14 shrink-0"
              title={`${a.name} · ${a.source === 'local_ref' ? '本地引用' : '已保存'} · ${a.size} 字节\n${a.path}`}
              data-attachment-kind="image"
            >
              <AttachmentImage
                attachment={a}
                className="h-full w-full rounded-lg border border-line object-cover"
              />
              <button
                type="button"
                onClick={() => removeAttachment(a.file_id)}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border border-line bg-bg/90 text-xs leading-none text-slate-300 hover:border-status-danger-line hover:text-status-danger"
                aria-label={`移除 ${a.name}`}
              >×</button>
            </div>
          ) : (
            <div
              key={a.file_id}
              className="group relative inline-flex w-fit max-w-full items-center rounded-lg border border-line bg-bg-soft py-1.5 pl-2.5 pr-8"
              title={`${a.name} · ${a.source === 'local_ref' ? '本地引用' : '已保存'} · ${a.size} 字节\n${a.path}`}
              data-attachment-kind="file"
            >
              <span className="min-w-0 break-all text-xs leading-4 text-slate-200">{a.name}{a.source === 'local_ref' && <small className="ml-1 text-text-muted">本地引用</small>}</span>
              <button
                type="button"
                onClick={() => removeAttachment(a.file_id)}
                className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-xs leading-none text-slate-400 hover:text-status-danger"
                aria-label={`移除 ${a.name}`}
              >×</button>
            </div>
          ))}
          {pendingUploads.map((item) => (
            <div
              key={`upload-${item.id}`}
              data-upload-state={item.error ? 'failed' : 'uploading'}
              title={`${item.file.name}：${item.error ?? '上传中'}`}
              className={clsx('group relative', item.preview ? 'h-14 w-14 shrink-0' : 'inline-flex w-fit max-w-full items-center gap-1.5 rounded-lg border bg-bg-soft py-1.5 pl-2.5 pr-8', item.error ? 'border-status-danger-line' : 'border-line')}
            >
              {item.preview ? (
                <img src={item.preview} alt={item.file.name} className={clsx('h-full w-full rounded-lg border object-cover opacity-60', item.error ? 'border-status-danger-line' : 'border-line')} />
              ) : <span className="min-w-0 break-all text-xs leading-4 text-slate-200">{item.file.name}</span>}
              <span className={clsx('flex shrink-0 items-center text-xs', item.preview ? 'absolute bottom-0 left-0 right-0 justify-center rounded-b-lg bg-bg/90 py-0.5' : 'order-first', item.error ? 'text-status-danger' : 'text-slate-400')}>
                {item.error ? (
                  <button type="button" disabled={disabled} onClick={() => { void runUpload(item) }} aria-label={`重试 ${item.file.name}`} title={item.error} className="flex items-center gap-1 disabled:opacity-40">
                    <RotateCw className="h-3.5 w-3.5" /><span>重试</span>
                  </button>
                ) : <LoaderCircle aria-label="上传中" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
              </span>
              <button
                type="button"
                onClick={() => removePending(item.id)}
                disabled={disabled}
                aria-label={`移除 ${item.file.name}`}
                title={`移除 ${item.file.name}`}
                className={clsx('absolute flex h-5 w-5 items-center justify-center rounded-full bg-bg/90 text-slate-300 hover:text-status-danger disabled:opacity-40', item.preview ? 'right-1 top-1' : 'right-1.5 top-1/2 -translate-y-1/2')}
              ><X className="h-3 w-3" /></button>
            </div>
          ))}
        </div>
      )}
      {attachmentsBlocked && <span className={attachmentsOverLimit ? 'block px-3 text-xs text-status-danger' : 'sr-only'} role={attachmentsOverLimit || pendingUploads.some((item) => item.error) ? 'alert' : 'status'}>{attachmentHint}</span>}

      {slashCommands.length > 0 && (
        <div
          id="slash-command-menu"
          role="listbox"
          aria-label="快捷命令"
          className="absolute bottom-[calc(100%+0.5rem)] left-3 right-3 z-30 overflow-hidden rounded-2xl border border-line bg-bg-card p-1.5 shadow-[0_-8px_28px_rgba(54,42,28,0.22)]"
        >
          {slashCommands.map((command, index) => (
            <button
              key={command.name}
              id={`slash-command-${index}`}
              type="button"
              role="option"
              aria-selected={index === slashActiveIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSlashCommand(command)}
              onMouseEnter={() => setSlashActiveIndex(index)}
              className={clsx(
                'flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition',
                index === slashActiveIndex
                  ? 'bg-accent/15 text-slate-100'
                  : 'text-slate-300 hover:bg-white/5',
              )}
            >
              <span className="w-20 shrink-0 font-mono text-sm font-semibold text-accent">{command.name}</span>
              <span className="text-xs text-slate-400">{command.description}</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex items-end gap-2 p-1">
        {acceptFiles && (
          <label className="flex h-10 w-10 shrink-0 self-center cursor-pointer items-center justify-center rounded-xl text-2xl font-light leading-none text-accent hover:bg-accent/10 hover:text-accent transition" title="添加文件"
            onClick={(e) => {
              if (canReferenceLocalFiles()) {
                e.preventDefault()
                const token = actionRef.current
                void withReference(async () => {
                  const paths = await selectAttachmentPaths()
                  if (alive.current && token === actionRef.current) await addPaths(paths)
                })
              }
            }}>
            +
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => upload(Array.from(e.target.files || []))}
            />
          </label>
        )}
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
            if (disabled || !acceptFiles) return
            const items = Array.from(e.clipboardData.items || [])
            const files: File[] = []
            for (const it of items) {
              if (it.kind === 'file') {
                const f = it.getAsFile()
                if (f) files.push(f)
              }
            }
            if (canReferenceLocalFiles() && (files.length || e.clipboardData.types.includes('Files'))) {
              e.preventDefault()
              void pasteFiles(files, actionRef.current)
            } else if (files.length) {
              e.preventDefault()
              upload(files)
            }
          }}
          onKeyDown={(e) => {
            const isComposing = composing || composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229
            const isRecentImeEnter = e.key === 'Enter' && Date.now() - lastCompEndRef.current < 80
            if (isComposing || isRecentImeEnter) return

            const menuResult = handleSlashMenuKey(e.key, slashActiveIndex, slashCommands.length)
            if (menuResult.handled) {
              e.preventDefault()
              if (menuResult.close) {
                setDismissedSlashText(text)
              } else if (menuResult.selectIndex != null) {
                const command = slashCommands[menuResult.selectIndex]
                if (command) selectSlashCommand(command)
              } else {
                setSlashActiveIndex(menuResult.activeIndex)
              }
              return
            }

            if (e.key !== 'Enter' || e.shiftKey) return
            e.preventDefault()
            submit()
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={slashCommands.length > 0}
          aria-controls={slashCommands.length > 0 ? 'slash-command-menu' : undefined}
          aria-activedescendant={slashCommands.length > 0 ? `slash-command-${slashActiveIndex}` : undefined}
          wrap="soft"
          className="flex-1 min-w-0 w-0 bg-transparent resize-none outline-none text-slate-200 placeholder:text-slate-500 px-3 py-2 max-h-60 leading-7 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
        />
        {onSchedule && !stopActive && (
          <button
            type="button"
            onClick={() => {
              if (!disabled && !submitDisabled && pendingUploadsRef.current.length === 0
                  && !referenceBusyRef.current && !capacityExceeded(0)
                  && (text.trim() || attachmentsRef.current.length > 0)) onSchedule()
            }}
            disabled={disabled || submitDisabled || attachmentsBlocked || (!text.trim() && attachments.length === 0)}
            className="h-10 px-3 rounded-xl border border-line text-slate-300 text-sm font-medium hover:bg-white/5 disabled:opacity-40 transition"
            title="设置定时发送"
          >定时</button>
        )}
        <button
          type="button"
          onClick={stopActive ? onStop : submit}
          disabled={disabled || (!stopActive && (submitDisabled || attachmentsBlocked || (!text.trim() && attachments.length === 0)))}
          className={stopActive
            ? 'h-10 px-4 rounded-xl bg-status-danger text-white text-sm font-medium hover:bg-status-danger-strong disabled:opacity-40 disabled:shadow-none transition flex items-center justify-center'
            : 'h-10 px-4 rounded-xl bg-accent text-white text-sm font-medium hover:brightness-110 disabled:opacity-40 disabled:shadow-none transition flex items-center justify-center'}
          title={stopActive ? '停止当前会话任务' : attachmentHint ?? '发送消息'}
        >{stopActive ? '停止' : '发送'}</button>
      </div>

      {btwOpen && btwSessionId && (
        <BtwDialog key={btwSessionId} sessionId={btwSessionId} onClose={() => setBtwOpen(false)} />
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

function BtwDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
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

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [text])

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
      const r = await api.sessionBtw(sessionId, q)
      setTurns((xs) => xs.map((x) => x.id === id ? { ...x, a: r.ok ? r.content : '', error: r.ok ? '' : (r.error || 'BTW 请求失败') } : x))
    } catch (e: any) {
      setTurns((xs) => xs.map((x) => x.id === id ? { ...x, error: errorMessageFromError(e, 'BTW 请求失败') } : x))
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
      className="absolute bottom-full right-2 z-30 mb-2 w-[min(520px,calc(100vw-2rem))] rounded-2xl border border-status-warning-line bg-status-warning-soft backdrop-blur-sm shadow-2xl shadow-black/40 overflow-hidden">
      <div className="flex items-center justify-between border-b border-status-warning-line px-3 py-2 bg-status-warning-soft">
        <div>
          <div className="text-sm font-medium text-status-warning">BTW 旁路提问</div>
          <div className="text-[11px] text-status-warning-strong">不打断主任务，答案只显示在这个小窗里</div>
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
            <div className="ml-auto max-w-[85%] rounded-xl bg-status-warning-soft border border-status-warning-line px-3 py-2 text-status-warning whitespace-pre-wrap break-words">
              {t.q}
            </div>
            <div className="max-w-[92%] rounded-xl bg-bg-soft border border-line px-3 py-2 text-slate-200 whitespace-pre-wrap break-words">
              {t.error ? <span className="text-status-danger">{t.error}</span> : (t.a ?? '思考中…')}
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
          className="flex-1 resize-none overflow-y-auto rounded-xl border border-line bg-bg px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-600 focus:border-status-warning-strong disabled:opacity-60"
        />
        <button
          type="button"
          onClick={ask}
          disabled={loading || !text.trim()}
          className="px-3 py-2 rounded-xl bg-status-warning text-white text-sm font-medium hover:bg-status-warning-strong disabled:opacity-40"
        >提问</button>
      </div>
    </div>
  )
}

