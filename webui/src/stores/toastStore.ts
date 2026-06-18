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
}

let seq = 1

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],

  push: (kind, message, duration) => {
    const id = seq++
    const ms = duration ?? (kind === 'error' ? 5000 : 2600)
    set((s) => {
      // Cap the visible stack so a burst of events can't bury the screen.
      const next = [...s.items, { id, kind, message, duration: ms }]
      return { items: next.slice(-4) }
    })
    if (ms > 0) {
      window.setTimeout(() => get().dismiss(id), ms)
    }
    return id
  },

  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}))

// ── Imperative helpers (use these from anywhere) ──────────────────
export const toast = {
  success: (message: string, duration?: number) =>
    useToastStore.getState().push('success', message, duration),
  error: (message: string, duration?: number) =>
    useToastStore.getState().push('error', message, duration),
  info: (message: string, duration?: number) =>
    useToastStore.getState().push('info', message, duration),
}
