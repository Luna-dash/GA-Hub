// ModalOverlay — shared modal shell: fixed backdrop + centered or drawer
// panel. Behavior is part of the contract, not just visuals: Escape closes,
// Tab is trapped inside the panel, focus enters on open and returns to the
// opener on unmount, body scroll is locked, and the z-index comes from the
// shared layer table (config/zLayers) so overlays cannot fight each other.
// alert/confirm/prompt stay on dialogStore+DialogHost.
import { useEffect, useRef, type CSSProperties, type ReactNode, type Ref } from 'react'
import clsx from 'clsx'
import { Z_LAYERS } from '@/config/zLayers'

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
}

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export function ModalOverlay({
  onClose, children, panelClassName, panelRef, labelledBy,
  align = 'center', panelStyle, closeOnBackdrop = true,
}: ModalOverlayProps) {
  const panelNode = useRef<HTMLDivElement | null>(null)
  const setPanel = (node: HTMLDivElement | null) => {
    panelNode.current = node
    if (typeof panelRef === 'function') panelRef(node)
    else if (panelRef) (panelRef as { current: HTMLDivElement | null }).current = node
  }

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const panel = panelNode.current
    if (panel && !panel.contains(document.activeElement)) panel.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
      opener?.focus?.()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const panel = panelNode.current
      if (!panel) return
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className={clsx(
        'bg-black/55 backdrop-blur-sm flex',
        align === 'center' ? 'items-center justify-center px-4' : 'items-stretch justify-end',
      )}
      style={{ position: 'fixed', inset: 0, zIndex: Z_LAYERS.modal }}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={setPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        style={panelStyle}
        className={clsx('bg-bg-soft border-line shadow-2xl focus:outline-none', align === 'center' && 'border rounded-xl', panelClassName)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
