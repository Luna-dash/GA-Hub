import { useSyncExternalStore } from 'react'
import type { SessionRuntime } from '@/api/types'
import { storageKeys } from '@/config/storageKeys'
import { sessionActivity, type SessionUnreadEntry } from '@/utils/sessionUi'

export type SessionScope = 'chat' | 'anti'

export interface SessionUnreadSnapshot {
  unread: Record<string, SessionUnreadEntry>
  seen: Record<string, string>
}

const CHANGED_EVENT = 'gahub:session-unread'

function unreadKeyFor(scope: SessionScope): string {
  return scope === 'anti' ? `${storageKeys.sessionRailUnreadRuns}.anti` : storageKeys.sessionRailUnreadRuns
}

function seenKeyFor(scope: SessionScope): string {
  return scope === 'anti' ? `${storageKeys.sessionRailSeenCompletedRuns}.anti` : storageKeys.sessionRailSeenCompletedRuns
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function parseSeen(raw: string | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean: Record<string, string> = {}
    for (const [sid, val] of Object.entries(parsed)) {
      if (typeof val === 'string' && val) clean[sid] = val
    }
    return clean
  } catch {
    return {}
  }
}

function parseUnread(raw: string | null): Record<string, SessionUnreadEntry> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const clean: Record<string, SessionUnreadEntry> = {}
    for (const [sid, val] of Object.entries(parsed)) {
      if (!val || typeof val !== 'object' || Array.isArray(val)) continue
      const entry = val as { runId?: unknown; kind?: unknown }
      if (typeof entry.runId === 'string' && entry.runId && (entry.kind === 'completed' || entry.kind === 'error')) {
        clean[sid] = { runId: entry.runId, kind: entry.kind }
      }
    }
    return clean
  } catch {
    return {}
  }
}

function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function emitChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CHANGED_EVENT))
  }
}

type CacheEntry = {
  rawUnread: string | null | undefined
  rawSeen: string | null | undefined
  snapshot: SessionUnreadSnapshot
}

const snapshotCache: Record<SessionScope, CacheEntry> = {
  chat: { rawUnread: undefined, rawSeen: undefined, snapshot: { unread: {}, seen: {} } },
  anti: { rawUnread: undefined, rawSeen: undefined, snapshot: { unread: {}, seen: {} } },
}

const EMPTY_SNAPSHOT: SessionUnreadSnapshot = { unread: {}, seen: {} }

export function getSessionUnreadSnapshot(scope: SessionScope): SessionUnreadSnapshot {
  const rawUnread = readRaw(unreadKeyFor(scope))
  const rawSeen = readRaw(seenKeyFor(scope))
  const entry = snapshotCache[scope]
  if (entry.rawUnread === rawUnread && entry.rawSeen === rawSeen) {
    return entry.snapshot
  }
  const next: SessionUnreadSnapshot = {
    unread: parseUnread(rawUnread),
    seen: parseSeen(rawSeen),
  }
  entry.rawUnread = rawUnread
  entry.rawSeen = rawSeen
  entry.snapshot = next
  return next
}

export function hasUnreadSessions(scope: SessionScope): boolean {
  const { unread, seen } = getSessionUnreadSnapshot(scope)
  return Object.entries(unread).some(([sid, item]) => seen[sid] !== item.runId)
}

export function recordSessionTerminal(
  scope: SessionScope,
  sessionId: string,
  runId: string,
  outcome: 'completed' | 'cancelled' | 'failed' | null | undefined,
): void {
  if (!sessionId || !runId) return
  const unreadKey = unreadKeyFor(scope)
  const unread = { ...parseUnread(readRaw(unreadKey)) }
  if (outcome === 'cancelled') {
    if (!(sessionId in unread)) return
    delete unread[sessionId]
    if (writeJson(unreadKey, unread)) emitChange()
    return
  }
  const seen = parseSeen(readRaw(seenKeyFor(scope)))
  if (seen[sessionId] === runId) return
  const kind: 'completed' | 'error' = outcome === 'failed' ? 'error' : 'completed'
  const prev = unread[sessionId]
  if (prev?.runId === runId && prev.kind === kind) return
  unread[sessionId] = { runId, kind }
  if (writeJson(unreadKey, unread)) emitChange()
}

export function markSessionActive(scope: SessionScope, sessionId: string): void {
  if (!sessionId) return
  const unreadKey = unreadKeyFor(scope)
  const unread = { ...parseUnread(readRaw(unreadKey)) }
  if (!(sessionId in unread)) return
  delete unread[sessionId]
  if (writeJson(unreadKey, unread)) emitChange()
}

export function markSessionRead(
  scope: SessionScope,
  sessionId: string,
  runId?: string | null,
): void {
  if (!sessionId) return
  const unreadKey = unreadKeyFor(scope)
  const seenKey = seenKeyFor(scope)
  const unread = { ...parseUnread(readRaw(unreadKey)) }
  const seen = { ...parseSeen(readRaw(seenKey)) }
  const effectiveRunId = (runId && runId.trim()) ? runId : unread[sessionId]?.runId

  let changed = false
  if (sessionId in unread) {
    delete unread[sessionId]
    writeJson(unreadKey, unread)
    changed = true
  }
  if (effectiveRunId && seen[sessionId] !== effectiveRunId) {
    seen[sessionId] = effectiveRunId
    writeJson(seenKey, seen)
    changed = true
  }
  if (changed) emitChange()
}

export function reconcileScopeSessions(
  scope: SessionScope,
  validSessionIds: ReadonlySet<string>,
): void {
  const unreadKey = unreadKeyFor(scope)
  const unread = { ...parseUnread(readRaw(unreadKey)) }
  let changed = false
  for (const sid of Object.keys(unread)) {
    if (!validSessionIds.has(sid)) {
      delete unread[sid]
      changed = true
    }
  }
  if (changed && writeJson(unreadKey, unread)) emitChange()
}

export function syncRuntimeSnapshot(
  scope: SessionScope,
  runtimes: Record<string, SessionRuntime>,
  validSessionIds?: ReadonlySet<string>,
): void {
  const unreadKey = unreadKeyFor(scope)
  const seen = parseSeen(readRaw(seenKeyFor(scope)))
  const unread = { ...parseUnread(readRaw(unreadKey)) }
  let changed = false

  if (validSessionIds) {
    for (const sid of Object.keys(unread)) {
      if (!validSessionIds.has(sid)) {
        delete unread[sid]
        changed = true
      }
    }
  }

  for (const [sid, runtime] of Object.entries(runtimes)) {
    if (!runtime || (validSessionIds && !validSessionIds.has(sid))) continue
    const activity = sessionActivity(runtime)
    if (activity === 'active') {
      if (sid in unread) {
        delete unread[sid]
        changed = true
      }
      continue
    }
    if (runtime.completed_run_id) {
      if (runtime.outcome === 'cancelled') {
        if (sid in unread) {
          delete unread[sid]
          changed = true
        }
        continue
      }
      const kind: 'completed' | 'error' = (runtime.outcome === 'failed' || Boolean(runtime.error))
        ? 'error'
        : 'completed'
      if (seen[sid] !== runtime.completed_run_id) {
        const prev = unread[sid]
        if (prev?.runId !== runtime.completed_run_id || prev.kind !== kind) {
          unread[sid] = { runId: runtime.completed_run_id, kind }
          changed = true
        }
      }
      continue
    }
    if (runtime.status === 'error') {
      const errKey = runtime.run_id ?? 'error'
      if (seen[sid] !== errKey) {
        const prev = unread[sid]
        if (prev?.runId !== errKey || prev.kind !== 'error') {
          unread[sid] = { runId: errKey, kind: 'error' }
          changed = true
        }
      }
    }
  }

  if (changed && writeJson(unreadKey, unread)) emitChange()
}

function subscribe(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(CHANGED_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(CHANGED_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useHasUnreadSessions(scope: SessionScope): boolean {
  return useSyncExternalStore(
    subscribe,
    () => hasUnreadSessions(scope),
    () => false,
  )
}

export function useSessionUnreadSnapshot(scope: SessionScope): SessionUnreadSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => getSessionUnreadSnapshot(scope),
    () => EMPTY_SNAPSHOT,
  )
}
