// ModalOverlay — shared modal shell: fixed backdrop + centered or drawer
// panel. Behavior is part of the contract, not just visuals: Escape closes,
// Tab is trapped inside the panel, focus enters on open and returns to the
// opener on unmount, body scroll is locked, and the z-index comes from the
// shared layer table (config/zLayers) so overlays cannot fight each other.
// alert/confirm/prompt stay on dialogStore+DialogHost.
import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from 'react'
import clsx from 'clsx'
import { Z_LAYERS } from '@/config/zLayers'
import { isTopOverlay, registerOverlay, restoreOverlayFocus } from '@/utils/overlayStack'

interface ModalOverlayProps {
  onClose: () => void
  children: ReactNode
  /** Width/sizing classes for the panel, e.g. 'w-[38rem] max-w-[92vw]'. */
  panelClassName?: string
  /** Optional ref forwarded to the panel element. */
  panelRef?: Ref<HTMLDivElement>
  /** id of the element that labels this dialog (aria-labelledby). */
  labelledBy?: string
  /** Panel placement: centered modal (default) or right-hand drawer. */
  align?: 'center' | 'right'
  /** Padding override; defaults to none (pages bring their own). */
  panelStyle?: CSSProperties
  /** Close when the backdrop itself is clicked (default true). Disable for
   * forms where a mis-click outside the panel would silently discard input. */
  closeOnBackdrop?: boolean
  /** Stack layer z-index (defaults to Z_LAYERS.modal). */
  zIndex?: number
}

export function ModalOverlay({
  onClose, children, panelClassName, panelRef, labelledBy,
  align = 'center', panelStyle, closeOnBackdrop = true, zIndex = Z_LAYERS.modal,
}: ModalOverlayProps) {
  const panelNode = useRef<HTMLDivElement | null>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const openerCapturedRef = useRef(false)
  if (!openerCapturedRef.current && typeof document !== 'undefined') {
    openerCapturedRef.current = true
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const overlayIdRef = useRef<number | null>(null)
  const setPanel = (node: HTMLDivElement | null) => {
    panelNode.current = node
    if (typeof panelRef === 'function') panelRef(node)
    else if (panelRef) (panelRef as { current: HTMLDivElement | null }).current = node
  }

  useEffect(() => {
    const opener = openerRef.current
    const reg = registerOverlay({
      zIndex,
      getPanel: () => panelNode.current,
      onEscape: () => onCloseRef.current(),
      lockScroll: true,
    })
    overlayIdRef.current = reg.id
    const panel = panelNode.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
    return () => {
      reg.unregister()
      overlayIdRef.current = null
      restoreOverlayFocus(opener)
    }
  }, [zIndex])

  return (
    <div
      className={clsx(
        'bg-[#241B12]/40 backdrop-blur-[3px] flex',
        align === 'center' ? 'items-center justify-center px-4' : 'items-stretch justify-end',
      )}
      style={{ position: 'fixed', inset: 0, zIndex }}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget && isTopOverlay(overlayIdRef.current)) onClose()
      }}
    >
      <div
        ref={setPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={panelStyle}
        className={clsx('bg-bg-soft border-line shadow-[inset_0_1px_0_rgba(255,250,232,0.72),0_18px_40px_rgba(45,34,22,0.22)] focus:outline-none', align === 'center' && 'border rounded-xl', panelClassName)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
