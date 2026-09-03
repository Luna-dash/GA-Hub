// conductorStore — real-time conductor state via EventBus
//
// EventBus topics:
//   conductor:chat       { item: ConductorChatMessage }
//   conductor:subagents  { items: ConductorSubagent[] }

import { create } from 'zustand'
import type {
  ConductorChatMessage,
  ConductorSubagent,
} from '@/api/types'

interface ConductorState {
  chatMessages: ConductorChatMessage[]
  subagents: ConductorSubagent[]
  subagentsRevision: number
  generation: number
  addChatMessage: (msg: ConductorChatMessage) => void
  hydrateChatMessages: (msgs: ConductorChatMessage[], generation: number) => void
  replaceSubagents: (items: ConductorSubagent[]) => void
  hydrateSubagents: (items: ConductorSubagent[], expectedRevision: number) => void
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

export const useConductorStore = create<ConductorState>((set) => ({
  chatMessages: [],
  subagents: [],
  subagentsRevision: 0,
  generation: 0,

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

  clear: () => set((state) => ({
    chatMessages: [],
    subagents: [],
    subagentsRevision: state.subagentsRevision + 1,
    generation: state.generation + 1,
  })),
}))
