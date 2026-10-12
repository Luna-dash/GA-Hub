// Runtime subscriber; completions are independent of the mounted chat page.
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { queryKeys } from '@/queries/queryKeys'
import type { SessionRuntime } from '@/api/types'
import { useChatStore } from '@/stores/chatStore'
import { hubEventClient } from '@/runtime/hubEventClient'
import { extractAskUserPayload } from '@/utils/assistantTranscript'
import { notify } from '@/utils/notify'

export function useDesktopNotifyEffects() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  useEffect(() => {
    let alive = true
    const seen = new Set<string>()
    const aborted = new Set<string>()
    const onOpen = (id: string) => () => {
      useChatStore.getState().start(id)
      navigate('/chat')
    }
    const unsubscribeRuntime = hubEventClient.subscribe('session:runtime', (event) => {
      if (event.topic !== 'session:runtime') return
      const state = event.payload as unknown as SessionRuntime
      // completed_run_id is emitted only for settled runs, not a tab/WS switch.
      const run = state.completed_run_id
      if (state.status === 'aborting' && state.run_id) aborted.add(state.run_id)
      if (!state.session_id || !run || state.status !== 'idle' || state.error) return
      if (aborted.delete(run)) return
      const key = `${state.session_id}:${run}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 500) seen.delete(seen.values().next().value!)
      void (async () => {
        let name = qc.getQueryData<Awaited<ReturnType<typeof api.sessions>>>(queryKeys.sessions)?.items.find(s => s.id === state.session_id)?.title
        if (!name) {
          try { name = (await api.sessions()).items.find(s => s.id === state.session_id)?.title } catch { /* use id */ }
        }
        let needsInput = false
        try {
          const snapshot = await api.getSessionMessages(state.session_id, { limit: 2 })
          const last = snapshot.items.at(-1)
          needsInput = last?.role === 'assistant' && !!extractAskUserPayload(last.content)
        } catch { /* still report completion without leaking output */ }
        if (!alive) return
        await notify(needsInput ? '会话需要互动' : '会话有新结果', {
          body: `「${String(name || state.session_id).replace(/\s+/g, ' ').slice(0, 64)}」${needsInput ? '需要你的回复，请进入会话继续。' : '已完成本轮任务，请进入会话查看结果。'}`,
          tag: key, onOpen: onOpen(state.session_id),
        })
      })().catch(() => undefined)
    })
    const unsubscribeWechat = hubEventClient.subscribe('wechat:incoming', () => {
      void notify('微信有新消息', { body: '收到新消息，请进入微信会话查看。', tag: 'wechat-incoming', onOpen: () => navigate('/wechat') })
    })
    const unsubscribeConductor = hubEventClient.subscribe('conductor:workflow_completed', () => {
      void notify('Conductor 任务完成', { body: '任务已完成，请进入 Conductor 查看结果。', tag: 'conductor-task-done', onOpen: () => navigate('/conductor') })
    })
    return () => {
      alive = false
      unsubscribeRuntime()
      unsubscribeWechat()
      unsubscribeConductor()
    }
  }, [navigate, qc])
}
