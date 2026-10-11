import { useCallback, useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useChatStore } from '@/stores/chatStore'

/** Capture permission to select a session before the first async boundary.
 * Navigation (even away and back), a session change, or unmount permanently
 * revokes it. Creation may still finish and populate the cache.
 */
export function useSessionSelectionGuard(): () => () => boolean {
  const location = useLocation()
  const epoch = useRef(0)
  const mounted = useRef(false)

  useLayoutEffect(() => {
    epoch.current += 1
  }, [location])

  useLayoutEffect(() => {
    mounted.current = true
    // Subscribe directly: React may batch A -> B -> A into one render.
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.sessionId !== previous.sessionId) epoch.current += 1
    })
    return () => {
      mounted.current = false
      epoch.current += 1
      unsubscribe()
    }
  }, [])

  return useCallback(() => {
    const captured = epoch.current
    return () => mounted.current && epoch.current === captured
  }, [])
}
