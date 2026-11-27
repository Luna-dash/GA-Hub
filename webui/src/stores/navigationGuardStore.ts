import { useEffect } from 'react'
import { create } from 'zustand'
import { dialog } from './dialogStore'

interface NavigationGuardState {
  guards: Record<string, string>
  registerGuard: (id: string, message: string) => void
  unregisterGuard: (id: string) => void
}

const handleBeforeUnload = (event: BeforeUnloadEvent) => {
  if (Object.keys(useNavigationGuardStore.getState().guards).length === 0) return
  event.preventDefault()
  event.returnValue = ''
}

let beforeUnloadAttached = false

function syncBeforeUnloadListener(guards: Record<string, string>) {
  if (typeof window === 'undefined') return
  const shouldAttach = Object.keys(guards).length > 0
  if (shouldAttach && !beforeUnloadAttached) {
    window.addEventListener('beforeunload', handleBeforeUnload)
    beforeUnloadAttached = true
  } else if (!shouldAttach && beforeUnloadAttached) {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    beforeUnloadAttached = false
  }
}

export const useNavigationGuardStore = create<NavigationGuardState>((set, get) => ({
  guards: {},

  registerGuard: (id, message) => {
    const current = get().guards
    if (current[id] === message) return
    const next = { ...current, [id]: message }
    syncBeforeUnloadListener(next)
    set({ guards: next })
  },

  unregisterGuard: (id) => {
    const current = get().guards
    if (!(id in current)) return
    const next = { ...current }
    delete next[id]
    syncBeforeUnloadListener(next)
    set({ guards: next })
  },
}))

export function registerNavigationGuard(id: string, message: string): void {
  useNavigationGuardStore.getState().registerGuard(id, message)
}

export function unregisterNavigationGuard(id: string): void {
  useNavigationGuardStore.getState().unregisterGuard(id)
}

export function hasDirtyGuard(): boolean {
  return Object.keys(useNavigationGuardStore.getState().guards).length > 0
}

let pendingConfirm: Promise<boolean> | null = null

export function confirmLeaveIfDirty(): Promise<boolean> {
  const messages = Object.values(useNavigationGuardStore.getState().guards)
  if (messages.length === 0) return Promise.resolve(true)
  if (pendingConfirm) return pendingConfirm
  const body = messages.length === 1 ? messages[0] : messages.map((msg) => `• ${msg}`).join('\n')
  pendingConfirm = dialog
    .confirm('放弃未保存的修改？', body, {
      confirmText: '放弃修改',
      cancelText: '继续编辑',
      tone: 'danger',
    })
    .finally(() => {
      pendingConfirm = null
    })
  return pendingConfirm
}

export function resetNavigationGuardsForTests(): void {
  pendingConfirm = null
  const empty: Record<string, string> = {}
  syncBeforeUnloadListener(empty)
  useNavigationGuardStore.setState({ guards: empty })
}

export function useDirtyRouteGuard(id: string, dirty: boolean, message: string): void {
  useEffect(() => {
    if (!dirty) {
      unregisterNavigationGuard(id)
      return
    }
    registerNavigationGuard(id, message)
    return () => {
      unregisterNavigationGuard(id)
    }
  }, [id, dirty, message])
}
