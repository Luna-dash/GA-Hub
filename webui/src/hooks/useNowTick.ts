import { useEffect, useState } from 'react'

/**
 * Ticking wall clock (ms). Pass null to freeze; intervalMs throttles the
 * tick. Used for elapsed-time labels that must update while visible.
 */
export function useNowTick(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs === null) return
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
