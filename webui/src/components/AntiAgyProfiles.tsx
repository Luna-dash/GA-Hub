import { useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { components } from '@/api/generated/schema'
import { ModalOverlay } from '@/components/ModalOverlay'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Profiles = components['schemas']['AgyProfiles']
type Profile = components['schemas']['AgyProfile']
type Action = { kind: 'create'; name: string } | { kind: 'switch' | 'login'; profile: Profile }
  | { kind: 'rename'; profile: Profile; name: string }
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
  return useQuery({ queryKey: key, queryFn: ({ signal }) => request<Profiles>('', { signal }), retry: false })
}

export function AntiAgyProfiles({ profiles, refresh }: {
  profiles: ReturnType<typeof useAgyProfiles>; refresh: () => void
}) {
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [editing, setEditing] = useState<{ profile: Profile; name: string } | null>(null)
  const [message, setMessage] = useState('')
  const action = useMutation({
    mutationFn: async (args: Action) => {
      if (args.kind === 'create') {
        const profile = await request<Profile>('', {
          ...write, headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: [...old.profiles.filter(p => p.id !== profile.id), profile] }))
        setName('')
        setMessage(`已添加「${profile.name}」。请在该账号旁点「官方登录」，完成登录并关闭 CLI 窗口后再切换。`)
      } else if (args.kind === 'rename') {
        const profile = await request<Profile>(`/${encodeURIComponent(args.profile.id)}`, {
          method: 'PATCH', headers: { ...write.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: args.name }),
        })
        cache.setQueryData<Profiles>(key, old => old && ({ ...old, profiles: old.profiles.map(p => p.id === profile.id ? profile : p) }))
        setEditing(null)
        setMessage(`账号备注已改为「${profile.name}」。`)
      } else if (args.kind === 'switch') {
        const data = await request<Profiles>(`/${encodeURIComponent(args.profile.id)}/switch`, write)
        cache.setQueryData(key, data)
        setMessage(`已切换到「${args.profile.name}」。`)
      } else {
        await request(`/${encodeURIComponent(args.profile.id)}/login`, write)
        setMessage(`已为「${args.profile.name}」打开官方 CLI。请完成登录并关闭该窗口，再回这里切换。`)
      }
    },
    onMutate: async args => {
      setMessage('')
      if (args.kind !== 'login') await cache.cancelQueries({ queryKey: key, exact: true })
    },
    onSettled: (_, __, args) => {
      if (args.kind !== 'login') void cache.invalidateQueries({ queryKey: key, exact: true })
      if (args.kind === 'switch') refresh()
    },
  })
  const selected = profiles.data?.profiles.find(item => item.id === profiles.data?.active)
  const others = profiles.data?.profiles.filter(item => item.id !== profiles.data?.active) ?? []
  const close = () => {
    if (action.isPending) return
    setOpen(false)
    setEditing(null)
    setMessage('')
    action.reset()
  }
  const disabled = action.isPending || profiles.isError
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && profiles.data && name.trim()) action.mutate({ kind: 'create', name: name.trim() })
  }
  const pendingLabel = action.variables?.kind === 'switch' ? '正在切换账号…'
    : action.variables?.kind === 'login' ? '正在打开官方 CLI…'
    : action.variables?.kind === 'rename' ? '正在保存备注…' : '正在添加账号…'
  const secondary = 'ga-btn shrink-0'
  const editButton = (profile: Profile) => profile.id !== 'default' && (
    <button type="button" className={secondary} disabled={disabled} aria-label={`修改备注：${profile.name}`}
      onClick={() => { action.reset(); setMessage(''); setEditing({ profile, name: profile.name }) }}>修改备注</button>
  )
  return <>
    <button type="button" className={secondary} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      Agy 账号{selected ? `：${selected.name}` : ''}
    </button>
    {open && createPortal(<ModalOverlay onClose={close} labelledBy="agy-accounts-title"
      panelClassName="max-h-[90vh] w-full max-w-lg space-y-4 overflow-auto p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="agy-accounts-title" className="text-base font-semibold">Agy CLI 账号</h2>
          <p className="mt-1 text-sm text-ink-muted">「系统默认」沿用当前系统的 agy 登录。其他账号各自登录，切换只影响 GA-Hub。</p>
        </div>
        <button type="button" className={secondary} onClick={close} disabled={action.isPending}>关闭</button>
      </div>
      <div role="status" className="text-sm text-ink-muted empty:hidden">{action.isPending ? pendingLabel : message}</div>
      {action.error && <p role="alert" className="rounded-lg border border-line p-2 text-sm">{action.error.message}</p>}
      {profiles.isError && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
        <p role="alert">{profiles.error.message}</p>
        <button type="button" className={secondary} onClick={() => void profiles.refetch()} disabled={profiles.isFetching}>重试加载账号</button>
      </div>}
      {profiles.isPending && <p role="status" className="text-sm text-ink-muted">正在加载账号…</p>}
      {profiles.data && <>
        {selected && <section className="rounded-lg border border-line/70 p-3" aria-labelledby="agy-active-account">
          <h3 id="agy-active-account" className="text-sm font-semibold">当前账号</h3>
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="min-w-0 flex-1 break-all text-sm">{selected.name}</span>
            {editButton(selected)}
            <button type="button" className={secondary} disabled={disabled}
              aria-label={`官方登录：${selected.name}`} onClick={() => action.mutate({ kind: 'login', profile: selected })}>官方登录</button>
          </div>
        </section>}
        <section aria-labelledby="agy-other-accounts">
          <h3 id="agy-other-accounts" className="mb-1 text-sm font-semibold">其他账号</h3>
          {others.length === 0 ? <p className="text-sm text-ink-muted">暂无可切换账号，请先添加。</p> :
            <ul className="divide-y divide-line/60 rounded-lg border border-line/70">
              {others.map(profile => <li key={profile.id} className="flex flex-wrap items-center gap-2 p-2">
                <span className="min-w-0 flex-1 break-all px-1 text-sm">{profile.name}</span>
                {editButton(profile)}
                <button type="button" className={secondary} disabled={disabled} aria-label={`官方登录：${profile.name}`}
                  onClick={() => action.mutate({ kind: 'login', profile })}>官方登录</button>
                <button type="button" className="ga-btn-primary shrink-0" disabled={disabled} aria-label={`切换到${profile.name}`}
                  onClick={() => action.mutate({ kind: 'switch', profile })}>切换</button>
              </li>)}
            </ul>}
        </section>
        {editing && <form onSubmit={event => {
          event.preventDefault()
          const value = editing.name.trim()
          if (!disabled && value && value !== editing.profile.name) action.mutate({ kind: 'rename', profile: editing.profile, name: value })
        }} className="space-y-2 border-t border-line/70 pt-3">
          <label htmlFor="agy-edit-name" className="text-sm font-semibold">修改「{editing.profile.name}」的备注</label>
          <div className="flex flex-wrap gap-2">
            <input id="agy-edit-name" value={editing.name} maxLength={64} disabled={disabled}
              onChange={event => setEditing({ ...editing, name: event.target.value })}
              className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-2 text-sm" />
            <button type="submit" className={secondary} disabled={disabled || !editing.name.trim() || editing.name.trim() === editing.profile.name}>保存备注</button>
            <button type="button" className={secondary} disabled={action.isPending} onClick={() => { action.reset(); setEditing(null) }}>取消</button>
          </div>
        </form>}
        <form onSubmit={add} className="space-y-2 border-t border-line/70 pt-3">
          <label htmlFor="agy-profile-name" className="text-sm font-semibold">添加账号</label>
          <p id="agy-add-help" className="text-sm text-ink-muted">为每个账号添加一个备注，首次使用需要通过官方 CLI 登录一次。</p>
          <div className="flex flex-wrap gap-2">
            <input id="agy-profile-name" value={name} maxLength={64} onChange={event => setName(event.target.value)} disabled={disabled}
              aria-label="账号备注" aria-describedby="agy-add-help" placeholder="例如：工作账号"
              className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-2 text-sm" />
            <button type="submit" className={secondary} disabled={disabled || !name.trim()}>添加账号</button>
          </div>
        </form>
      </>}
    </ModalOverlay>, document.body)}
  </>
}
