import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshIcon } from '@/components/ActionIcons'
import { FolderOpen, Trash2, X } from 'lucide-react'
import fileTransferSymbol from '@/assets/file-transfer-symbol.png'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

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

async function request(method: 'GET' | 'DELETE', signal?: AbortSignal) {
  const response = await fetch(resolveApiUrl('/api/file-transfer'), { method, signal })
  if (!response.ok) throw new Error(`中转箱请求失败（${response.status}）`)
  return response
}

export interface FileTransferBoxProps {
  canInsert: boolean
  onInsert: (file: TransferredFile) => void
}

export function FileTransferBox({ canInsert, onInsert }: FileTransferBoxProps) {
  const [open, setOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLElement>(null)
  const cache = useQueryClient()
  const queryKey = fileTransferQueryKey
  const countId = useId()
  const files = useQuery({ queryKey, staleTime: 0, refetchInterval: open ? 2500 : false,
    queryFn: async ({ signal }): Promise<TransferredFile[]> => (await request('GET', signal)).json() })
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
  const clear = useMutation({ mutationFn: () => request('DELETE'), onSuccess: async () => {
    await cache.cancelQueries({ queryKey })
    cache.setQueryData(queryKey, [])
    setConfirmClear(false)
    await cache.invalidateQueries({ queryKey })
  } })
  const close = () => { setOpen(false); setConfirmClear(false); trigger.current?.focus() }
  const toggle = () => {
    if (open) {
      close()
    } else {
      setOpen(true)
      void files.refetch({ cancelRefetch: false })
    }
  }
  useEffect(() => { if (open) panel.current?.focus() }, [open])

  return <div className="relative flex justify-end">
    <button ref={trigger} type="button" title={countText ? `中转箱 · ${countText}` : '中转箱'}
      aria-label="中转箱" aria-describedby={countText ? countId : undefined} aria-expanded={open}
      className="pointer-events-auto relative grid size-[54px] place-items-center rounded-full border border-line bg-bg-card text-accent shadow-sm transition-colors hover:border-accent hover:bg-bg-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 aria-expanded:border-accent aria-expanded:bg-accent-soft aria-expanded:text-ink"
      onClick={toggle}>
      <span aria-hidden="true" className="h-10 w-8 bg-current"
        style={{ mask: `url(${fileTransferSymbol}) center / contain no-repeat` }} />
      {fileCount > 0 && <span aria-hidden="true"
        className="absolute right-0 top-0 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white tabular-nums ring-2 ring-bg-card">
        {fileCount > 99 ? '99+' : fileCount}
      </span>}
    </button>
    <span id={countId} role="status" className="sr-only">{countText}</span>
    {open && <section ref={panel} tabIndex={-1} role="dialog" aria-label="共享中转箱"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
      className="pointer-events-auto absolute right-0 top-full z-40 mt-2 w-full max-w-[22rem] rounded-xl border border-line bg-bg-card p-3 text-sm text-ink shadow-lg">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold">中转箱</h2>
        <div className="flex items-center gap-1">
          <button type="button" title="清空列表" aria-label="清空索引" className="ga-btn-icon"
            disabled={!files.data?.length || clear.isPending} onClick={() => setConfirmClear(true)}><Trash2 size={15} aria-hidden="true" /></button>
          <button type="button" title="关闭" aria-label="关闭中转箱" className="ga-btn-icon" onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
      </header>
      {confirmClear && <div className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-bg-soft/60 p-2 text-xs">
        <span className="flex-1">清空中转箱列表？（仅移除索引，不删除原文件）</span>
        <button type="button" className="ga-btn-sm" onClick={() => setConfirmClear(false)} disabled={clear.isPending}>取消</button>
        <button type="button" className="ga-btn-sm-danger" onClick={() => clear.mutate()} disabled={clear.isPending}>确认清空</button>
      </div>}
      {!canInsert && <p className="mb-2 text-xs text-ink-muted">请选择会话，或等待当前请求结束后再添加。</p>}
      {clear.isError && <p role="alert" className="mb-2 text-xs text-ink-muted">清空失败，请重试。</p>}
      {files.isPending ? <p className="py-2 text-ink-muted">正在加载…</p>
        : files.isError && !files.data ? <button type="button" className="ga-btn-link py-2" onClick={() => void files.refetch()}><RefreshIcon size={12} /><span>加载失败，点击重试</span></button>
        : !files.data?.length ? <p className="py-2 text-ink-muted">暂无放入中转箱的文件</p>
        : <div className="max-h-[min(24rem,55vh)] space-y-2.5 overflow-y-auto pr-0.5">
          {projectGroups.map(([projectName, groupFiles]) => (
            <section key={projectName} aria-label={`项目：${projectName}`}>
              <div className="mb-1 flex items-center justify-between gap-2 px-1.5 text-[11px] font-semibold text-ink-muted">
                <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
                  <FolderOpen size={12} strokeWidth={1.85} className="shrink-0 text-accent" aria-hidden="true" />
                  <span className="truncate">{projectName}</span>
                </span>
                <span className="shrink-0 rounded-full bg-bg-soft px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-faint">
                  {groupFiles.length}
                </span>
              </div>
              <ul className="space-y-1">
                {groupFiles.map(file => (
                  <li key={file.id}>
                    <button
                      type="button"
                      title={file.path}
                      disabled={!canInsert || !file.available || clear.isPending}
                      className="block w-full rounded-md border border-transparent px-2 py-1.5 text-left transition-colors hover:border-line/70 hover:bg-bg-soft disabled:opacity-50"
                      onClick={() => { onInsert(file); close() }}
                    >
                      <span className="block truncate font-medium">{file.name}</span>
                      <span className="block truncate text-[11px] text-ink-muted">
                        {file.engine === 'chat' ? 'Chat' : 'Anti'}
                        {file.available ? ` · ${formatFileSize(file.size)}` : ' · 文件已不可用'}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>}
    </section>}
  </div>
}
