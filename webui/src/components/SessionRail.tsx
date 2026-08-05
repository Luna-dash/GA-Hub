import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { HubSession, SessionRuntime } from '@/api/types'
import { sessionActivity, sessionStatusLabel } from '@/utils/sessionUi'

interface SessionRailProps {
  sessions: HubSession[]
  runtimes: Record<string, SessionRuntime>
  currentId: string | null
  onSelect: (sessionId: string) => void
}

const activityDot = {
  active: 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.14)]',
  idle: 'bg-[#9A8B70]',
  error: 'bg-rose-500 shadow-[0_0_0_3px_rgba(244,63,94,0.12)]',
  unknown: 'bg-amber-500',
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

export function SessionRail({ sessions, runtimes, currentId, onSelect }: SessionRailProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')
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

  return (
    <div
      data-collapsed={collapsed ? 'true' : 'false'}
      className={clsx(
        'relative z-20 shrink-0 transition-[width,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        collapsed ? 'h-0 w-full md:h-auto md:w-0' : 'h-28 w-full md:h-auto md:w-56',
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
        <div className="hidden px-2 pb-2 text-[11px] font-semibold tracking-wider text-[#86775F] md:flex md:items-center md:justify-between">
          <span>会话</span>
          {hiddenCount > 0 && <span className="font-normal tracking-normal">已隐藏 {hiddenCount} 个空会话</span>}
        </div>
        <div className="flex gap-1 md:block md:space-y-1">
          {visibleSessions.map((session) => {
            const runtime = runtimes[session.id]
            const activity = sessionActivity(runtime)
            const current = session.id === currentId
            return (
              <button
                key={session.id}
                type="button"
                aria-current={current ? 'page' : undefined}
                onClick={() => onSelect(session.id)}
                className={clsx(
                  'w-48 shrink-0 rounded-xl border px-3 py-2.5 text-left transition-colors md:w-full',
                  current
                    ? 'border-accent/45 bg-accent/10 text-[#2C2418]'
                    : 'border-transparent text-[#665741] hover:border-line hover:bg-bg-card',
                )}
              >
                <span className="flex items-center gap-2">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-full', activityDot[activity])} />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={sessionTitle(session)}>{sessionTitle(session)}</span>
                </span>
                <span className="mt-1 block pl-4 text-[10px] text-[#86775F]">{sessionStatusLabel(runtime)}</span>
              </button>
            )
          })}
        </div>
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
          collapsed ? 'top-0 md:-right-6' : 'top-28 md:-right-6 md:top-1/2',
        )}
      >
        <span className="md:hidden" aria-hidden="true">{collapsed ? '⌄' : '⌃'}</span>
        <span className="hidden md:inline" aria-hidden="true">{collapsed ? '›' : '‹'}</span>
      </button>
    </div>
  )
}
