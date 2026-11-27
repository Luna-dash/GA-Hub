// In-app transient toast feedback — fills the gap left by `notify()` (which
// only fires OS notifications when the window is UNfocused). When the user is
// looking at the window and performs an action (save / copy / delete / retry),
// they deserve a lightweight confirmation that doesn't hijack focus like the
// modal <DialogHost> does.
//
// Imperative API (`toast.success(...)`) so any callsite — even outside React —
// can fire one. A single <ToastHost> mounted at App root renders the stack.

import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  message: string
  // Auto-dismiss after this many ms; errors linger longer by default.
  duration: number
}

interface ToastState {
  items: ToastItem[]
  push: (kind: ToastKind, message: string, duration?: number) => number
  dismiss: (id: number) => void
  pause: (id: number) => void
  resume: (id: number) => void
}

interface TimerEntry {
  timerId: number | null
  remainingMs: number
  startedAt: number
  paused: boolean
}

let seq = 1
const timers = new Map<number, TimerEntry>()

function clearTimer(id: number) {
  const entry = timers.get(id)
  if (entry?.timerId !== null && entry?.timerId !== undefined) {
    globalThis.clearTimeout(entry.timerId)
  }
  timers.delete(id)
}

export const useToastStore = create<ToastState>((set, get) => {
  const scheduleTimer = (id: number, ms: number) => {
    clearTimer(id)
    if (ms <= 0) return
    const timerId = globalThis.setTimeout(() => {
      get().dismiss(id)
    }, ms)
    timers.set(id, {
      timerId,
      remainingMs: ms,
      startedAt: Date.now(),
      paused: false,
    })
  }

  return {
    items: [],

    push: (kind, message, duration) => {
      const ms = duration ?? (kind === 'error' ? 5000 : 2600)
      const existing = get().items.find((t) => t.kind === kind && t.message === message)
      if (existing) {
        set((s) => ({
          items: s.items.map((t) => (t.id === existing.id ? { ...t, duration: ms } : t)),
        }))
        const currentTimer = timers.get(existing.id)
        if (currentTimer?.paused) {
          currentTimer.remainingMs = ms
          currentTimer.startedAt = Date.now()
        } else {
          scheduleTimer(existing.id, ms)
        }
        return existing.id
      }

      const id = seq++
      let evictedIds: number[] = []
      set((s) => {
        // Cap the visible stack so a burst of events can't bury the screen.
        const next = [...s.items, { id, kind, message, duration: ms }]
        if (next.length > 4) {
          evictedIds = next.slice(0, next.length - 4).map((t) => t.id)
          return { items: next.slice(-4) }
        }
        return { items: next }
      })
      for (const evictedId of evictedIds) {
        clearTimer(evictedId)
      }
      scheduleTimer(id, ms)
      return id
    },

    dismiss: (id) => {
      clearTimer(id)
      set((s) => ({ items: s.items.filter((t) => t.id !== id) }))
    },

    pause: (id) => {
      if (!get().items.some((t) => t.id === id)) {
        clearTimer(id)
        return
      }
      const entry = timers.get(id)
      if (!entry || entry.paused || entry.timerId === null) return
      globalThis.clearTimeout(entry.timerId)
      const elapsed = Math.max(0, Date.now() - entry.startedAt)
      entry.timerId = null
      entry.remainingMs = Math.max(0, entry.remainingMs - elapsed)
      entry.paused = true
    },

    resume: (id) => {
      if (!get().items.some((t) => t.id === id)) {
        clearTimer(id)
        return
      }
      const entry = timers.get(id)
      if (!entry || !entry.paused) return
      if (entry.remainingMs <= 0) {
        get().dismiss(id)
        return
      }
      scheduleTimer(id, entry.remainingMs)
    },
  }
})

// ── Imperative helpers (use these from anywhere) ──────────────────
export const toast = {
  success: (message: string, duration?: number) =>
    useToastStore.getState().push('success', message, duration),
  error: (message: string, duration?: number) =>
    useToastStore.getState().push('error', message, duration),
  info: (message: string, duration?: number) =>
    useToastStore.getState().push('info', message, duration),
}
