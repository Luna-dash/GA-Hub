// conductorStore — real-time conductor state via EventBus
//
// EventBus topics:
//   conductor:chat_msg        { item: ConductorChatMessage }
//   conductor:subagent_cards  { items: ConductorSubagent[] }
//   conductor:log             { item: ConductorLogItem }
//   conductor:approval        { item: ConductorApprovalItem }

import { create } from 'zustand'
import type {
  ConductorChatMessage,
  ConductorSubagent,
  ConductorLogItem,
  ConductorApprovalItem,
} from '@/api/types'

interface ConductorState {
  chatMessages: ConductorChatMessage[]
  subagents: ConductorSubagent[]
  log: ConductorLogItem[]
  approvals: ConductorApprovalItem[]
  addChatMessage: (msg: ConductorChatMessage) => void
  setChatMessages: (msgs: ConductorChatMessage[]) => void
  setSubagents: (items: ConductorSubagent[]) => void
  addLogItem: (item: ConductorLogItem) => void
  setLog: (items: ConductorLogItem[]) => void
  addApproval: (item: ConductorApprovalItem) => void
  removeApproval: (id: string) => void
  clear: () => void
}

export const useConductorStore = create<ConductorState>((set) => ({
  chatMessages: [],
  subagents: [],
  log: [],
  approvals: [],

  addChatMessage: (msg) =>
    set((state) => {
      const exists = state.chatMessages.some((m) => m.id === msg.id)
      if (exists) return state
      return { chatMessages: [...state.chatMessages, msg] }
    }),

  setChatMessages: (msgs) => set({ chatMessages: msgs }),

  setSubagents: (items) => set({ subagents: items }),

  addLogItem: (item) =>
    set((state) => {
      const exists = state.log.some((l) => l.id === item.id)
      if (exists) return state
      return { log: [...state.log, item] }
    }),

  setLog: (items) => set({ log: items }),

  addApproval: (item) =>
    set((state) => {
      const exists = state.approvals.some((a) => a.id === item.id)
      if (exists) return state
      return { approvals: [...state.approvals, item] }
    }),

  removeApproval: (id) =>
    set((state) => ({ approvals: state.approvals.filter((a) => a.id !== id) })),

  clear: () => set({ chatMessages: [], subagents: [], log: [], approvals: [] }),
}))
