import { useCallback, useRef, useState, type KeyboardEvent } from 'react'

export function useImeCompositionGuard(graceMs = 80) {
  const [composing, setComposing] = useState(false)
  const composingRef = useRef(false)
  const lastCompEndRef = useRef(0)

  const onCompositionStart = useCallback(() => {
    composingRef.current = true
    setComposing(true)
  }, [])

  const onCompositionEnd = useCallback(() => {
    composingRef.current = false
    lastCompEndRef.current = Date.now()
    setComposing(false)
  }, [])

  const isImeEnterOrComposing = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const isComposing =
        composing ||
        composingRef.current ||
        e.nativeEvent.isComposing ||
        e.keyCode === 229
      const isRecentImeEnter =
        e.key === 'Enter' && Date.now() - lastCompEndRef.current < graceMs
      return isComposing || isRecentImeEnter
    },
    [composing, graceMs],
  )

  return {
    composing,
    onCompositionStart,
    onCompositionEnd,
    isImeEnterOrComposing,
  }
}
