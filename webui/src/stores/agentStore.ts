import { create } from 'zustand'
import type { AgentStatus, BusEvent } from '@/api/types'
import { EventSocket, api } from '@/api/client'

interface State {
  status: AgentStatus | null
  recent: BusEvent[]
  sock: EventSocket | null
  refreshStatus: () => Promise<void>
  start: () => void
  stop: () => void
}

export const useAgentStore = create<State>((set, get) => ({
  status: null,
  recent: [],
  sock: null,

  refreshStatus: async () => {
    try {
      const s = await api.agentStatus()
      set({ status: s })
    } catch {}
  },

  start: () => {
    if (get().sock) return
    const sock = new EventSocket('', 50)
    sock.onEvent = (e) => {
      set((st) => {
        const recent = [e, ...st.recent].slice(0, 200)
        return { recent }
      })
      if ('topic' in e && e.topic.startsWith('agent:')) {
        get().refreshStatus()
      }
    }
    sock.open()
    set({ sock })
    get().refreshStatus()
  },

  stop: () => {
    get().sock?.close()
    set({ sock: null })
  },
}))
