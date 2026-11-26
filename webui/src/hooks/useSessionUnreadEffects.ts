import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { antiApi, api, type AntiSession } from '@/api/client'
import type { SessionRuntime } from '@/api/types'
import { queryKeys } from '@/queries/queryKeys'
import { markSessionUsed } from '@/queries/sessions'
import { hubEventClient } from '@/runtime/hubEventClient'
import {
  markSessionActive,
  reconcileScopeSessions,
  recordSessionTerminal,
  syncRuntimeSnapshot,
} from '@/stores/sessionUnreadStore'
import { antiSessionToRuntime, sessionActivity } from '@/utils/sessionUi'

/** Global lifetime: keep Chat & Agy unread state synchronized across routes and reconnects. */
export function useSessionUnreadEffects() {
  const qc = useQueryClient()

  useEffect(() => {
    let alive = true

    const isChatThemeTask = async (sessionId: string): Promise<boolean> => {
      const cached = qc.getQueryData<Awaited<ReturnType<typeof api.sessions>>>(queryKeys.sessions)
      let found = cached?.items.find((item) => item.id === sessionId)
      if (!found) {
        try {
          const fresh = await qc.fetchQuery({
            queryKey: queryKeys.sessions,
            queryFn: api.sessions,
            staleTime: 1000,
          })
          found = fresh.items.find((item) => item.id === sessionId)
        } catch {
          return false
        }
      }
      return Boolean(found?.theme_task)
    }

    const reconcileChat = async () => {
      try {
        const [sessionsResp, runtimes] = await Promise.all([
          qc.fetchQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions, staleTime: 1000 }),
          qc.fetchQuery({ queryKey: queryKeys.runtimes, queryFn: api.sessionRuntimes, staleTime: 1000 }),
        ])
        if (!alive) return
        const validIds = new Set(sessionsResp.items.filter((s) => !s.theme_task).map((s) => s.id))
        syncRuntimeSnapshot('chat', runtimes, validIds)
      } catch {
        // Retry on next reconnect or event; never clear unread when offline.
      }
    }

    const reconcileAnti = async () => {
      try {
        const rows = await qc.fetchQuery({
          queryKey: queryKeys.antiSessions,
          queryFn: ({ signal }) => antiApi.sessions(signal),
          staleTime: 1000,
        })
        if (!alive) return
        const validIds = new Set<string>()
        const runtimes: Record<string, SessionRuntime> = {}
        for (const row of rows) {
          validIds.add(row.id)
          runtimes[row.id] = antiSessionToRuntime(row)
        }
        syncRuntimeSnapshot('anti', runtimes, validIds)
      } catch {
        // Retry on next reconnect or event; never clear unread when offline.
      }
    }

    const reconcileAll = () => {
      void reconcileChat()
      void reconcileAnti()
    }

    const chatKeyJson = JSON.stringify(queryKeys.sessions)
    const antiKeyJson = JSON.stringify(queryKeys.antiSessions)
    const offCache = qc.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success' || !alive) return
      const keyJson = JSON.stringify(event.query.queryKey)
      if (keyJson === chatKeyJson) {
        const data = event.query.state.data as Awaited<ReturnType<typeof api.sessions>> | undefined
        if (Array.isArray(data?.items)) {
          reconcileScopeSessions('chat', new Set(data.items.filter((s) => !s.theme_task).map((s) => s.id)))
        }
      } else if (keyJson === antiKeyJson) {
        const data = event.query.state.data as AntiSession[] | undefined
        if (Array.isArray(data)) {
          reconcileScopeSessions('anti', new Set(data.map((s) => s.id)))
        }
      }
    })

    const offChatRuntime = hubEventClient.subscribe('session:runtime', (event) => {
      if (event.topic !== 'session:runtime') return
      const state = event.payload as Partial<SessionRuntime> | undefined
      const sid = state?.session_id
      if (typeof sid !== 'string' || !sid) return

      qc.setQueryData<Record<string, SessionRuntime>>(queryKeys.runtimes, (current) => ({
        ...(current ?? {}),
        [sid]: {
          ...(current?.[sid] ?? {}),
          ...state,
        } as SessionRuntime,
      }))

      if (state.status === 'idle' && state.completed_run_id) {
        markSessionUsed(qc, sid)
        void qc.invalidateQueries({ queryKey: queryKeys.sessions, exact: true })
      }

      void (async () => {
        if ((await isChatThemeTask(sid)) || !alive) return
        const full = state as SessionRuntime
        if (sessionActivity(full) === 'active') {
          markSessionActive('chat', sid)
        } else if (full.completed_run_id) {
          recordSessionTerminal(
            'chat',
            sid,
            full.completed_run_id,
            full.outcome ?? (full.error ? 'failed' : 'completed'),
          )
        } else if (full.status === 'error') {
          recordSessionTerminal('chat', sid, full.run_id ?? 'error', 'failed')
        }
      })()
    })

    const offAntiRuntime = hubEventClient.subscribe('anti:runtime', (event) => {
      if (event.topic !== 'anti:runtime') return
      const payload = event.payload
      if (!payload || typeof payload.session_id !== 'string' || !payload.session_id) return
      const sid = payload.session_id

      qc.setQueryData<AntiSession[]>(queryKeys.antiSessions, (current) => {
        if (!Array.isArray(current)) return current
        return current.map((row) => {
          if (row.id !== sid) return row
          return {
            ...row,
            ...(payload.title ? { title: payload.title } : {}),
            ...(payload.updated_at ? { updated_at: payload.updated_at } : {}),
            active_run_id: payload.status === 'running' ? payload.run_id : null,
            completed_run_id: payload.status === 'idle' ? (payload.completed_run_id ?? null) : null,
            last_outcome: payload.status === 'idle' ? (payload.outcome ?? null) : null,
            last_error: payload.status === 'idle' ? (payload.error ?? null) : null,
          }
        })
      })
      void qc.invalidateQueries({ queryKey: queryKeys.antiSessions, exact: true })

      if (payload.status === 'running') {
        markSessionActive('anti', sid)
      } else if (payload.completed_run_id) {
        recordSessionTerminal(
          'anti',
          sid,
          payload.completed_run_id,
          payload.outcome ?? (payload.error ? 'failed' : 'completed'),
        )
      }
    })

    reconcileAll()
    const offState = hubEventClient.subscribeState((state) => {
      if (state === 'open') reconcileAll()
    })
    const offControl = hubEventClient.subscribeControl((control) => {
      if (control.type === 'resync_required') reconcileAll()
    })

    return () => {
      alive = false
      offCache()
      offChatRuntime()
      offAntiRuntime()
      offState()
      offControl()
    }
  }, [qc])
}
