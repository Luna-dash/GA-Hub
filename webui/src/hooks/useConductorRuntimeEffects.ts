import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hubEventClient } from '@/runtime/hubEventClient'
import { useConductorStore, type ConductorActivityEvent } from '@/stores/conductorStore'

// Activity-timeline copy for worker lifecycle events. Keys mirror the engine
// worker events the hub relays as `conductor:subagent_<name>` (see
// conductor_vocabulary.WORKER_EVENTS); unknown names are ignored.
//
// This table is the *legacy* path: it only runs when the hub did not author a
// row itself (an older sidecar). Current hubs fold the journal through
// conductor_activity.py and ship the finished row as `payload.activity`, which
// also covers events this table never knew about (milestones, force-accept).
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

/**
 * The hub-authored timeline row riding an SSE frame, if there is one.
 *
 * Trusting the hub here is the point: the same dict is persisted, so a row the
 * page records live and the row it later hydrates from `/activity` carry one
 * id and one wording. Returns null for older sidecars, which fall back to the
 * local label tables above.
 */
function hubActivity(payload: Record<string, unknown> | undefined): ConductorActivityEvent | null {
  const raw = payload?.activity
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Partial<ConductorActivityEvent>
  if (
    typeof row.id !== 'string' || !row.id
    || typeof row.request_id !== 'string' || !row.request_id
    || typeof row.kind !== 'string' || typeof row.text !== 'string'
  ) {
    return null
  }
  const at = typeof row.at === 'number' && row.at > 0 ? row.at : Date.now() / 1000
  return {
    id: row.id,
    request_id: row.request_id,
    kind: row.kind,
    at,
    atMs: typeof row.atMs === 'number' ? row.atMs : Math.round(at * 1000),
    text: row.text,
    worker_id: typeof row.worker_id === 'string' ? row.worker_id : undefined,
  }
}

/** Keep the Conductor store live while the Conductor page is not mounted. */
export function useConductorRuntimeEffects(): void {
  const queryClient = useQueryClient()
  const addChatMessage = useConductorStore((state) => state.addChatMessage)
  const replaceSubagents = useConductorStore((state) => state.replaceSubagents)
  const addWorkerActivity = useConductorStore((state) => state.addWorkerActivity)
  const addWorkflowActivity = useConductorStore((state) => state.addWorkflowActivity)
  const addTurnActivity = useConductorStore((state) => state.addTurnActivity)
  const upsertActivity = useConductorStore((state) => state.upsertActivity)
  const clearConductor = useConductorStore((state) => state.clear)

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
    // turn outcomes. The hub ships the finished row as `payload.activity`; its
    // id is derived from the engine journal, so the live row and the one a
    // later hydration returns are the same row.
    const authored = hubActivity(event.payload)
    if (authored) {
      upsertActivity(authored)
      return
    }

    // Legacy sidecar: no authored row, so rebuild one locally. event_id
    // (server-monotonic) is the dedupe key; ts is the hub-side publish time.
    if (event.topic.startsWith('conductor:subagent_')) {
      const name = event.topic.slice('conductor:subagent_'.length)
      if (!WORKER_EVENT_LABEL[name]) return
      const payload = (event.payload ?? {}) as Record<string, unknown>
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
      const payload = (event.payload ?? {}) as Record<string, unknown>
      if (!WORKFLOW_EVENT_LABEL[kind] || typeof payload.request_id !== 'string') return
      addWorkflowActivity({
        request_id: payload.request_id,
        kind,
        at: event.ts,
        text: WORKFLOW_EVENT_LABEL[kind],
      })
    } else if (event.topic === 'conductor:request_outcome') {
      const payload = (event.payload ?? {}) as Record<string, unknown>
      if (typeof payload.request_id !== 'string') return
      addTurnActivity({
        request_id: payload.request_id,
        status: String(payload.status ?? ''),
        at: event.ts,
      })
    }
  }), [addChatMessage, replaceSubagents, addWorkerActivity, addWorkflowActivity, addTurnActivity, upsertActivity, clearConductor, queryClient])

  useEffect(() => hubEventClient.subscribeControl((control) => {
    if (control.type === 'resync_required') {
      clearConductor()
    }
  }), [clearConductor])
}
