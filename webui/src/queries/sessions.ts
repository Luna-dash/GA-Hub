import type { QueryClient } from '@tanstack/react-query'
import type { HubSession } from '@/api/types'
import { api } from '@/api/client'
import { openSessionChat } from '@/utils/sessionUi'
import { queryKeys } from './queryKeys'

export type SessionListData = { total: number; items: HubSession[] }

/** One new-chat action for the rail, slash commands and command palette.
 * Keep the old conversation intact; select only if the caller still owns the
 * view when creation finishes. A created session always belongs in the list.
 */
export async function createAndOpenSession(
  client: QueryClient,
  navigate: (to: string) => void,
  llmKey: string | undefined | null,
  canSelect: () => boolean = () => true,
): Promise<boolean> {
  if (!llmKey) throw new Error('当前没有可用模型，请先配置模型')
  const next = await api.createSession({ title: '', llm_key: llmKey })
  // An older list response must not hide the session we just created.
  await client.cancelQueries({ queryKey: queryKeys.sessions, exact: true })
  client.setQueryData<SessionListData>(queryKeys.sessions, (current) => ({
    total: (current?.total ?? 0) + (current?.items.some((item) => item.id === next.id) ? 0 : 1),
    items: [next, ...(current?.items ?? []).filter((item) => item.id !== next.id)],
  }))
  if (!canSelect()) return false
  openSessionChat(navigate, next.id)
  return true
}

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
