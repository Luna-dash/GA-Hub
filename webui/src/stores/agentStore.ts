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
let refreshAbort: AbortController | null = null
let refreshAgain = false
let lifecycleGeneration = 0

export const useAgentStore = create<State>((set, get) => ({
  status: null,

  refreshStatus: async () => {
    if (refreshInFlight) {
      refreshAgain = true
      return refreshInFlight
    }

    const generation = lifecycleGeneration
    const abortController = new AbortController()
    refreshAbort = abortController
    const refresh = async () => {
      do {
        refreshAgain = false
        try {
          const status = await api.agentStatus({ signal: abortController.signal })
          if (generation !== lifecycleGeneration || abortController.signal.aborted) return
          set({ status })
        } catch {}
      } while (refreshAgain && generation === lifecycleGeneration && !abortController.signal.aborted)
    }

    const request = refresh()
    refreshInFlight = request
    try {
      await request
    } finally {
      if (refreshInFlight === request) refreshInFlight = null
      if (refreshAbort === abortController) refreshAbort = null
    }
  },

  start: () => {
    if (unsubscribeAgentEvents) return
    lifecycleGeneration += 1
    unsubscribeAgentEvents = hubEventClient.subscribe('agent:', () => {
      if (refreshTimer !== undefined) return
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void get().refreshStatus()
      }, 100)
    })
    // Prime HTTP status before observing the current hub state. If the socket
    // is already open, subscribeState reports it synchronously; the in-flight
    // guard below prevents that snapshot from causing a duplicate request.
    void get().refreshStatus()
    let readingCurrentHubState = true
    unsubscribeHubState = hubEventClient.subscribeState((state) => {
      if (state !== 'open') return
      if (refreshInFlight) {
        // A synchronous snapshot of an already-open socket is covered by the
        // request started just above. A later closed -> open transition is not:
        // replay is still disabled, so force one post-open reconciliation.
        if (!readingCurrentHubState) refreshAgain = true
        return
      }
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined
        void get().refreshStatus()
      }, 0)
    })
    readingCurrentHubState = false
  },

  stop: () => {
    lifecycleGeneration += 1
    unsubscribeAgentEvents?.()
    unsubscribeAgentEvents = undefined
    unsubscribeHubState?.()
    unsubscribeHubState = undefined
    refreshAgain = false
    refreshAbort?.abort()
    refreshAbort = null
    refreshInFlight = null
    if (refreshTimer !== undefined) {
      window.clearTimeout(refreshTimer)
      refreshTimer = undefined
    }
  },
}))
