import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { components } from '@/api/generated/schema'
import { ModalOverlay } from '@/components/ModalOverlay'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Profiles = components['schemas']['AgyProfiles']
const key = ['agy-profiles'] as const

async function request<T>(suffix = '', init?: RequestInit): Promise<T> {
  const response = await fetch(resolveApiUrl(`/api/anti/profiles${suffix}`), init)
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(typeof error?.detail === 'string' ? error.detail : '无法访问 Agy 账号设置')
  }
  return response.status === 204 ? undefined as T : response.json()
}

const write = { method: 'POST', headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' } }

export function useAgyProfiles() {
  return useQuery({ queryKey: key, queryFn: () => request<Profiles>(), retry: false })
}

export function AntiAgyProfiles({ profiles, refresh }: {
  profiles: ReturnType<typeof useAgyProfiles>; refresh: () => void
}) {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const action = useMutation({
    mutationFn: async (args: { kind: 'create' | 'switch' | 'login'; value: string }) => {
      if (args.kind === 'create') {
        await request('', { ...write, headers: { ...write.headers, 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: args.value }) })
      } else if (args.kind === 'switch') {
        const data = await request<Profiles>(`/${encodeURIComponent(args.value)}/switch`, write)
        cache.setQueryData(key, data)
      } else {
        await request(`/${encodeURIComponent(args.value)}/login`, write)
      }
    },
    onMutate: () => setMessage(''),
    onSuccess: async (_, args) => {
      if (args.kind === 'create') setName('')
      if (args.kind === 'login') setMessage('已打开本机 agy 窗口。请按官方提示登录，完成后关闭该窗口。')
      await cache.invalidateQueries({ queryKey: key })
    },
    onSettled: refresh,
  })
  const selected = profiles.data?.profiles.find(item => item.id === profiles.data?.active)
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (name.trim() && !action.isPending) action.mutate({ kind: 'create', value: name.trim() })
  }
  const button = 'rounded border border-line px-2 py-1 text-sm disabled:opacity-50'
  return <>
    <button type="button" className={button} onClick={() => setOpen(true)}>
      Agy 账号{selected ? `：${selected.name}` : ''}
    </button>
    {open && <ModalOverlay onClose={() => setOpen(false)} labelledBy="agy-accounts-title"
      panelClassName="max-h-[90vh] w-full max-w-lg space-y-3 overflow-auto p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 id="agy-accounts-title" className="text-base font-semibold">Agy CLI 账号</h2>
          <button autoFocus type="button" className={button} onClick={() => setOpen(false)}>关闭</button>
        </div>
        <p className="text-sm text-ink-muted">仅用于 GA-Hub 的 Agy 会话。新账号请先通过官方 CLI 登录，再切换使用。</p>
        <ul className="space-y-2">
          {profiles.data?.profiles.map(item => <li key={item.id} className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 break-all">{item.name}</span>
            <button type="button" className={button} disabled={action.isPending}
              onClick={() => action.mutate({ kind: 'login', value: item.id })}>官方登录</button>
            {item.id === selected?.id ? <span className="px-2 text-sm">当前</span> :
              <button type="button" className={button} disabled={action.isPending}
                onClick={() => action.mutate({ kind: 'switch', value: item.id })}>切换</button>}
          </li>)}
        </ul>
        <form onSubmit={add} className="flex gap-2">
          <input value={name} maxLength={64} onChange={event => setName(event.target.value)}
            aria-label="账号备注" placeholder="输入账号备注" className="min-w-0 flex-1 rounded border border-line bg-transparent px-2" />
          <button type="submit" className={button} disabled={!name.trim() || action.isPending || !profiles.data}>添加账号</button>
        </form>
        {(action.error || profiles.error) && <p role="alert" className="text-sm">{(action.error ?? profiles.error)?.message}</p>}
        <p role="status" className="text-sm text-ink-muted">{action.isPending ? '处理中…' : message}</p>
    </ModalOverlay>}
  </>
}
