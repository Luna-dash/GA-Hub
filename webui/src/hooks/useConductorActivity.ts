// useConductorActivity — durable 动态 history for one task.
//
// The timeline used to be a live-only SSE projection, so a task reopened from
// history showed "暂无动态" while its dossier still held the result. The hub now
// keeps the timeline in its store and serves it from
// `GET /api/conductor/activity`; this hook pulls that history into the same
// store the live feed writes to, and pages backwards for scroll-up.
//
// It writes rather than returns: the timeline renders the store's rows for the
// selected task, so a hydrated row and a live row are the same kind of thing
// (they even share an id) and need no reconciliation at the call site.
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { useConductorStore } from '@/stores/conductorStore'

/** Rows per hub page. Bounded well under the route's limit. */
export const ACTIVITY_PAGE_SIZE = 200

export type ConductorActivityHistory = {
  /** Rows older than the oldest one held may still exist on the hub. */
  hasMore: boolean
  isLoading: boolean
  /** True once a read has answered for the current task (or failed). */
  isFetched: boolean
  error: boolean
  /** Pull the window before the oldest row held; with none held, retry. */
  loadOlder: () => void
}

export function useConductorActivity(requestId: string | null, enabled = true): ConductorActivityHistory {
  const hydrateActivity = useConductorStore((state) => state.hydrateActivity)
  // Bumped by the store's `clear()`, which is what an engine resync does: the
  // live rows are dropped, so the durable read has to run again or an open
  // timeline would stay empty until the user navigated away and back.
  const generation = useConductorStore((state) => state.generation)
  const [hasMore, setHasMore] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [isFetched, setIsFetched] = useState(false)
  const [error, setError] = useState(false)
  // Oldest atMs pulled for the current task — the pivot for paging backwards.
  // A ref because a landed page must not retrigger the initial effect.
  const cursor = useRef<number | null>(null)
  // A late answer to a superseded task must never hydrate the new one.
  const ticket = useRef(0)
  const busy = useRef(false)

  const read = useCallback(async (beforeMs?: number) => {
    if (!requestId || !enabled) return
    const mine = ++ticket.current
    const current = () => ticket.current === mine
    busy.current = true
    setIsLoading(true)
    try {
      const page = await api.conductorActivity(requestId, {
        limit: ACTIVITY_PAGE_SIZE,
        ...(beforeMs === undefined ? {} : { beforeMs }),
      })
      if (!current()) return
      hydrateActivity(page.items, requestId)
      const oldest = page.items.length > 0 ? page.items[0].atMs : null
      if (oldest !== null) {
        cursor.current = beforeMs === undefined ? oldest : Math.min(beforeMs, oldest)
      }
      setHasMore(page.has_more)
      setError(false)
    } catch {
      // A failed read is not "this task has no activity": the page must be able
      // to say so rather than present an empty timeline as a fact.
      if (current()) setError(true)
    } finally {
      if (current()) {
        busy.current = false
        setIsLoading(false)
        setIsFetched(true)
      }
    }
  }, [enabled, hydrateActivity, requestId])

  useEffect(() => {
    cursor.current = null
    busy.current = false
    ticket.current += 1
    setHasMore(false)
    setError(false)
    setIsFetched(false)
    if (!requestId || !enabled) {
      // The tab is not open: live rows still land in the store, and opening it
      // fetches the durable history then. Reading eagerly would spend a request
      // per task selection for a panel nobody looked at.
      setIsLoading(false)
      return
    }
    void read()
    // `read` changes with requestId/enabled; `generation` re-runs the read after
    // a resync wiped the store.
  }, [enabled, generation, read, requestId])

  const loadOlder = useCallback(() => {
    if (busy.current) return
    // No cursor means nothing has been read yet (first load failed, or the
    // task held no rows) — reading the newest page again is the retry.
    const pivot = cursor.current
    // `+ 1` is deliberate, not an off-by-one: `beforeMs` is an exclusive bound
    // on the hub side, and rows may share a millisecond. Passing `pivot` flat
    // would skip the rest of that millisecond's bucket forever; passing
    // `pivot + 1` re-reads it, and the store dedupes by id.
    void read(pivot === null ? undefined : pivot + 1)
  }, [read])

  return { hasMore, isLoading, isFetched, error, loadOlder }
}
