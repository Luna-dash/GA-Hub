import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { queryKeys } from '@/queries/queryKeys'
import { hubEventClient } from '@/runtime/hubEventClient'
import { recordThemeCompletion, retainThemeCompletions } from '@/stores/themeCompletionStore'

/** Global lifetime: no polling; reconcile once on connect and on terminal events. */
export function useThemeCompletionEffects() {
  const qc = useQueryClient()
  useEffect(() => {
    let alive = true
    const pending = new Map<string, Promise<void>>()
    const inspect = (sessionId: string, afterPending = false): Promise<void> => {
      const existing = pending.get(sessionId)
      if (existing) return afterPending ? existing.then(() => { if (alive) return inspect(sessionId) }) : existing
      const request = api.themeRun(sessionId).then(({ run }) => {
        if (alive) recordThemeCompletion(sessionId, run)
      }).catch(() => {}).finally(() => { pending.delete(sessionId) })
      pending.set(sessionId, request)
      return request
    }
    const sessions = () => qc.fetchQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions, staleTime: 1000 })
    const refresh = async () => {
      try {
        const data = await sessions()
        if (!alive) return
        await Promise.all(data.items.filter(s => s.theme_task).map(s => inspect(s.id)))
      } catch { /* Retry on the next connection/event, never clear unread on failure. */ }
    }
    const offSessions = qc.getQueryCache().subscribe(event => {
      if (event.type !== 'updated' || event.action.type !== 'success') return
      if (JSON.stringify(event.query.queryKey) !== JSON.stringify(queryKeys.sessions)) return
      const data = event.query.state.data as Awaited<ReturnType<typeof api.sessions>> | undefined
      if (alive && Array.isArray(data?.items)) retainThemeCompletions(new Set(data.items.filter(s => s.theme_task).map(s => s.id)))
    })
    void refresh()
    const offRuntime = hubEventClient.subscribe('session:runtime', (event) => {
      const runtime = event.payload?.runtime
      const sessionId = event.payload?.session_id
      if (typeof sessionId !== 'string' || !runtime || typeof runtime !== 'object') return
      const state = runtime as { completed_run_id?: string; running?: boolean; status?: string }
      if (!state.completed_run_id || state.running || state.status === 'running' || state.status === 'aborting' || state.status === 'waiting_user') return
      void sessions().then(data => {
        if (alive && data.items.some(s => s.id === sessionId && s.theme_task)) void inspect(sessionId, true)
      }).catch(() => {})
    })
    const offState = hubEventClient.subscribeState(state => { if (state === 'open') void refresh() })
    const offControl = hubEventClient.subscribeControl(control => { if (control.type === 'resync_required') void refresh() })
    return () => { alive = false; offRuntime(); offState(); offControl(); offSessions() }
  }, [qc])
}
