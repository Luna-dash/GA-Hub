import { useEffect, useRef } from 'react'
import { registerOverlay } from '@/utils/overlayStack'

export interface UseOverlayRegistrationOptions {
  active: boolean
  zIndex: number
  getPanel: () => HTMLElement | null
  onEscape: () => void
  lockScroll?: boolean
  trapFocus?: boolean
}

/**
 * Registers an overlay/popover/gate with the global overlay stack while `active` is true.
 * Stores `getPanel` and `onEscape` in refs so callback identity churn never re-orders the stack.
 */
export function useOverlayRegistration({
  active,
  zIndex,
  getPanel,
  onEscape,
  lockScroll = false,
  trapFocus = false,
}: UseOverlayRegistrationOptions) {
  const getPanelRef = useRef(getPanel)
  getPanelRef.current = getPanel
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  const overlayIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      overlayIdRef.current = null
      return
    }
    const reg = registerOverlay({
      zIndex,
      getPanel: () => getPanelRef.current(),
      onEscape: () => onEscapeRef.current(),
      lockScroll,
      trapFocus,
    })
    overlayIdRef.current = reg.id
    return () => {
      reg.unregister()
      overlayIdRef.current = null
    }
  }, [active, zIndex, lockScroll, trapFocus])

  return overlayIdRef
}
