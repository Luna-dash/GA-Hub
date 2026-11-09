import { useSyncExternalStore } from 'react'
import { storageKeys } from '@/config/storageKeys'
import type { ThemeRun } from '@/api/types'

type Completion = { runId: string; finishedAt: number; read: boolean }
const changed = 'gahub:theme-completions'
function load(): Record<string, Completion> {
  try {
    const value = JSON.parse(localStorage.getItem(storageKeys.themeCompletions) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
function save(value: Record<string, Completion>) {
  try { localStorage.setItem(storageKeys.themeCompletions, JSON.stringify(value)) } catch { return }
  window.dispatchEvent(new Event(changed))
}
export function recordThemeCompletion(sessionId: string, run: ThemeRun | null | undefined) {
  if (!run?.run_id || run.outcome !== 'completed' || !run.finished_at || run.interrupted) return
  const value = load()
  const previous = value[sessionId]
  if (previous?.runId === run.run_id || previous?.finishedAt > run.finished_at) return
  value[sessionId] = { runId: run.run_id, finishedAt: run.finished_at, read: false }
  save(value)
}
export function readThemeCompletion(sessionId: string, run: ThemeRun | null | undefined) {
  if (!run?.run_id || run.outcome !== 'completed' || !run.finished_at || run.interrupted) return
  const value = load()
  const previous = value[sessionId]
  if (previous?.finishedAt > run.finished_at || (previous?.runId === run.run_id && previous.read)) return
  value[sessionId] = { runId: run.run_id, finishedAt: run.finished_at, read: true }
  save(value)
}
export function retainThemeCompletions(sessionIds: ReadonlySet<string>) {
  const value = load()
  let removed = false
  for (const id of Object.keys(value)) {
    if (!sessionIds.has(id)) { delete value[id]; removed = true }
  }
  if (removed) save(value)
}
export function hasUnreadThemeCompletions() {
  return Object.values(load()).some(value => value && value.read === false)
}
function subscribe(listener: () => void) {
  window.addEventListener(changed, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(changed, listener)
    window.removeEventListener('storage', listener)
  }
}
export function useUnreadThemeCompletions() {
  return useSyncExternalStore(subscribe, hasUnreadThemeCompletions, () => false)
}
