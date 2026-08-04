import { create } from 'zustand'
import type { CapacityConflict } from '@/utils/sessionUi'

interface SessionManagerState {
  open: boolean
  conflict: CapacityConflict | null
  show: (conflict?: CapacityConflict | null) => void
  close: () => void
}

export const useSessionManagerStore = create<SessionManagerState>((set) => ({
  open: false,
  conflict: null,
  show: (conflict = null) => set({ open: true, conflict }),
  close: () => set({ open: false, conflict: null }),
}))

export const sessionManager = {
  open: (conflict?: CapacityConflict | null) => useSessionManagerStore.getState().show(conflict),
}
