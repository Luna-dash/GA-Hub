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
 *
 * `id` is a wire contract with the hub: rows authored server-side (journal
 * events folded by `conductor_activity.py`, and the tracker-derived terminal
 * transition) carry the same id whether they arrive live over SSE or later
 * from `GET /api/conductor/activity`. That is what lets the two feeds collapse
 * into one row instead of duplicating it.
 */
/**
 * The kinds this page knows how to colour. The hub owns the vocabulary (see
 * server/services/conductor_activity.py) and may extend it, so a row's `kind`
 * stays an open string: an unknown kind renders with the neutral dot rather
 * than a broken one.
 */
export type KnownActivityKind =
  | 'worker_spawned' | 'worker_started' | 'worker_completed' | 'worker_failed'
  | 'worker_timeout' | 'worker_accepted' | 'worker_rejected'
  | 'worker_reworked' | 'worker_pending_review' | 'worker_cancelled'
  | 'worker_killed' | 'worker_milestone' | 'worker_force_accepted'
  | 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled' | 'workflow_killed'
  | 'turn_completed' | 'turn_failed' | 'turn_yielded'

export type ConductorActivityKind = KnownActivityKind | (string & {})

export type ConductorActivityEvent = {
  id: string
  request_id: string
  kind: ConductorActivityKind
  at: number
  atMs: number
  text: string
  worker_id?: string | null
}

// Mirrors the hub's own ACTIVITY_CAP so a hydrated history is never truncated
// by a smaller client bound than the one that persisted it.
const ACTIVITY_LIMIT = 4000

type SnapshotVersion = { boot_id?: string | null; snapshot_revision?: number }

// Legacy sidecar only (a current hub authors the row itself — see
// conductor_activity.py): engine worker-event name → activity kind. This table
// and RuntimeEffects.WORKER_EVENT_LABEL must cover the SAME names, and a gap
// is silent — `addWorkerActivity` drops a row it cannot colour, so
// started/reworked/cancelled/killed (labels without a kind here) simply never
// appeared in the timeline on an older sidecar. Keep the two tables' key sets
// identical; the RuntimeEffects test walks every relayed name for that reason.
const WORKER_EVENT_KIND: Record<string, ConductorActivityEvent['kind'] | undefined> = {
  spawned: 'worker_spawned',
  started: 'worker_started',
  reworked: 'worker_reworked',
  completed: 'worker_completed',
  pending_review: 'worker_completed',
  failed: 'worker_failed',
  timeout_total: 'worker_timeout',
  accepted: 'worker_accepted',
  rejected: 'worker_rejected',
  cancelled: 'worker_cancelled',
  killed: 'worker_killed',
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
  engineBootId: string | null
  engineSnapshotRevision: number
  retiredBootIds: string[]
  generation: number
  /** Recent lifecycle events across workflows; sorted by atMs ascending. */
  activity: ConductorActivityEvent[]
  addChatMessage: (msg: ConductorChatMessage) => void
  hydrateChatMessages: (msgs: ConductorChatMessage[], generation: number) => void
  replaceSubagents: (items: ConductorSubagent[], version?: SnapshotVersion) => void
  hydrateSubagents: (items: ConductorSubagent[], expectedRevision: number, version?: SnapshotVersion) => void
  addWorkerActivity: (event: { id: string; name: string; request_id?: string; at?: number; atMs?: number; text: string; worker_id?: string }) => void
  addWorkflowActivity: (event: { request_id: string; kind: 'workflow_completed' | 'workflow_failed' | 'workflow_cancelled' | 'workflow_killed'; at?: number; atMs?: number; text?: string }) => void
  addTurnActivity: (event: { request_id: string; status: string; at?: number; atMs?: number }) => void
  /** Record a hub-authored row verbatim (SSE `payload.activity`). */
  upsertActivity: (event: ConductorActivityEvent) => void
  /** Merge durable rows for one request fetched from `GET /activity`. */
  hydrateActivity: (rows: ConductorActivityEvent[], requestId: string) => void
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
  engineBootId: null,
  engineSnapshotRevision: -1,
  retiredBootIds: [],
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

  replaceSubagents: (items, version) => set((state) => applySnapshot(state, items, version)),

  hydrateSubagents: (items, expectedRevision, version) => set((state) => {
    if (state.subagentsRevision !== expectedRevision && version?.boot_id !== state.engineBootId) return state
    if (!version?.boot_id && state.subagentsRevision !== expectedRevision) return state
    return applySnapshot(state, items, version)
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

  upsertActivity: (event) => set((state) => appendActivity(state, event)),

  hydrateActivity: (rows, requestId) => set((state) => {
    if (rows.length === 0) return state
    const byId = new Map(state.activity.map((row) => [row.id, row]))
    let changed = false
    for (const row of rows) {
      // Union rather than replace: a row that landed live while this fetch was
      // in flight must not be dropped by a slightly older answer, and rows held
      // for other requests must survive so switching tasks cannot wipe a feed.
      if (row.request_id !== requestId || byId.has(row.id)) continue
      byId.set(row.id, row)
      changed = true
    }
    if (!changed) return state
    return { activity: [...byId.values()].sort((a, b) => a.atMs - b.atMs).slice(-ACTIVITY_LIMIT) }
  }),

  clear: () => set((state) => ({
    chatMessages: [],
    subagents: [],
    subagentsRevision: state.subagentsRevision + 1,
    engineBootId: null,
    engineSnapshotRevision: -1,
    retiredBootIds: [],
    generation: state.generation + 1,
    activity: [],
  })),
}))

function applySnapshot(state: ConductorState, items: ConductorSubagent[], version?: SnapshotVersion): Partial<ConductorState> {
  const boot = version?.boot_id
  const revision = version?.snapshot_revision
  if (!boot) {
    return state.engineBootId ? state : { subagents: items, subagentsRevision: state.subagentsRevision + 1 }
  }
  if (!Number.isInteger(revision) || revision! < 0 || state.retiredBootIds.includes(boot)) return state
  if (boot === state.engineBootId && revision! <= state.engineSnapshotRevision) return state
  return {
    subagents: items,
    subagentsRevision: state.subagentsRevision + 1,
    engineBootId: boot,
    engineSnapshotRevision: revision!,
    retiredBootIds: state.engineBootId && boot !== state.engineBootId
      ? [...state.retiredBootIds, state.engineBootId] : state.retiredBootIds,
  }
}
