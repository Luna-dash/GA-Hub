import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileStack, Trash2, X } from 'lucide-react'
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

export async function addTransferFile(body: {
  path: string; engine: 'chat' | 'anti'; session_id: string; project?: string
}) {
  const response = await fetch(resolveApiUrl('/api/file-transfer'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(response.status === 422 ? '文件不存在或不是本地文件' : `放入传递箱失败（${response.status}）`)
}
export async function saveTransferReply(body: {
  text: string; engine: 'chat' | 'anti'; session_id: string; project?: string
}) {
  const response = await fetch(resolveApiUrl('/api/file-transfer/reply'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(response.status === 422 ? '回复内容为空或过长，无法转为文档' : `保存回复文档失败（${response.status}）`)
}

async function request(method: 'GET' | 'DELETE', signal?: AbortSignal) {
  const response = await fetch(resolveApiUrl('/api/file-transfer'), { method, signal })
  if (!response.ok) throw new Error(`文件传递箱请求失败（${response.status}）`)
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
  const files = useQuery({ queryKey, enabled: open, staleTime: 0, refetchInterval: open ? 2500 : false,
    queryFn: async ({ signal }): Promise<TransferredFile[]> => (await request('GET', signal)).json() })
  const clear = useMutation({ mutationFn: () => request('DELETE'), onSuccess: async () => {
    await cache.cancelQueries({ queryKey })
    cache.setQueryData(queryKey, [])
    setConfirmClear(false)
    await cache.invalidateQueries({ queryKey })
  } })
  const close = () => { setOpen(false); setConfirmClear(false); trigger.current?.focus() }
  useEffect(() => { if (open) panel.current?.focus() }, [open])

  return <div className="relative flex justify-end">
    <button ref={trigger} type="button" title="文件传递箱" aria-label="文件传递箱" aria-expanded={open}
      className="pointer-events-auto relative grid size-9 place-items-center rounded-full border border-line/75 bg-gradient-to-br from-bg-card to-accent-soft/70 text-ink-muted shadow-sm transition-colors before:pointer-events-none before:absolute before:inset-[3px] before:rounded-full before:border before:border-bg-card/80 hover:border-accent/65 hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-expanded:border-accent aria-expanded:from-accent-soft aria-expanded:to-accent-soft aria-expanded:text-ink"
      onClick={() => open ? close() : setOpen(true)}>
      <FileStack size={17} strokeWidth={1.65} aria-hidden="true" />
    </button>
    {open && <section ref={panel} tabIndex={-1} role="dialog" aria-label="共享文件传递箱"
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close() } }}
      className="pointer-events-auto absolute right-0 top-full z-40 mt-2 w-full max-w-[22rem] rounded-xl border border-line bg-bg-card p-3 text-sm text-ink shadow-lg">
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold">文件传递箱</h2>
        <div className="flex items-center gap-1">
          <button type="button" title="清空索引（不删除原文件）" aria-label="清空索引" className="ga-btn-icon"
            disabled={!files.data?.length || clear.isPending} onClick={() => setConfirmClear(true)}><Trash2 size={15} aria-hidden="true" /></button>
          <button type="button" title="关闭" aria-label="关闭文件传递箱" className="ga-btn-icon" onClick={close}><X size={16} aria-hidden="true" /></button>
        </div>
      </header>
      <p className="mb-2 text-xs text-ink-muted">在会话结论里右键文件链接手动放入。点击箱内文件加入当前草稿。</p>
      {confirmClear && <div className="mb-2 flex items-center gap-2 rounded-lg border border-line p-2 text-xs">
        <span className="flex-1">清空所有会话的共享索引？不会删除原文件。</span>
        <button type="button" className="text-ink-muted" onClick={() => setConfirmClear(false)} disabled={clear.isPending}>取消</button>
        <button type="button" className="text-accent" onClick={() => clear.mutate()} disabled={clear.isPending}>确认清空</button>
      </div>}
      {!canInsert && <p className="mb-2 text-xs text-ink-muted">请选择会话，或等待当前请求结束后再添加。</p>}
      {clear.isError && <p role="alert" className="mb-2 text-xs text-ink-muted">清空失败，请重试。</p>}
      {files.isPending ? <p className="py-2 text-ink-muted">正在加载…</p>
        : files.isError && !files.data ? <button type="button" className="py-2 text-accent" onClick={() => void files.refetch()}>加载失败，点击重试</button>
        : !files.data?.length ? <p className="py-2 text-ink-muted">暂无手动放入的文件</p>
        : <ul className="max-h-[min(24rem,55vh)] space-y-1 overflow-y-auto">
          {files.data.map(file => <li key={file.id}>
            <button type="button" title={file.path} disabled={!canInsert || !file.available || clear.isPending}
              className="block w-full rounded-md px-2 py-1.5 text-left hover:bg-bg-soft disabled:opacity-50"
              onClick={() => { onInsert(file); close() }}>
              <span className="block truncate">{file.name}</span>
              <span className="block truncate text-xs text-ink-muted">{file.engine === 'chat' ? 'Chat' : 'Anti'}{file.project ? ` · ${file.project}` : ''}{!file.available ? ' · 文件已不可用' : ''}</span>
            </button>
          </li>)}
        </ul>}
    </section>}
  </div>
}
