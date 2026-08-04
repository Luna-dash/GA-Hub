import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '@/api/client'
import type { HubSession, SessionRuntime } from '@/api/types'
import { useSessionManagerStore } from '@/stores/sessionManagerStore'
import { sessionActivity, sessionChatHref, sessionStatusLabel } from '@/utils/sessionUi'

const statusTone = {
  active: 'bg-emerald-400/15 text-emerald-300 border-emerald-400/30',
  idle: 'bg-slate-400/10 text-slate-300 border-slate-500/30',
  error: 'bg-rose-400/10 text-rose-300 border-rose-500/30',
  unknown: 'bg-amber-400/10 text-amber-300 border-amber-500/30',
}

function displayTitle(item: HubSession) {
  return item.title.trim() || `未命名会话 · ${item.id.slice(0, 8)}`
}

export function SessionManagerHost() {
  const open = useSessionManagerStore((s) => s.open)
  const conflict = useSessionManagerStore((s) => s.conflict)
  const close = useSessionManagerStore((s) => s.close)
  const nav = useNavigate()
  const qc = useQueryClient()
  const [runtimes, setRuntimes] = useState<Record<string, SessionRuntime>>({})
  const [busyId, setBusyId] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [deleteId, setDeleteId] = useState('')

  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: api.sessions,
    enabled: open,
  })
  const sessions = useMemo(() => sessionsQuery.data?.items ?? [], [sessionsQuery.data])
  const visibleSessions = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    if (!needle) return sessions
    return sessions.filter((item) => `${displayTitle(item)} ${item.id} ${item.llm_index ?? ''}`.toLocaleLowerCase().includes(needle))
  }, [query, sessions])

  useEffect(() => {
    if (!open || !sessions.length) return
    let cancelled = false
    void Promise.all(sessions.map(async (item) => {
      try { return [item.id, await api.sessionRuntime(item.id)] as const }
      catch { return null }
    })).then((entries) => {
      if (cancelled) return
      setRuntimes(Object.fromEntries(entries.filter((entry): entry is readonly [string, SessionRuntime] => entry !== null)))
    })
    return () => { cancelled = true }
  }, [open, sessions])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  if (!open) return null

  const refresh = async () => {
    setError('')
    await sessionsQuery.refetch()
  }
  const select = (id: string) => {
    localStorage.setItem('gahub.currentSessionId', id)
    close()
    nav(sessionChatHref(id))
  }
  const createSession = async () => {
    setBusyId('new')
    setError('')
    try {
      const created = await api.createSession({ title: '' })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
      select(created.id)
    } catch (e: any) {
      setError(e?.body?.detail || e?.message || String(e))
    } finally { setBusyId('') }
  }
  const saveTitle = async (id: string) => {
    const title = draftTitle.trim()
    if (!title) {
      setError('会话标题不能为空。')
      return
    }
    setBusyId(id)
    setError('')
    try {
      await api.updateSession(id, { title })
      setEditingId('')
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (e: any) {
      setError(e?.body?.detail || e?.message || String(e))
    } finally { setBusyId('') }
  }
  const remove = async (id: string) => {
    setBusyId(id)
    setError('')
    try {
      await api.deleteSession(id)
      setDeleteId('')
      setRuntimes((current) => {
        const next = { ...current }
        delete next[id]
        return next
      })
      await qc.invalidateQueries({ queryKey: ['sessions'] })
    } catch (e: any) {
      const detail = e?.body?.detail
      setError(detail?.code === 'session_active' ? '运行中的会话不能删除，请先停止任务。' : (typeof detail === 'string' ? detail : e?.message || String(e)))
    } finally { setBusyId('') }
  }
  const stop = async (id: string) => {
    setBusyId(id)
    setError('')
    try {
      const runtime = await api.abortSession(id)
      setRuntimes((current) => ({ ...current, [id]: runtime }))
      await qc.invalidateQueries({ queryKey: ['session.runtime', id] })
    } catch (e: any) {
      setError(e?.body?.detail || e?.message || String(e))
    } finally { setBusyId('') }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <section role="dialog" aria-modal="true" aria-label="会话管理" className="w-full max-w-3xl max-h-[82vh] flex flex-col rounded-2xl border border-line bg-bg-card shadow-2xl">
        <header className="flex items-start justify-between gap-4 px-5 py-4 border-b border-line">
          <div>
            <h2 className="text-base font-semibold text-slate-100">会话管理</h2>
            <p className="text-xs text-slate-400 mt-1">查看每个会话的后端运行状态，切换或停止运行中的会话。</p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void refresh()} className="px-3 py-1.5 rounded-lg border border-line text-xs text-slate-300 hover:bg-white/5">刷新</button>
            <button type="button" disabled={busyId === 'new'} onClick={() => void createSession()} className="px-3 py-1.5 rounded-lg bg-accent text-white text-xs hover:brightness-110 disabled:opacity-50">新建会话</button>
            <button type="button" onClick={close} aria-label="关闭会话管理" className="px-2 text-slate-400 hover:text-white">✕</button>
          </div>
        </header>
        {conflict && (
          <div className="mx-5 mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            <div className="font-medium">并发容量已满{conflict.capacity != null ? `（${conflict.activeCount ?? conflict.capacity}/${conflict.capacity}）` : ''}</div>
            <div className="text-xs text-amber-200/80 mt-1">{conflict.message} 可停止下方高亮会话后重试，草稿不会丢失。</div>
          </div>
        )}
        {error && <div className="mx-5 mt-4 rounded-lg bg-rose-400/10 border border-rose-400/30 px-3 py-2 text-xs text-rose-300">{error}</div>}
        <div className="px-5 pt-4">
          <label className="block text-xs text-slate-400" htmlFor="session-search">搜索会话</label>
          <input id="session-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="按标题、会话 ID 或模型筛选" className="mt-1 w-full rounded-xl border border-line bg-bg-soft px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-accent" />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-2">
          {sessionsQuery.isLoading && <div className="text-sm text-slate-400 text-center py-10">正在加载会话…</div>}
          {sessionsQuery.isError && <div className="text-sm text-rose-300 text-center py-10">会话加载失败：{(sessionsQuery.error as Error).message}</div>}
          {!sessionsQuery.isLoading && !sessions.length && <div className="text-sm text-slate-500 text-center py-10">暂无会话，请新建一个。</div>}
          {!sessionsQuery.isLoading && sessions.length > 0 && !visibleSessions.length && <div className="text-sm text-slate-500 text-center py-10">没有匹配的会话。</div>}
          {visibleSessions.map((item) => {
            const runtime = runtimes[item.id]
            const activity = sessionActivity(runtime)
            const highlighted = conflict?.activeSessionId === item.id
            const editing = editingId === item.id
            const confirmingDelete = deleteId === item.id
            return (
              <article key={item.id} className={clsx('rounded-xl border px-4 py-3 bg-bg-soft', highlighted ? 'border-amber-400/60 ring-1 ring-amber-400/20' : 'border-line')}>
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    {editing ? (
                      <div className="flex gap-2">
                        <input aria-label="会话标题" value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void saveTitle(item.id); if (e.key === 'Escape') setEditingId('') }} autoFocus className="min-w-0 flex-1 rounded-lg border border-accent bg-bg-card px-2 py-1 text-sm text-slate-100 outline-none" />
                        <button type="button" disabled={busyId === item.id} onClick={() => void saveTitle(item.id)} className="px-2 py-1 rounded-lg bg-accent text-xs text-white disabled:opacity-50">保存</button>
                        <button type="button" onClick={() => setEditingId('')} className="px-2 py-1 rounded-lg border border-line text-xs text-slate-300">取消</button>
                      </div>
                    ) : (
                      <button type="button" onClick={() => select(item.id)} className="w-full text-left">
                        <div className="text-sm text-slate-100 truncate">{displayTitle(item)}</div>
                        <div className="text-[11px] text-slate-500 mt-1 truncate">{item.id} · 模型 {item.llm_index ?? '默认'} · 更新于 {new Date(item.updated_at).toLocaleString()}</div>
                      </button>
                    )}
                  </div>
                  <span className={clsx('shrink-0 rounded-full border px-2 py-1 text-[11px]', statusTone[activity])}>{sessionStatusLabel(runtime)}</span>
                  {!editing && <button type="button" onClick={() => { setDraftTitle(displayTitle(item)); setEditingId(item.id); setDeleteId(''); setError('') }} className="shrink-0 px-2 py-1.5 rounded-lg border border-line text-xs text-slate-300 hover:bg-white/5">重命名</button>}
                  {activity === 'active' ? (
                    <button type="button" disabled={busyId === item.id} onClick={() => void stop(item.id)} className="shrink-0 px-3 py-1.5 rounded-lg border border-rose-400/40 text-xs text-rose-300 hover:bg-rose-400/10 disabled:opacity-50">{busyId === item.id ? '停止中…' : '停止'}</button>
                  ) : (
                    <button type="button" onClick={() => select(item.id)} className="shrink-0 px-3 py-1.5 rounded-lg border border-line text-xs text-slate-300 hover:bg-white/5">打开</button>
                  )}
                  {!editing && <button type="button" disabled={activity === 'active' || busyId === item.id} title={activity === 'active' ? '请先停止任务再删除' : '删除会话'} onClick={() => { setDeleteId(item.id); setEditingId(''); setError('') }} className="shrink-0 px-2 py-1.5 rounded-lg border border-rose-400/30 text-xs text-rose-300 hover:bg-rose-400/10 disabled:cursor-not-allowed disabled:opacity-40">删除</button>}
                </div>
                {confirmingDelete && (
                  <div role="alertdialog" aria-label={`确认删除 ${displayTitle(item)}`} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs text-rose-100">
                    <span>确认删除“{displayTitle(item)}”？会话元数据将被移除，此操作不可撤销。</span>
                    <span className="flex gap-2">
                      <button type="button" disabled={busyId === item.id} onClick={() => void remove(item.id)} className="rounded-lg bg-rose-500 px-3 py-1.5 text-white disabled:opacity-50">{busyId === item.id ? '删除中…' : '确认删除'}</button>
                      <button type="button" onClick={() => setDeleteId('')} className="rounded-lg border border-line px-3 py-1.5 text-slate-200">取消</button>
                    </span>
                  </div>
                )}
              </article>
            )
          })}
        </div>
      </section>
    </div>
  )
}
