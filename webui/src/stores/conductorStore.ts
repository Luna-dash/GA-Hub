// conductorStore — real-time conductor state via EventBus
//
// EventBus topics:
//   conductor:chat            { item: ConductorChatMessage }
//   conductor:subagents       { items: ConductorSubagent[] }
//   conductor:subagent_*      worker lifecycle events (activity timeline)
//   conductor:workflow_*      terminal workflow transitions
//   conductor:request_outcome supervisor turn results
//
// The activity timeline is captured here — not from the conductor:log model
// log — so the UI shows only events a human acts on (dispatch/review/
// failure/completion), matching the page's decision not to render the
// engine's model-turn log stream.

import { create } from 'zustand'
import type {
  ConductorChatMessage,
  ConductorSubagent,
} from '@/api/types'

/**
 * One human-meaningful lifecycle event for a workflow. `at` is epoch
 * seconds; `atMs` disambiguates same-second events for stable sort keys.
 */
export type ConductorActivityEvent = {
  id: string
  request_id: string
  kind:
    | 'worker_spawned' | 'worker_completed' | 'worker_failed'
    | 'worker_timeout' | 'worker_accepted' | 'worker_rejected'
    | 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled' | 'workflow_killed'
    | 'turn_completed' | 'turn_failed' | 'turn_yielded'
  at: number
  atMs: number
  text: string
  worker_id?: string
}

const ACTIVITY_LIMIT = 300

const WORKER_EVENT_KIND: Record<string, ConductorActivityEvent['kind'] | undefined> = {
  spawned: 'worker_spawned',
  completed: 'worker_completed',
  pending_review: 'worker_completed',
  failed: 'worker_failed',
  timeout_total: 'worker_timeout',
  accepted: 'worker_accepted',
  rejected: 'worker_rejected',
}

function requestOutcomeKind(status: string): ConductorActivityEvent['kind'] {
  if (status === 'ok') return 'turn_completed'
  if (status === 'yielded') return 'turn_yielded'
  return 'turn_failed'
}

interface ConductorState {
  chatMessages: ConductorChatMessage[]
  subagents: ConductorSubagent[]
  subagentsRevision: number
  generation: number
  /** Recent lifecycle events across workflows; sorted by atMs ascending. */
  activity: ConductorActivityEvent[]
  addChatMessage: (msg: ConductorChatMessage) => void
  hydrateChatMessages: (msgs: ConductorChatMessage[], generation: number) => void
  replaceSubagents: (items: ConductorSubagent[]) => void
  hydrateSubagents: (items: ConductorSubagent[], expectedRevision: number) => void
  addWorkerActivity: (event: { id: string; name: string; request_id?: string; at?: number; atMs?: number; text: string; worker_id?: string }) => void
  addWorkflowActivity: (event: { request_id: string; kind: 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled' | 'workflow_killed'; at?: number; atMs?: number; text?: string }) => void
  addTurnActivity: (event: { request_id: string; status: string; at?: number; atMs?: number }) => void
  clear: () => void
}

function mergeTimeline<T extends { id: string; ts: number }>(
  current: T[], incoming: T[], limit: number,
): T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    // A live item already in the store is newer than a late HTTP snapshot.
    if (!byId.has(item.id)) byId.set(item.id, item)
  }
  const merged = [...byId.values()]
    .sort((left, right) => left.ts - right.ts)
    .slice(-limit)
  if (
    merged.length === current.length
    && merged.every((item, index) => item === current[index])
  ) {
    return current
  }
  return merged
}

function appendActivity(
  state: ConductorState,
  event: ConductorActivityEvent,
): Partial<ConductorState> | typeof state {
  // Duplicate SSE delivery / late snapshot replays must not stack rows.
  if (state.activity.some((existing) => existing.id === event.id)) return state
  const activity = [...state.activity, event].sort((a, b) => a.atMs - b.atMs).slice(-ACTIVITY_LIMIT)
  return { activity }
}

export const useConductorStore = create<ConductorState>((set) => ({
  chatMessages: [],
  subagents: [],
  subagentsRevision: 0,
  generation: 0,
  activity: [],

  addChatMessage: (msg) =>
    set((state) => {
      const chatMessages = mergeTimeline(state.chatMessages, [msg], 200)
      return chatMessages === state.chatMessages ? state : { chatMessages }
    }),

  hydrateChatMessages: (msgs, generation) =>
    set((state) => {
      if (state.generation !== generation) return state
      const chatMessages = mergeTimeline(state.chatMessages, msgs, 200)
      return chatMessages === state.chatMessages ? state : { chatMessages }
    }),

  replaceSubagents: (items) => set((state) => ({
    subagents: items,
    subagentsRevision: state.subagentsRevision + 1,
  })),

  hydrateSubagents: (items, expectedRevision) => set((state) => {
    if (state.subagentsRevision !== expectedRevision) return state
    return {
      subagents: items,
      subagentsRevision: state.subagentsRevision + 1,
    }
  }),

  addWorkerActivity: ({ id, name, request_id, at, atMs, text, worker_id }) =>
    set((state) => {
      const kind = WORKER_EVENT_KIND[name]
      if (!kind || !request_id) return state
      const ts = typeof at === 'number' && at > 0 ? at : Date.now() / 1000
      return appendActivity(state, {
        id,
        request_id,
        kind,
        at: ts,
        atMs: atMs ?? Math.round(ts * 1000),
        text,
        worker_id,
      })
    }),

  addWorkflowActivity: ({ request_id, kind, at, atMs, text }) =>
    set((state) => {
      const ts = typeof at === 'number' && at > 0 ? at : Date.now() / 1000
      return appendActivity(state, {
        id: `${kind}:${request_id}`,
        request_id,
        kind,
        at: ts,
        atMs: atMs ?? Math.round(ts * 1000),
        text: text || (kind === 'workflow_completed' ? '任务完成' : '任务失败'),
      })
    }),

  addTurnActivity: ({ request_id, status, at, atMs }) =>
    set((state) => {
      // 'yielded' fires once per supervisor turn and only means "waiting for
      // workers" — recording it would spam the timeline with no actionable
      // content, so only terminal outcomes become activity.
      if (status === 'yielded') return state
      const ts = typeof at === 'number' && at > 0 ? at : Date.now() / 1000
      const stamp = atMs ?? Math.round(ts * 1000)
      return appendActivity(state, {
        // A workflow can run several supervisor turns; the stamp keeps ids
        // unique across rounds (the topic alone would dedupe them away).
        id: `turn:${request_id}:${status}:${stamp}`,
        request_id,
        kind: requestOutcomeKind(status),
        at: ts,
        atMs: stamp,
        text: status === 'ok' ? 'Conductor 完成一轮处理' : 'Conductor 本轮处理失败',
      })
    }),

  clear: () => set((state) => ({
    chatMessages: [],
    subagents: [],
    subagentsRevision: state.subagentsRevision + 1,
    generation: state.generation + 1,
    activity: [],
  })),
}))
