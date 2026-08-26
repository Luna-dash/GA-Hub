// Page state memory: routes unmount their page component on navigation, so
// plain useState resets every time the user leaves and revisits a page.
// usePageState() mirrors useState, but writes through to a per-key store:
// an in-module cache (state survives route unmount/remount) plus
// sessionStorage (state survives full reloads within the browser session).
import { useState, type SetStateAction } from 'react'

const PREFIX = 'gahub.pageState.v1:'
const cache = new Map<string, unknown>()

export function readPageState<T>(key: string, initial: T): T {
  if (cache.has(key)) return cache.get(key) as T
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key)
    if (raw !== null) {
      const value = JSON.parse(raw) as T
      cache.set(key, value)
      return value
    }
  } catch {
    // Corrupted entry or storage unavailable: fall back to the initial value.
  }
  cache.set(key, initial)
  return initial
}

export function writePageState<T>(key: string, value: T): void {
  cache.set(key, value)
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Quota or serialization failure: the memory copy stays authoritative.
  }
}

export function resetPageState(): void {
  cache.clear()
  try {
    const drop: string[] = []
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const k = window.sessionStorage.key(i)
      if (k?.startsWith(PREFIX)) drop.push(k)
    }
    drop.forEach((k) => window.sessionStorage.removeItem(k))
  } catch {
    // Storage unavailable: clearing the memory layer is enough.
  }
}

export function usePageState<T>(
  key: string,
  initial: T,
): [T, (next: SetStateAction<T>) => void] {
  const [value, setValue] = useState<T>(() => readPageState(key, initial))
  const update = (next: SetStateAction<T>) => {
    setValue((prev) => {
      const resolved =
        typeof next === 'function' ? (next as (p: T) => T)(prev) : next
      writePageState(key, resolved)
      return resolved
    })
  }
  return [value, update]
}
