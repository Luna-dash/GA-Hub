import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hubEventClient } from '@/runtime/hubEventClient'
import { useDesktopNotifyEffects } from '@/hooks/useDesktopNotifyEffects'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useConductorStore } from '@/stores/conductorStore'

// Activity-timeline copy for worker lifecycle events. Keys mirror the engine
// worker events the hub relays as `conductor:subagent_<name>` (see
// conductor_vocabulary.WORKER_EVENTS); unknown names are ignored.
const WORKER_EVENT_LABEL: Record<string, string> = {
  spawned: '子代理已派出',
  started: '子代理开工',
  reworked: '按返工意见重新处理',
  pending_review: '子代理交付，等待验收',
  accepted: '子代理验收通过',
  rejected: '子代理被打回',
  timeout_total: '子代理执行超时',
  failed: '子代理执行失败',
  cancelled: '子代理已取消',
  killed: '子代理已终止',
}

const WORKFLOW_EVENT_LABEL: Record<string, string> = {
  workflow_completed: '任务完成',
  workflow_failed: '任务失败',
  workflow_cancelled: '任务已取消',
  workflow_killed: '任务已终止',
}

/** Long-lived effects isolated from the visual application shell. */
export function RuntimeEffects() {
  const queryClient = useQueryClient()
  const addChatMessage = useConductorStore((state) => state.addChatMessage)
  const replaceSubagents = useConductorStore((state) => state.replaceSubagents)
  const addWorkerActivity = useConductorStore((state) => state.addWorkerActivity)
  const addWorkflowActivity = useConductorStore((state) => state.addWorkflowActivity)
  const addTurnActivity = useConductorStore((state) => state.addTurnActivity)
  const clearConductor = useConductorStore((state) => state.clear)
  useDocumentTitle()
  useDesktopNotifyEffects()

  // Keep the Conductor projection alive while its page is not mounted. This
  // closes the HTTP bootstrap/subscription gap and lets remounts render from
  // the same bounded store immediately.
  useEffect(() => hubEventClient.subscribe('conductor:', (event) => {
    if (event.topic === 'conductor:chat' && event.payload.item) {
      addChatMessage(event.payload.item)
    }
    if (event.topic === 'conductor:subagents' && event.payload.items) {
      replaceSubagents(event.payload.items, event.payload)
    }
    if (event.topic === 'conductor:resync_required') {
      clearConductor()
      void queryClient.invalidateQueries({ queryKey: ['conductor'] })
    }

    // Activity timeline: worker lifecycle + workflow transitions + terminal
    // turn outcomes. event_id (server-monotonic) is the dedupe key; ts is the
    // hub-side publish time.
    if (event.topic.startsWith('conductor:subagent_')) {
      const name = event.topic.slice('conductor:subagent_'.length)
      if (!WORKER_EVENT_LABEL[name]) return
      const payload = event.payload ?? {}
      addWorkerActivity({
        id: `ev:${event.event_id ?? `${name}:${payload.id}:${event.ts}`}`,
        name,
        request_id: typeof payload.request_id === 'string' ? payload.request_id : undefined,
        at: event.ts,
        text: WORKER_EVENT_LABEL[name] ?? name,
        worker_id: typeof payload.id === 'string' ? payload.id : undefined,
      })
    } else if (event.topic.startsWith('conductor:workflow_')) {
      const kind = event.topic.slice('conductor:'.length) as
        | 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled' | 'workflow_killed'
      const payload = event.payload ?? {}
      if (!WORKFLOW_EVENT_LABEL[kind] || typeof payload.request_id !== 'string') return
      addWorkflowActivity({
        request_id: payload.request_id,
        kind,
        at: event.ts,
        text: WORKFLOW_EVENT_LABEL[kind],
      })
    } else if (event.topic === 'conductor:request_outcome' && typeof event.payload?.request_id === 'string') {
      addTurnActivity({
        request_id: event.payload.request_id,
        status: String(event.payload.status ?? ''),
        at: event.ts,
      })
    }
  }), [addChatMessage, replaceSubagents, addWorkerActivity, addWorkflowActivity, addTurnActivity, clearConductor, queryClient])

  useEffect(() => hubEventClient.subscribeControl((control) => {
    if (control.type === 'resync_required') {
      clearConductor()
    }
  }), [clearConductor])

  useEffect(() => {
    let hasOpened = false
    let disconnectedAfterOpen = false
    return hubEventClient.subscribeState((state) => {
      if (state === 'open') {
        if (hasOpened && disconnectedAfterOpen) {
          void queryClient.invalidateQueries({ refetchType: 'active' })
        }
        hasOpened = true
        disconnectedAfterOpen = false
        return
      }
      if (hasOpened && (state === 'connecting' || state === 'closed')) {
        disconnectedAfterOpen = true
      }
    })
  }, [queryClient])

  return null
}
