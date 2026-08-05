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

function sessionTitle(session: HubSession) {
  return session.title.trim() || `未命名会话 · ${session.id.slice(0, 8)}`
}

export function SessionRail({ sessions, runtimes, currentId, onSelect }: SessionRailProps) {
  return (
    <aside aria-label="会话工作区" className="h-28 md:h-auto md:w-56 shrink-0 border-b md:border-b-0 md:border-r border-line/70 bg-bg-card/55 p-2 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto">
      <div className="hidden md:block px-2 pb-2 text-[11px] font-semibold tracking-wider text-[#86775F]">会话</div>
      <div className="flex md:block gap-1 md:space-y-1">
        {sessions.map((session) => {
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
                'w-48 md:w-full shrink-0 rounded-xl border px-3 py-2.5 text-left transition-colors',
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
  )
}
