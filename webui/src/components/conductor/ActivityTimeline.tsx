// ActivityTimeline — human-meaningful Conductor lifecycle feed.
//
// Rows come from the store's activity projection. Two feeds write there and
// they agree on ids, so they collapse instead of doubling:
//   - live: RuntimeEffects captures conductor:subagent_* / workflow_* /
//     request_outcome SSE topics (the hub ships the finished row);
//   - durable: useConductorActivity hydrates GET /api/conductor/activity, which
//     is what keeps a task's history readable after a reload or an app restart.
// The engine's model-turn log (conductor:log) is deliberately NOT rendered —
// the page shows what a human acts on, not model chatter.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { useConductorStore, type KnownActivityKind } from '@/stores/conductorStore'
import { useConductorActivity } from '@/hooks/useConductorActivity'
import type { ConductorSubagent } from '@/api/types'
import { briefWorkerTitle, workerNumbers } from './presentation'
import { formatClock } from '@/utils/timeFormat'

// Every kind the hub can author needs a colour here (see
// server/services/conductor_activity.py, whose vocabulary is the wire
// contract). The `satisfies` clause turns a newly added kind into a compile
// error; UNKNOWN_TONE is the runtime backstop for a hub newer than this build.
const UNKNOWN_TONE = 'bg-[#9A8E7D]'

const KIND_TONE: Record<string, string> = {
  worker_spawned: 'bg-status-info',
  worker_started: 'bg-status-info',
  worker_completed: 'bg-status-info',
  worker_pending_review: 'bg-status-info',
  worker_failed: 'bg-status-danger',
  worker_timeout: 'bg-status-danger',
  worker_accepted: 'bg-status-success-strong',
  worker_rejected: 'bg-status-warning-strong',
  worker_reworked: 'bg-status-warning-strong',
  worker_force_accepted: 'bg-status-warning-hot',
  worker_cancelled: UNKNOWN_TONE,
  worker_killed: UNKNOWN_TONE,
  worker_milestone: 'bg-status-success',
  workflow_completed: 'bg-status-success-strong',
  workflow_failed: 'bg-status-danger',
  workflow_cancelled: UNKNOWN_TONE,
  workflow_killed: UNKNOWN_TONE,
  turn_completed: 'bg-status-success',
  turn_failed: 'bg-status-danger',
  turn_yielded: UNKNOWN_TONE,
} satisfies Record<KnownActivityKind, string>

/** How many rows a first render shows, and how many each "load older" adds. */
const WINDOW_STEP = 30
/** px from the bottom that counts as "asked for more". */
const SCROLL_TRIGGER_PX = 24

export function ActivityTimeline({ requestId, active = true }: { requestId: string | null; active?: boolean }) {
  const activity = useConductorStore((s) => s.activity)
  const subagents = useConductorStore((s) => s.subagents)
  const { hasMore, isLoading, isFetched, error, loadOlder } = useConductorActivity(requestId, active)
  const [windowSize, setWindowSize] = useState(WINDOW_STEP)
  const scrollRef = useRef<HTMLElement | null>(null)

  // A new task starts its own window: a count carried over from the previous
  // one would open the feed at an arbitrary depth.
  useEffect(() => {
    setWindowSize(WINDOW_STEP)
    // Top of the list is the newest row; a scroll offset from the previous task
    // would land the reader mid-history.
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [requestId])

  // "子代理已通过" alone reads as noise: resolve each worker event back to
  // its stable card number and brief title, using the same dispatch-order
  // numbering as the worker cards.
  const workerInfo = useMemo(() => {
    const byRequest = new Map<string, ConductorSubagent[]>()
    for (const worker of subagents) {
      if (!worker.request_id) continue
      const siblings = byRequest.get(worker.request_id) ?? []
      siblings.push(worker)
      byRequest.set(worker.request_id, siblings)
    }
    const info = new Map<string, { number: number; title: string }>()
    for (const siblings of byRequest.values()) {
      const numbers = workerNumbers(siblings)
      for (const worker of siblings) {
        info.set(worker.id, { number: numbers.get(worker.id) ?? 0, title: briefWorkerTitle(worker) })
      }
    }
    return info
  }, [subagents])

  const scoped = useMemo(
    () => (requestId ? activity.filter((event) => event.request_id === requestId) : activity),
    [activity, requestId],
  )
  // Newest first: the newest row is what a reader wants on arrival, and older
  // ones stack below it.
  const rows = useMemo(() => scoped.slice(-windowSize).reverse(), [scoped, windowSize])

  const heldCount = scoped.length
  const canRevealHeld = heldCount > rows.length
  const canLoadMore = canRevealHeld || hasMore

  const revealOlder = useCallback(() => {
    if (isLoading) return
    setWindowSize((size) => size + WINDOW_STEP)
    // When the window has caught up with what the store holds, the rest lives
    // on the hub; ask for it in the same gesture.
    if (heldCount <= windowSize && hasMore) loadOlder()
  }, [hasMore, heldCount, isLoading, loadOlder, windowSize])

  // Typed structurally rather than via React's UIEvent generic so the handler
  // stays assignable across React type versions.
  const onScroll = useCallback((event: { currentTarget: HTMLElement }) => {
    const node = event.currentTarget
    // Only when the list actually scrolls: a short list pinned at the bottom
    // would otherwise chain-load every remaining page in one gesture.
    if (node.scrollHeight <= node.clientHeight) return
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - SCROLL_TRIGGER_PX) revealOlder()
  }, [revealOlder])

  return (
    <section
      ref={scrollRef}
      aria-label="任务动态"
      onScroll={onScroll}
      className="min-h-0 flex-1 overflow-y-auto py-3"
    >
      <div className="flex w-full items-center gap-2 px-4 py-2">
        <span className="text-sm font-semibold text-ink">动态</span>
        {heldCount > 0 && <span className="text-[11px] text-ink-muted">{heldCount}</span>}
      </div>
      {heldCount === 0 ? (
        <p className="px-3.5 pb-2.5 text-[11px] leading-4 text-ink-faint">
          {error
            ? <>动态载入失败，<button type="button" className="underline" onClick={loadOlder}>重试</button></>
            : requestId && !isFetched
              ? '正在载入动态…'
              : '暂无动态'}
        </p>
      ) : (
        <>
          <ol className="px-4 py-2 text-xs leading-5">
            {rows.map((event) => {
              const worker = event.worker_id ? workerInfo.get(event.worker_id) : undefined
              const label = worker ? `#${worker.number} ${worker.title}` : ''
              return (
                <li key={event.id} className="flex items-start gap-2 py-0.5">
                  <span
                    className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', KIND_TONE[event.kind] ?? UNKNOWN_TONE)}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 break-words text-ink-muted">
                    {label && <span className="conductor-activity-worker">{label}</span>}
                    {event.text}
                  </span>
                  <span className="shrink-0 text-[10px] text-ink-faint">{formatClock(event.at)}</span>
                </li>
              )
            })}
          </ol>
          {canLoadMore && (
            <div className="px-4 pb-2">
              <button
                type="button"
                onClick={revealOlder}
                disabled={isLoading}
                className="text-[11px] text-ink-muted underline disabled:opacity-60"
              >
                {isLoading ? '正在载入更早的动态…' : '加载更早的动态'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
