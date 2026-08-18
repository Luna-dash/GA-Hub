import { create } from 'zustand'
import type { AgentStatus } from '@/api/types'
import { api } from '@/api/client'
import { hubEventClient } from '@/runtime/hubEventClient'

interface State {
  status: AgentStatus | null
  refreshStatus: () => Promise<void>
  start: () => void
  stop: () => void
}

let unsubscribeAgentEvents: (() => void) | undefined
let unsubscribeHubState: (() => void) | undefined
let refreshTimer: number | undefined
let refreshInFlight: Promise<void> | null = null
let refreshAgain = false

export const useAgentStore = create<State>((set, get) => ({
  status: null,

  refreshStatus: async () => {
    if (refreshInFlight) {
      refreshAgain = true
      return refreshInFlight
    }

    const refresh = async () => {
      do {
        refreshAgain = false
        try {
          set({ status: await api.agentStatus() })
        } catch {}
      } while (refreshAgain)
    }

    refreshInFlight = refresh()
    try {
      await refreshInFlight
    } finally {
      refreshInFlight = null
    }
  },

  start: () => {
    if (unsubscribeAgentEvents) return
    unsubscribeAgentEvents = hubEventClient.subscribe('agent:', () => {
      if (refreshTimer !== undefined) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void get().refreshStatus()
      }, 100)
    })
    unsubscribeHubState = hubEventClient.subscribeState((state) => {
      if (state !== 'open') return
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void get().refreshStatus()
      }, 0)
    })
    // Keep status available even if a proxy blocks the control WebSocket.
    void get().refreshStatus()
  },

  stop: () => {
    unsubscribeAgentEvents?.()
    unsubscribeAgentEvents = undefined
    unsubscribeHubState?.()
    unsubscribeHubState = undefined
    refreshAgain = false
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
  },
}))
