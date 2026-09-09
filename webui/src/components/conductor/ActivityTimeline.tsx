// ActivityTimeline — human-meaningful Conductor lifecycle feed.
//
// Rows come from the store's activity projection (RuntimeEffects captures
// conductor:subagent_* / workflow_* / request_outcome SSE topics). The
// engine's model-turn log (conductor:log) is deliberately NOT rendered —
// the page shows what a human acts on, not model chatter.
import { useMemo } from 'react'
import clsx from 'clsx'
import { useConductorStore, type ConductorActivityEvent } from '@/stores/conductorStore'
import { formatClock } from '@/utils/timeFormat'

const KIND_TONE: Record<ConductorActivityEvent['kind'], string> = {
  worker_spawned: 'bg-status-info',
  worker_completed: 'bg-status-info',
  worker_failed: 'bg-status-danger',
  worker_timeout: 'bg-status-danger',
  worker_accepted: 'bg-status-success-strong',
  worker_rejected: 'bg-status-warning-strong',
  workflow_completed: 'bg-status-success-strong',
  workflow_failed: 'bg-status-danger',
  workflow_cancelled: 'bg-[#9A8E7D]',
  workflow_killed: 'bg-[#9A8E7D]',
  turn_completed: 'bg-status-success',
  turn_failed: 'bg-status-danger',
  turn_yielded: 'bg-[#9A8E7D]',
}

const VISIBLE_ROWS = 30

export function ActivityTimeline({ requestId }: { requestId: string | null }) {
  const activity = useConductorStore((s) => s.activity)

  const rows = useMemo(() => {
    const scoped = requestId
      ? activity.filter((event) => event.request_id === requestId)
      : activity
    return scoped.slice(-VISIBLE_ROWS).reverse()
  }, [activity, requestId])

  return (
    <section
      aria-label="任务动态"
      className="min-h-0 flex-1 overflow-y-auto py-3"
    >
      <div className="flex w-full items-center gap-2 px-4 py-2">
        <span className="text-sm font-semibold text-ink">动态</span>
        {rows.length > 0 && (
          <span className="text-[11px] text-ink-muted">{rows.length}</span>
        )}
      </div>
      {(
        rows.length === 0 ? (
          <p className="px-3.5 pb-2.5 text-[11px] leading-4 text-ink-faint">
            暂无动态
          </p>
        ) : (
          <ol className="px-4 py-2 text-xs leading-5">
            {rows.map((event) => (
              <li key={event.id} className="flex items-start gap-2 py-0.5">
                <span
                  className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', KIND_TONE[event.kind])}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 break-words text-ink-muted">{event.text}</span>
                <span className="shrink-0 text-[10px] text-ink-faint">{formatClock(event.at)}</span>
              </li>
            ))}
          </ol>
        )
      )}
    </section>
  )
}
