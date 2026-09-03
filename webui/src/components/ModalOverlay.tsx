// ModalOverlay — shared modal shell: fixed backdrop + centered panel with
// click-outside-to-close. Replaces the hand-rolled 'fixed inset-0' overlays
// that each page used to build (review: three dialog mechanisms converged;
// alert/confirm/prompt stay on dialogStore+DialogHost).
import { type CSSProperties, type ReactNode, type Ref } from 'react'
import clsx from 'clsx'

interface ModalOverlayProps {
  onClose: () => void
  children: ReactNode
  /** Width/sizing classes for the panel, e.g. 'w-[38rem] max-w-[92vw]'. */
  panelClassName?: string
  /** Optional ref forwarded to the panel element (focus trapping etc.). */
  panelRef?: Ref<HTMLDivElement>
  /** id of the element that labels this dialog (aria-labelledby). */
  labelledBy?: string
  /** Panel placement: centered modal (default) or right-hand drawer. */
  align?: 'center' | 'right'
  /** Padding override; defaults to none (pages bring their own). */
  panelStyle?: CSSProperties
}

export function ModalOverlay({ onClose, children, panelClassName, panelRef, labelledBy, align = 'center', panelStyle }: ModalOverlayProps) {
  return (
    <div
      className={clsx(
        'fixed inset-0 z-50 bg-black/55 backdrop-blur-sm flex',
        align === 'center' ? 'items-center justify-center px-4' : 'items-stretch justify-end',
      )}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        style={panelStyle}
        className={clsx('bg-bg-soft border-line shadow-2xl', align === 'center' && 'border rounded-xl', panelClassName)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}
