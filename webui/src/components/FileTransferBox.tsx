import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CloseIconButton, RefreshIcon } from '@/components/ActionIcons'
import { File, FileArchive, FileCode2, FileText, Film, FolderOpen, Image, Music, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import { api } from '@/api/client'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import { toast } from '@/stores/toastStore'
import { canReferenceLocalFiles, selectAttachmentPaths } from '@/utils/desktop'
import { errorMessageFromError } from '@/utils/sessionUi'

export interface TransferredFile {
  id: number
  name: string
  path: string
  size: number
  engine: 'chat' | 'anti'
  project: string | null
  available: boolean
}

export const fileTransferQueryKey = ['file-transfer'] as const

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tiff: 'image/tiff',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
}

export function guessTransferMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

function fileIconComponent(filename: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff'].includes(ext)) return Image
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return Film
  if (['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac'].includes(ext)) return Music
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext)) return FileArchive
  if (['py', 'ts', 'tsx', 'js', 'jsx', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'sql', 'css', 'html', 'xml'].includes(ext)) return FileCode2
  if (['md', 'txt', 'pdf', 'rst', 'csv', 'tsv', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return FileText
  return File
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export async function addTransferFile(body: {
  path: string; engine: 'chat' | 'anti'; session_id: string; project?: string
}) {
  const response = await fetch(resolveApiUrl('/api/file-transfer'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(response.status === 422 ? '文件不存在或不是本地文件' : `放入中转箱失败（${response.status}）`)
}

export async function saveTransferReply(body: {
  text: string; engine: 'chat' | 'anti'; session_id: string; project?: string
}) {
  const response = await fetch(resolveApiUrl('/api/file-transfer/reply'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(response.status === 422 ? '回复内容为空或过长，无法放入中转箱' : `放入中转箱失败（${response.status}）`)
}

export async function clearTransferDocuments(): Promise<{ deleted: number }> {
  const response = await fetch(resolveApiUrl('/api/file-transfer/documents'), { method: 'DELETE' })
  if (!response.ok) throw new Error(`清空暂存文档失败（${response.status}）`)
  return response.json() as Promise<{ deleted: number }>
}

async function request(method: 'GET' | 'DELETE', signal?: AbortSignal) {
  const response = await fetch(resolveApiUrl('/api/file-transfer'), { method, signal })
  if (!response.ok) throw new Error(`中转箱请求失败（${response.status}）`)
  return response
}

/** 保留原倾斜开启文件夹 + 双向流转弧形箭头形象，优化亮/暗主题填色层次与线条克制度 */
function FileTransferIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 40 40"
      className={className}
      fill="none"
    >
      {/* 文件夹后背片与标签 */}
      <path
        d="M5 11.2C5 9.43 6.43 8 8.2 8h5.2c.86 0 1.67.4 2.2 1.08l1.1 1.42c.38.49.96.78 1.58.78H31c1.38 0 2.5 1.12 2.5 2.5v14.2c0 1.66-1.34 3-3 3H8c-1.66 0-3-1.34-3-3V11.2Z"
        style={{
          fill: 'color-mix(in srgb, var(--c-text-muted) 16%, var(--c-bg-soft))',
          stroke: 'color-mix(in srgb, var(--c-text) 68%, var(--c-bg-card))',
        }}
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 前侧开启斜翻盖 */}
      <path
        d="M5.4 30.2 8.2 17c.28-1.28 1.36-2.22 2.66-2.34l21.9-2.06c1.56-.15 2.83 1.24 2.49 2.77l-3.05 13.7c-.27 1.2-1.34 2.05-2.57 2.05H7.2c-1.15 0-2-.97-1.8-1.92Z"
        style={{
          fill: 'color-mix(in srgb, var(--c-bg-card) 86%, var(--c-bg-soft))',
          stroke: 'color-mix(in srgb, var(--c-text) 68%, var(--c-bg-card))',
        }}
        strokeWidth="1.45"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 前盖底部微阴影层 */}
      <path
        d="M6.4 29.8h24.3c.7 0 1.32-.48 1.48-1.16l.65-2.84H7.25l-.85 4Z"
        style={{ fill: 'color-mix(in srgb, var(--c-text) 9%, transparent)' }}
      />
      {/* 左下向上弯弧箭头 */}
      <path
        d="M16 14.6 19.8 20.8l-2.9-.25c-1.95 4.8-2.45 10.2-.4 14.65-5.6-3.7-5.55-10.55-2.7-15.1l-2.9-.32L16 14.6Z"
        style={{
          fill: 'color-mix(in srgb, var(--c-accent) 44%, var(--c-bg-card))',
          stroke: 'color-mix(in srgb, var(--c-accent) 52%, var(--c-text))',
        }}
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* 右上向下弯弧箭头 */}
      <path
        d="M24.8 26.8 21.1 20.55l2.85.25c2.05-5.05 1.55-11.2-1.45-16.1 6.75 3.35 7.7 10.9 5.05 16.5l2.85.4L24.8 26.8Z"
        style={{
          fill: 'color-mix(in srgb, var(--c-accent) 22%, var(--c-bg-card))',
          stroke: 'color-mix(in srgb, var(--c-accent) 42%, var(--c-text))',
        }}
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export interface FileTransferBoxProps {
  canInsert: boolean
  onInsert: (file: TransferredFile) => void
  source?: {
    engine: 'chat' | 'anti'
    sessionId?: string
    project?: string
  }
}

export function FileTransferBox({ canInsert, onInsert, source }: FileTransferBoxProps) {
  const [open, setOpen] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'list' | 'documents' | null>(null)
  const [dragging, setDragging] = useState(false)
  const [adding, setAdding] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cache = useQueryClient()
  const queryKey = fileTransferQueryKey
  const countId = useId()
  const files = useQuery({
    queryKey,
    staleTime: 0,
    refetchInterval: open ? 2500 : false,
    queryFn: async ({ signal }): Promise<TransferredFile[]> => (await request('GET', signal)).json(),
  })
  const fileCount = files.data?.length ?? 0
  const countText = files.data ? `箱内有 ${fileCount} 个文件` : undefined
  const projectGroups = useMemo(() => {
    const grouped = new Map<string, TransferredFile[]>()
    for (const file of files.data ?? []) {
      const group = file.project?.trim() || '未绑定项目'
      const bucket = grouped.get(group)
      if (bucket) bucket.push(file)
      else grouped.set(group, [file])
    }
    return Array.from(grouped.entries())
  }, [files.data])

  const clearList = useMutation({
    mutationFn: () => request('DELETE'),
    onSuccess: async () => {
      await cache.cancelQueries({ queryKey })
      cache.setQueryData(queryKey, [])
      setConfirmAction(null)
      await cache.invalidateQueries({ queryKey })
    },
  })

  const clearDocs = useMutation({
    mutationFn: () => clearTransferDocuments(),
    onSuccess: async ({ deleted }) => {
      setConfirmAction(null)
      await cache.invalidateQueries({ queryKey })
      toast.success(deleted > 0 ? `已清空 ${deleted} 个暂存文档` : '暂无暂存文档')
    },
  })

  const busy = clearList.isPending || clearDocs.isPending || adding
  const dismiss = useCallback(() => {
    setOpen(false)
    setConfirmAction(null)
  }, [])
  const close = useCallback(() => {
    dismiss()
    trigger.current?.focus()
  }, [dismiss])
  const toggle = () => {
    if (open) {
      close()
    } else {
      setOpen(true)
      void files.refetch({ cancelRefetch: false })
    }
  }
  useEffect(() => { if (open) panel.current?.focus() }, [open])
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return
      dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, dismiss])

  const registerPaths = useCallback(async (paths: string[]) => {
    if (!source?.sessionId || paths.length === 0) return
    setAdding(true)
    try {
      for (const path of paths) {
        await addTransferFile({
          path,
          engine: source.engine,
          session_id: source.sessionId,
          ...(source.project ? { project: source.project } : {}),
        })
      }
      await cache.invalidateQueries({ queryKey })
      toast.success(paths.length > 1 ? `已添加 ${paths.length} 个文件到中转箱` : '已放入中转箱')
    } catch (error) {
      toast.error(errorMessageFromError(error, '放入中转箱失败'))
    } finally {
      setAdding(false)
    }
  }, [cache, queryKey, source])

  const uploadAndRegister = useCallback(async (fileList: FileList | File[]) => {
    const list = Array.from(fileList)
    if (!source?.sessionId || list.length === 0) return
    setAdding(true)
    try {
      for (const file of list) {
        const uploaded = await api.upload(file)
        await addTransferFile({
          path: uploaded.path,
          engine: source.engine,
          session_id: source.sessionId,
          ...(source.project ? { project: source.project } : {}),
        })
      }
      await cache.invalidateQueries({ queryKey })
      toast.success(list.length > 1 ? `已添加 ${list.length} 个文件到中转箱` : '已放入中转箱')
    } catch (error) {
      toast.error(errorMessageFromError(error, '放入中转箱失败'))
    } finally {
      setAdding(false)
    }
  }, [cache, queryKey, source])

  const pickFiles = async () => {
    if (!source?.sessionId || busy) return
    if (canReferenceLocalFiles()) {
      try {
        const paths = await selectAttachmentPaths()
        if (paths.length > 0) await registerPaths(paths)
      } catch (error) {
        toast.error(errorMessageFromError(error, '选择文件失败'))
      }
      return
    }
    fileInputRef.current?.click()
  }

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!source?.sessionId || event.dataTransfer.files.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    setDragging(false)
    void uploadAndRegister(event.dataTransfer.files)
  }

  return (
    <div className="relative flex justify-end">
      <button
        ref={trigger}
        type="button"
        title={countText ? `中转箱 · ${countText}` : '中转箱'}
        aria-label="中转箱"
        aria-describedby={countText ? countId : undefined}
        aria-expanded={open}
        className="pointer-events-auto relative grid size-[50px] place-items-center rounded-full border border-line/90 bg-bg-card text-ink-muted shadow-sm transition-all hover:border-accent/65 hover:bg-bg-card hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/55 aria-expanded:border-accent/70 aria-expanded:bg-accent-soft/55"
        onClick={toggle}
      >
        <FileTransferIcon className="h-[34px] w-[34px]" />
        {fileCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-[var(--c-accent-fg)] tabular-nums ring-2 ring-bg-card"
          >
            {fileCount > 99 ? '99+' : fileCount}
          </span>
        )}
      </button>
      <span id={countId} role="status" className="sr-only">{countText}</span>
      {open && (
        <section
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label="共享中转箱"
          onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
          onDragOver={event => {
            if (!source?.sessionId || event.dataTransfer.types.includes('Files') === false) return
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={clsx(
            'pointer-events-auto absolute right-0 top-full z-40 mt-2 w-72 max-w-[20rem] rounded-xl border bg-bg-card p-2.5 text-sm text-ink shadow-lg transition-colors',
            dragging ? 'border-accent bg-accent-soft/20' : 'border-line',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={event => {
              const selected = event.target.files
              if (selected && selected.length > 0) void uploadAndRegister(selected)
              event.currentTarget.value = ''
            }}
          />
          <header className="mb-2 flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold tracking-wide text-ink">中转箱</h2>
            <div className="flex items-center gap-1">
              {source?.sessionId && (
                <button
                  type="button"
                  title="添加文件"
                  aria-label="添加文件"
                  className="ga-btn-icon-sm"
                  disabled={busy}
                  onClick={() => { void pickFiles() }}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              )}
              <CloseIconButton
                label="关闭中转箱"
                title="关闭"
                variant="compact"
                iconSize={13}
                className="rounded-md"
                onClick={close}
              />
            </div>
          </header>
          <div className="mb-2 grid grid-cols-2 gap-1.5">
            <button
              type="button"
              aria-label="清空列表"
              className="ga-btn-sm justify-center"
              disabled={!files.data?.length || busy}
              onClick={() => setConfirmAction('list')}
            >
              <Trash2 size={12} aria-hidden="true" />
              <span>清空列表</span>
            </button>
            <button
              type="button"
              aria-label="清空暂存文档"
              className="ga-btn-sm-danger justify-center"
              disabled={busy}
              onClick={() => setConfirmAction('documents')}
            >
              <Trash2 size={12} aria-hidden="true" />
              <span>清空暂存文档</span>
            </button>
          </div>
          {confirmAction && (
            <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-line bg-bg-soft/65 px-2 py-1.5 text-xs">
              <span className="flex-1 truncate font-medium">
                {confirmAction === 'list' ? '清空列表？' : '删除暂存文档？'}
              </span>
              <button
                type="button"
                className="ga-btn-sm"
                onClick={() => setConfirmAction(null)}
                disabled={busy}
              >
                取消
              </button>
              <button
                type="button"
                className="ga-btn-sm-danger"
                onClick={() => {
                  if (confirmAction === 'list') clearList.mutate()
                  else clearDocs.mutate()
                }}
                disabled={busy}
              >
                确认
              </button>
            </div>
          )}
          {(clearList.isError || clearDocs.isError) && (
            <p role="alert" className="mb-2 text-xs text-status-danger">操作失败，请重试</p>
          )}
          {files.isPending ? (
            <p className="py-2 text-center text-xs text-ink-muted">加载中…</p>
          ) : files.isError && !files.data ? (
            <button type="button" className="ga-btn-link py-2 text-xs" onClick={() => void files.refetch()}>
              <RefreshIcon size={12} />
              <span>加载失败 · 重试</span>
            </button>
          ) : !files.data?.length ? (
            <p className="py-2 text-center text-xs text-ink-muted">暂无文件</p>
          ) : (
            <div className="max-h-[min(22rem,52vh)] space-y-2 overflow-y-auto pr-0.5">
              {projectGroups.map(([projectName, groupFiles]) => (
                <section key={projectName} aria-label={`项目：${projectName}`}>
                  <div className="mb-1 flex items-center justify-between gap-2 px-1 text-[11px] font-semibold text-ink-muted">
                    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                      <FolderOpen size={12} strokeWidth={1.85} className="shrink-0 text-accent" aria-hidden="true" />
                      <span className="truncate">{projectName}</span>
                    </span>
                    <span className="shrink-0 rounded-full bg-bg-soft px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-faint">
                      {groupFiles.length}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {groupFiles.map(file => {
                      const KindIcon = fileIconComponent(file.name)
                      return (
                        <li key={file.id}>
                          <button
                            type="button"
                            title={file.path}
                            disabled={!canInsert || !file.available || busy}
                            className="flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left text-xs transition-colors hover:border-line/70 hover:bg-bg-soft disabled:opacity-50"
                            onClick={() => { onInsert(file); close() }}
                          >
                            <KindIcon size={14} strokeWidth={1.85} className="shrink-0 text-accent" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate font-medium text-ink">{file.name}</span>
                            <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                              {file.available ? formatFileSize(file.size) : '失效'}
                            </span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
