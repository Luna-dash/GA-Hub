import { useEffect, useState } from 'react'

/**
 * Ticking wall clock (ms). Pass null to freeze; intervalMs throttles the
 * tick. Used for elapsed-time labels that must update while visible.
 */
export function useNowTick(intervalMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (intervalMs === null) return
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      setNow(Date.now())
    }
    const timer = window.setInterval(tick, intervalMs)
    const onVis = () => {
      if (document.visibilityState !== 'hidden') setNow(Date.now())
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
    return () => {
      window.clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
    }
  }, [intervalMs])
  return now
}
