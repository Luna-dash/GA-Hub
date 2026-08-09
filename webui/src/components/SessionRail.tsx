import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  onDelete?: (sessionId: string) => Promise<void> | void
  creating?: boolean
}

const activityDot = {
  active: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.18)]',
  completed: 'bg-sky-500 shadow-[0_0_0_3px_rgba(14,165,233,0.16)]',
  idle: 'bg-[#9A8B70]',
  error: 'bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,0.16)]',
  unknown: 'bg-amber-500',
}

const activityCard = {
  active: 'border-emerald-400/60 bg-emerald-50/80 text-emerald-950 shadow-[inset_3px_0_0_rgba(16,185,129,0.65)] hover:bg-emerald-50',
  completed: 'border-sky-400/60 bg-sky-50/80 text-sky-950 shadow-[inset_3px_0_0_rgba(14,165,233,0.65)] hover:bg-sky-50',
  idle: 'border-transparent text-[#665741] hover:border-line hover:bg-bg-card',
  error: 'border-rose-400/60 bg-rose-50/80 text-rose-950 shadow-[inset_3px_0_0_rgba(244,63,94,0.65)] hover:bg-rose-50',
  unknown: 'border-amber-400/55 bg-amber-50/70 text-amber-950 hover:bg-amber-50',
}

const activityLabel = {
  active: '运行中',
  completed: '已完成',
  idle: '空闲',
  error: '异常',
  unknown: '空闲',
}

const activityRail = {
  active: 'bg-emerald-600/75 shadow-[0_0_0_3px_rgba(5,150,105,0.13)] group-hover:bg-emerald-600/90',
  completed: 'bg-sky-600/65 shadow-[0_0_0_3px_rgba(2,132,199,0.11)] group-hover:bg-sky-600/80',
  idle: 'bg-[#8D7B5D]/55 shadow-[0_0_0_3px_rgba(141,123,93,0.10)] group-hover:bg-[#8D7B5D]/70',
  error: 'bg-rose-600/75 shadow-[0_0_0_3px_rgba(225,29,72,0.11)] group-hover:bg-rose-600/90',
  unknown: 'bg-amber-600/65 shadow-[0_0_0_3px_rgba(217,119,6,0.11)] group-hover:bg-amber-600/80',
}

const RECENT_KEY = 'gahub.sessionRailRecentActivity'
const TERMINAL_KEY = 'gahub.sessionRailTerminalState'
const SEEN_COMPLETED_KEY = 'gahub.sessionRailSeenCompletedRuns'
type TerminalState = 'completed' | 'error'
type TerminalMap = Record<string, TerminalState>

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '')
    return value && typeof value === 'object' ? value as T : fallback
  } catch {
    return fallback
  }
}

function sessionTitle(session: HubSession) {
  return session.title.trim() || `未命名会话 · ${session.id.slice(0, 8)}`
}

function SessionRailComponent({ sessions, runtimes, currentId, onSelect, onCreate, onRename, onDelete, creating }: SessionRailProps) {
  const [collapsed, setCollapsed] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [terminalState, setTerminalState] = useState<TerminalMap>(() => readJson<TerminalMap>(TERMINAL_KEY, {}))
  const [seenCompletedRuns, setSeenCompletedRuns] = useState<Record<string, string>>(
    () => readJson<Record<string, string>>(SEEN_COMPLETED_KEY, {}),
  )
  const [recentActivity, setRecentActivity] = useState<string[]>(() => readJson<string[]>(RECENT_KEY, []))
  const previousActivity = useRef<Record<string, ReturnType<typeof sessionActivity>>>({})

  useEffect(() => {
    const nextTerminal = { ...terminalState }
    const nextRecent = [...recentActivity]
    const nextPrevious = { ...previousActivity.current }
    let terminalChanged = false
    let recentChanged = false

    sessions.forEach((session) => {
      const activity = sessionActivity(runtimes[session.id])
      const previous = nextPrevious[session.id]
      if (activity === 'active') {
        if (nextRecent[0] !== session.id) {
          const existingIndex = nextRecent.indexOf(session.id)
          if (existingIndex >= 0) nextRecent.splice(existingIndex, 1)
          nextRecent.unshift(session.id)
          recentChanged = true
        }
        if (nextTerminal[session.id]) {
          delete nextTerminal[session.id]
          terminalChanged = true
        }
      } else if (activity === 'error' && previous === 'active' && nextTerminal[session.id] !== 'error') {
        nextTerminal[session.id] = 'error'
        terminalChanged = true
      } else if (
        activity === 'idle'
        && runtimes[session.id]?.completed_run_id
        && seenCompletedRuns[session.id] !== runtimes[session.id].completed_run_id
        && nextTerminal[session.id] !== 'completed'
      ) {
        nextTerminal[session.id] = 'completed'
        terminalChanged = true
      } else if (activity === 'idle' && previous === 'active' && nextTerminal[session.id] !== 'completed') {
        nextTerminal[session.id] = 'completed'
        terminalChanged = true
      }
      nextPrevious[session.id] = activity
    })

    previousActivity.current = nextPrevious
    if (terminalChanged) {
      setTerminalState(nextTerminal)
      localStorage.setItem(TERMINAL_KEY, JSON.stringify(nextTerminal))
    }
    if (recentChanged) {
      setRecentActivity(nextRecent)
      localStorage.setItem(RECENT_KEY, JSON.stringify(nextRecent.slice(0, 50)))
    }
  }, [runtimes, sessions, recentActivity, seenCompletedRuns, terminalState])

  const orderedSessions = useMemo(() => {
    const rank = new Map(recentActivity.map((id, index) => [id, index]))
    return [...sessions].sort((a, b) => {
      const ar = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const br = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (ar !== br) return ar - br
      return b.updated_at.localeCompare(a.updated_at)
    })
  }, [recentActivity, sessions])

  const displayState = (session: HubSession): 'active' | 'completed' | 'idle' | 'error' => {
    const activity = sessionActivity(runtimes[session.id])
    if (activity === 'active') return 'active'
    return terminalState[session.id] || activity
  }

  const attentionSessions = useMemo(() => (
    orderedSessions
      .filter((session) => {
        const activity = displayState(session)
        return activity === 'active' || activity === 'completed' || activity === 'error'
      })
      .slice(0, 3)
      .reverse()
  ), [orderedSessions, runtimes, terminalState])

  const acknowledgeSession = useCallback((sessionId: string) => {
    const completedRunId = runtimes[sessionId]?.completed_run_id
    if (completedRunId) {
      const storedSeen = readJson<Record<string, string>>(SEEN_COMPLETED_KEY, {})
      if (storedSeen[sessionId] !== completedRunId) {
        const nextSeen = { ...storedSeen, [sessionId]: completedRunId }
        localStorage.setItem(SEEN_COMPLETED_KEY, JSON.stringify(nextSeen))
        setSeenCompletedRuns(nextSeen)
      }
    }

    const storedTerminal = readJson<TerminalMap>(TERMINAL_KEY, {})
    if (storedTerminal[sessionId]) {
      const nextStored = { ...storedTerminal }
      delete nextStored[sessionId]
      localStorage.setItem(TERMINAL_KEY, JSON.stringify(nextStored))
    }
    setTerminalState((current) => {
      if (!current[sessionId]) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [runtimes])

  useEffect(() => {
    if (!currentId) return
    const acknowledgeCurrent = () => acknowledgeSession(currentId)
    window.addEventListener('pointerdown', acknowledgeCurrent, true)
    window.addEventListener('keydown', acknowledgeCurrent, true)
    window.addEventListener('wheel', acknowledgeCurrent, true)
    window.addEventListener('focus', acknowledgeCurrent)
    return () => {
      window.removeEventListener('pointerdown', acknowledgeCurrent, true)
      window.removeEventListener('keydown', acknowledgeCurrent, true)
      window.removeEventListener('wheel', acknowledgeCurrent, true)
      window.removeEventListener('focus', acknowledgeCurrent)
    }
  }, [acknowledgeSession, currentId])

  const selectSession = (sessionId: string) => {
    acknowledgeSession(sessionId)
    onSelect(sessionId)
  }

  const toggle = () => {
    setCollapsed((current) => !current)
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

  const removeSession = async (session: HubSession) => {
    if (!onDelete || deletingId || sessionActivity(runtimes[session.id]) === 'active') return
    setDeletingId(session.id)
    try {
      await onDelete(session.id)
      setConfirmDeleteId(null)
    } finally {
      setDeletingId(null)
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
          {orderedSessions.map((session) => {
            const runtime = runtimes[session.id]
            const activity = displayState(session)
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
                    onClick={() => selectSession(session.id)}
                    onDoubleClick={() => beginRename(session)}
                    aria-current={current ? 'page' : undefined}
                    className="block w-full px-3 pb-1 pt-2.5 text-left"
                  >
                    <span className="flex items-center gap-2 pr-14">
                      <span className={clsx('h-2 w-2 shrink-0 rounded-full', activityDot[activity])} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={sessionTitle(session)}>{sessionTitle(session)}</span>
                    </span>
                    <span className="flex items-center gap-1.5 pt-1 pl-4 text-[10px] opacity-70">
                      <span>{sessionStatusLabel(runtime)}</span>
                      {session.project_name && (
                        <span
                          className="max-w-24 truncate rounded bg-accent/10 px-1.5 py-0.5 text-accent"
                          title={session.project_path || session.project_name}
                          aria-label={`项目：${session.project_name}`}
                        >
                          {session.project_name}
                        </span>
                      )}
                    </span>
                  </button>
                )}
                {!editing && (
                  <div className="absolute right-2 top-2 flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => { setConfirmDeleteId(null); beginRename(session) }}
                      disabled={savingId === session.id || deletingId === session.id}
                      aria-label={`重命名 ${sessionTitle(session)}`}
                      title="重命名会话"
                      className="rounded p-1 text-xs opacity-50 transition hover:bg-white/70 hover:opacity-100 focus:opacity-100 disabled:opacity-30"
                    >
                      ✎
                    </button>
                    {onDelete && (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(session.id)}
                        disabled={activity === 'active' || deletingId === session.id}
                        aria-label={`删除 ${sessionTitle(session)}`}
                        title={activity === 'active' ? '请先停止任务再删除' : '删除会话'}
                        className="rounded p-1 text-xs text-rose-600 opacity-50 transition hover:bg-rose-100 hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-25"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}
                {editing && (
                  <span className="block px-3 pb-2 pl-7 text-[10px] opacity-70">{savingId === session.id ? '保存中…' : sessionStatusLabel(runtime)}</span>
                )}
                {confirmDeleteId === session.id && (
                  <div role="alertdialog" aria-label={`确认删除 ${sessionTitle(session)}`} className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-lg border border-rose-400/35 bg-rose-50/90 px-2 py-1.5 text-[11px] text-rose-700">
                    <span>永久删除？</span>
                    <span className="flex gap-1">
                      <button type="button" disabled={deletingId === session.id} onClick={() => { void removeSession(session) }} className="rounded bg-rose-600 px-2 py-1 text-white disabled:opacity-50">{deletingId === session.id ? '删除中…' : '确认'}</button>
                      <button type="button" disabled={deletingId === session.id} onClick={() => setConfirmDeleteId(null)} className="rounded border border-rose-300 px-2 py-1 disabled:opacity-50">取消</button>
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </aside>
      <div
        aria-label="最近活动会话"
        className={clsx(
          'absolute z-25 flex gap-1.5 transition-[opacity,transform] duration-300 md:flex-col',
          'left-2 right-2 top-1 md:bottom-[calc(50%+2.125rem)] md:left-auto md:right-[-1.5rem] md:top-auto md:w-6',
          collapsed ? 'pointer-events-auto translate-y-0 opacity-100 md:translate-x-0' : 'pointer-events-none -translate-y-2 opacity-0 md:translate-x-2 md:translate-y-0',
        )}
      >
        {attentionSessions.map((session) => {
          const activity = displayState(session)
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => selectSession(session.id)}
              title={`${sessionTitle(session)} · ${activityLabel[activity]}`}
              aria-label={`${sessionTitle(session)}，${activityLabel[activity]}`}
              className={clsx(
                'group flex h-6 w-6 min-w-6 flex-none items-center justify-center rounded-full border border-line bg-bg-card/95 p-0 shadow-sm backdrop-blur-sm transition-[background-color,box-shadow,transform] hover:-translate-y-px hover:bg-white hover:shadow-md focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hover:-translate-x-px md:hover:translate-y-0',
                currentId === session.id && 'border-[#A69676] bg-white shadow-md',
              )}
            >
              <span
                aria-hidden="true"
                className={clsx('h-3 w-3 rounded-full transition-colors', activityRail[activity])}
              />
            </button>
          )
        })}
      </div>
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

export const SessionRail = memo(SessionRailComponent)
