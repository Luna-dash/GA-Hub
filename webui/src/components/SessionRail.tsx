import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { HubSession, SessionRuntime } from '@/api/types'
import { sessionActivity, sessionStatusLabel } from '@/utils/sessionUi'

interface SessionRailProps {
  sessions: HubSession[]
  runtimes: Record<string, SessionRuntime>
  currentId: string | null
  onSelect: (sessionId: string) => void
  onCreate?: () => Promise<void> | void
  onRename?: (sessionId: string, title: string) => Promise<void> | void
  creating?: boolean
}

const activityDot = {
  active: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]',
  idle: 'bg-[#9A8B70]',
  error: 'bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,0.16)]',
  unknown: 'bg-amber-500',
}

const activityCard = {
  active: 'border-emerald-400/60 bg-emerald-50/80 text-emerald-950 shadow-[inset_3px_0_0_rgba(16,185,129,0.65)] hover:bg-emerald-50',
  idle: 'border-transparent text-[#665741] hover:border-line hover:bg-bg-card',
  error: 'border-rose-400/60 bg-rose-50/80 text-rose-950 shadow-[inset_3px_0_0_rgba(244,63,94,0.65)] hover:bg-rose-50',
  unknown: 'border-amber-400/55 bg-amber-50/70 text-amber-950 hover:bg-amber-50',
}

const STORAGE_KEY = 'gahub.sessionRailCollapsed'

function sessionTitle(session: HubSession) {
  return session.title.trim() || `未命名会话 · ${session.id.slice(0, 8)}`
}

function isVisibleSession(session: HubSession, currentId: string | null, runtime?: SessionRuntime) {
  return session.id === currentId
    || Boolean(session.title.trim())
    || Boolean(session.archive_path)
    || (runtime != null && sessionActivity(runtime) !== 'idle')
}

export function SessionRail({ sessions, runtimes, currentId, onSelect, onCreate, onRename, creating }: SessionRailProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const visibleSessions = useMemo(
    () => sessions.filter((session) => isVisibleSession(session, currentId, runtimes[session.id])),
    [currentId, runtimes, sessions],
  )
  const hiddenCount = sessions.length - visibleSessions.length

  const toggle = () => {
    setCollapsed((current) => {
      localStorage.setItem(STORAGE_KEY, String(!current))
      return !current
    })
  }

  const beginRename = (session: HubSession) => {
    setEditingId(session.id)
    setTitleDraft(session.title)
  }

  const finishRename = async (session: HubSession) => {
    if (savingId) return
    const title = titleDraft.trim()
    setEditingId(null)
    if (!onRename || title === session.title) return
    setSavingId(session.id)
    try {
      await onRename(session.id, title)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div
      data-collapsed={collapsed ? 'true' : 'false'}
      className={clsx(
        'relative z-20 shrink-0 transition-[width,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        collapsed ? 'h-0 w-full md:h-auto md:w-0' : 'h-32 w-full md:h-auto md:w-64',
      )}
    >
      <aside
        aria-label="会话工作区"
        aria-hidden={collapsed}
        className={clsx(
          'absolute inset-0 overflow-x-auto border-b border-line/70 bg-bg-card/55 p-2 md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r',
          'transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          collapsed
            ? 'pointer-events-none -translate-y-3 opacity-0 md:-translate-x-3 md:translate-y-0'
            : 'translate-x-0 translate-y-0 opacity-100',
        )}
      >
        <div className="mb-2 flex items-center justify-between gap-2 px-1">
          <span className="text-[11px] font-semibold tracking-wider text-[#86775F]">会话工作区</span>
          {onCreate && (
            <button
              type="button"
              onClick={() => { void onCreate() }}
              disabled={creating}
              aria-label="新建会话"
              className="rounded-lg border border-accent/35 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent transition hover:bg-accent/20 disabled:opacity-50"
              title="新建会话"
            >
              {creating ? '创建中…' : '＋ 新建'}
            </button>
          )}
        </div>
        <div className="flex gap-2 md:flex-col">
          {visibleSessions.map((session) => {
            const runtime = runtimes[session.id]
            const activity = sessionActivity(runtime)
            const current = session.id === currentId
            const editing = editingId === session.id
            return (
              <div
                key={session.id}
                data-activity={activity}
                className={clsx(
                  'group relative w-52 shrink-0 rounded-xl border transition-colors md:w-full',
                  activityCard[activity],
                  current && 'ring-2 ring-accent/35 ring-offset-1 ring-offset-bg-card',
                )}
              >
                {editing ? (
                  <input
                    autoFocus
                    value={titleDraft}
                    onChange={(event) => setTitleDraft(event.target.value)}
                    onBlur={() => { void finishRename(session) }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                      if (event.key === 'Escape') setEditingId(null)
                    }}
                    disabled={savingId === session.id}
                    aria-label={`重命名 ${sessionTitle(session)}`}
                    className="m-2 mb-1 w-[calc(100%-1rem)] rounded-md border border-accent/45 bg-white/90 px-2 py-1 text-sm text-[#2C2418] outline-none ring-accent/20 focus:ring-2"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    onDoubleClick={() => beginRename(session)}
                    aria-current={current ? 'page' : undefined}
                    className="block w-full px-3 pb-1 pt-2.5 text-left"
                  >
                    <span className="flex items-center gap-2 pr-6">
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', activityDot[activity])} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={sessionTitle(session)}>{sessionTitle(session)}</span>
                    </span>
                    <span className="block pt-1 pl-4 text-[10px] opacity-70">{sessionStatusLabel(runtime)}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => beginRename(session)}
                  disabled={savingId === session.id}
                  aria-label={`重命名 ${sessionTitle(session)}`}
                  title="重命名会话"
                  className="absolute right-2 top-2 rounded p-1 text-xs opacity-50 transition hover:bg-white/70 hover:opacity-100 focus:opacity-100 disabled:opacity-30"
                >
                  ✎
                </button>
                {editing && (
                  <span className="block px-3 pb-2 pl-7 text-[10px] opacity-70">{savingId === session.id ? '保存中…' : sessionStatusLabel(runtime)}</span>
                )}
              </div>
            )
          })}
        </div>
        {hiddenCount > 0 && <div className="px-2 pt-2 text-[10px] text-[#86775F]">已隐藏 {hiddenCount} 个空会话</div>}
      </aside>
      <button
        type="button"
        aria-label={collapsed ? '展开会话管理' : '折叠会话管理'}
        aria-expanded={!collapsed}
        onClick={toggle}
        title={collapsed ? '展开会话管理' : '折叠会话管理'}
        className={clsx(
          'absolute z-30 flex items-center justify-center border border-line bg-bg-card/95 text-[#665741] shadow-md backdrop-blur-sm hover:bg-white',
          'left-1/2 h-6 w-12 -translate-x-1/2 rounded-b-lg border-t-0 transition-[top,background-color] duration-300',
          'md:left-auto md:top-1/2 md:h-12 md:w-6 md:translate-x-0 md:-translate-y-1/2 md:rounded-b-none md:rounded-r-lg md:border-l-0 md:border-t',
          collapsed ? 'top-0 md:-right-6' : 'top-32 md:-right-6 md:top-1/2',
        )}
      >
        <span className="md:hidden" aria-hidden="true">{collapsed ? '⌄' : '⌃'}</span>
        <span className="hidden md:inline" aria-hidden="true">{collapsed ? '›' : '‹'}</span>
      </button>
    </div>
  )
}
