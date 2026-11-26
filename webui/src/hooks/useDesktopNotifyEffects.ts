// Runtime subscriber; completions are independent of the mounted chat page.
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { antiApi, api, type AntiSession } from '@/api/client'
import { queryKeys } from '@/queries/queryKeys'
import type { SessionRuntime } from '@/api/types'
import { openAntiSession, openSessionChat } from '@/utils/sessionUi'
import { hubEventClient } from '@/runtime/hubEventClient'
import { extractPendingAskUserPayload } from '@/utils/assistantTranscript'
import { notify } from '@/utils/notify'
import { markSessionRead } from '@/stores/sessionUnreadStore'

export function useDesktopNotifyEffects() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  useEffect(() => {
    let alive = true
    const seen = new Set<string>()
    const aborted = new Set<string>()
    const onOpen = (id: string, runId?: string) => () => {
      markSessionRead('chat', id, runId)
      openSessionChat(navigate, id)
    }
    const unsubscribeRuntime = hubEventClient.subscribe('session:runtime', (event) => {
      if (event.topic !== 'session:runtime') return
      const state = event.payload as unknown as SessionRuntime
      // completed_run_id is emitted only for settled runs, not a tab/WS switch.
      const run = state.completed_run_id
      if (state.status === 'aborting' && state.run_id) aborted.add(state.run_id)
      if (!state.session_id || !run || state.status !== 'idle' || state.outcome === 'cancelled') return
      if (aborted.delete(run)) return
      const key = `${state.session_id}:${run}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 500) seen.delete(seen.values().next().value!)
      void (async () => {
        let session = qc.getQueryData<Awaited<ReturnType<typeof api.sessions>>>(queryKeys.sessions)?.items.find(s => s.id === state.session_id)
        if (!session?.title) {
          try { session = (await api.sessions()).items.find(s => s.id === state.session_id) ?? session } catch { /* use id */ }
        }
        const name = session?.title
        const themeTask = !!session?.theme_task
        const failed = state.outcome === 'failed' || !!state.error
        let needsInput = false
        let classified = false
        if (!failed) try {
          const snapshot = await api.getSessionMessages(state.session_id, { limit: 2 })
          const last = snapshot.items.at(-1)
          classified = last?.role === 'assistant' && (!last.run_id || last.run_id === run)
            && last.outcome !== 'cancelled' && last.outcome !== 'failed'
          // A newer run may already be visible by the time this fetch returns.
          // Never use its question to classify a previous completion.
          needsInput = last?.role === 'assistant'
            && (!last.run_id || last.run_id === run)
            && last.outcome !== 'cancelled' && last.outcome !== 'failed'
            && !!extractPendingAskUserPayload(last.content)
        } catch { /* still report completion without leaking output */ }
        if (!alive) return
        await notify(failed ? '会话处理失败' : needsInput ? '需要你回复一下' : classified ? '可以查看结果了' : '会话有更新', {
          body: `「${String(name || state.session_id).replace(/\s+/g, ' ').slice(0, 64)}」${failed ? '本次处理未能完成，请进入会话查看原因。' : needsInput ? '有问题需要你回答，回复后即可继续。' : classified ? '已结束本次处理，结果已可查看。' : '已结束本次处理，进去看看最新状态吧。'}`,
          // Theme tasks open their conclusion; questions still go to the chat.
          confirmText: needsInput ? '前往回复' : themeTask ? '查看结论' : '查看会话',
          tag: key,
          onOpen: themeTask && !needsInput
            ? () => navigate(`/theme-tasks?open=${encodeURIComponent(state.session_id)}`)
            : onOpen(state.session_id, run),
        })
      })().catch(() => undefined)
    })
    const unsubscribeAnti = hubEventClient.subscribe('anti:runtime', (event) => {
      if (event.topic !== 'anti:runtime') return
      const state = event.payload
      const run = state?.completed_run_id
      if (!state?.session_id || !run || state.status !== 'idle' || state.outcome === 'cancelled') return
      const key = `anti:${state.session_id}:${run}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 500) seen.delete(seen.values().next().value!)
      void (async () => {
        const cachedAnti = qc.getQueryData<AntiSession[]>(queryKeys.antiSessions)
        let session = Array.isArray(cachedAnti) ? cachedAnti.find((s) => s.id === state.session_id) : undefined
        let name = state.title || session?.title
        if (!name && typeof antiApi?.sessions === 'function') {
          try {
            session = (await antiApi.sessions()).find((s) => s.id === state.session_id) ?? session
            name = session?.title
          } catch { /* fall back to session id */ }
        }
        if (!alive) return
        const failed = state.outcome === 'failed' || Boolean(state.error)
        const label = String(name || state.session_id).replace(/\s+/g, ' ').slice(0, 64)
        await notify(failed ? '会话处理失败' : '可以查看结果了', {
          body: `「${label}」${failed ? '本次处理未能完成，请进入会话查看原因。' : '已结束本次处理，结果已可查看。'}`,
          confirmText: '查看会话',
          tag: key,
          onOpen: () => {
            markSessionRead('anti', state.session_id, run)
            openAntiSession(navigate, state.session_id)
          },
        })
      })().catch(() => undefined)
    })
    const unsubscribeConductor = hubEventClient.subscribe('conductor:workflow_completed', () => {
      void notify('流程结果可以查看了', { body: 'Conductor 本次流程已结束，可以查看结果了。', confirmText: '查看流程', tag: 'conductor-task-done', onOpen: () => navigate('/conductor') })
    })
    const unsubscribeConductorFailed = hubEventClient.subscribe('conductor:workflow_failed', (event) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      // The backend also emits workflow_failed for deliberate cancellation.
      if (payload.status === 'cancelled' || payload.status === 'killed') return
      void notify('Conductor 流程失败', { body: '本次流程未能完成，请进入 Conductor 查看原因。', confirmText: '查看流程', tag: `conductor-task-failed:${String(payload.request_id ?? '')}`, onOpen: () => navigate('/conductor') })
    })
    return () => {
      alive = false
      unsubscribeRuntime()
      unsubscribeAnti()
      unsubscribeConductor()
      unsubscribeConductorFailed()
    }
  }, [navigate, qc])
}
