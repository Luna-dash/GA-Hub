import type { QueryClient } from '@tanstack/react-query'
import type { HubSession } from '@/api/types'
import { queryKeys } from './queryKeys'

export type SessionListData = { total: number; items: HubSession[] }

/** Optimistically mark one session as "just used", so the rail lifts it now.
 *
 * The sidecar already bumps `updated_at` on submit (`sessions.py` → `_store.touch`),
 * but the chat page never revalidated `['sessions']`: with `staleTime: 30_000`
 * and `refetchOnWindowFocus: false`, the cached list only refreshed on a
 * WebSocket reconnect or a page remount, so the row you just sent in could sit
 * in the middle of the rail for minutes. This patches the cached row at the
 * moment of the send; the caller revalidates once the run request settles so
 * the sidecar stays the single source of truth.
 */
export function markSessionUsed(
  client: QueryClient,
  sessionId: string,
  at: Date = new Date(),
): void {
  const stamp = at.toISOString()
  client.setQueryData<SessionListData>(queryKeys.sessions, (current) => (
    current
      ? {
          ...current,
          items: current.items.map((item) => (
            item.id === sessionId ? { ...item, updated_at: stamp } : item
          )),
        }
      : current
  ))
}
