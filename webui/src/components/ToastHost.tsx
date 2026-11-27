// Renders the in-app toast stack (bottom-center) from useToastStore.
// Mounted once at App root. Self-contained styling (scoped keyframes) so it
// doesn't touch the shared index.css that other work may be editing.

import { useEffect, useRef } from 'react'
import { CheckCircle2, Info, XCircle, type LucideIcon } from 'lucide-react'
import { CloseIconButton } from '@/components/ActionIcons'
import { useToastStore, type ToastKind } from '@/stores/toastStore'
import { Z_LAYERS } from '@/config/zLayers'

const TONE: Record<ToastKind, { ring: string; Icon: LucideIcon; iconCls: string }> = {
  success: { ring: 'border-status-success-line', Icon: CheckCircle2, iconCls: 'text-status-success' },
  error: { ring: 'border-status-danger-line', Icon: XCircle, iconCls: 'text-status-danger' },
  info: { ring: 'border-status-info-line', Icon: Info, iconCls: 'text-status-info' },
}

export function ToastHost() {
  const items = useToastStore((s) => s.items)
  const dismiss = useToastStore((s) => s.dismiss)
  const pause = useToastStore((s) => s.pause)
  const resume = useToastStore((s) => s.resume)
  const hoveredIdsRef = useRef(new Set<number>())
  const focusedIdsRef = useRef(new Set<number>())

  useEffect(() => {
    const liveIds = new Set(items.map((t) => t.id))
    for (const id of hoveredIdsRef.current) {
      if (!liveIds.has(id)) hoveredIdsRef.current.delete(id)
    }
    for (const id of focusedIdsRef.current) {
      if (!liveIds.has(id)) focusedIdsRef.current.delete(id)
    }
  }, [items])

  if (items.length === 0) return null

  return (
    <div style={{ zIndex: Z_LAYERS.toast }}
      className="fixed inset-x-0 bottom-5 flex flex-col items-center gap-2 px-4 pointer-events-none">
      <style>{`
        @keyframes ga-toast-in {
          from { opacity: 0; transform: translateY(12px) scale(0.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}</style>
      {items.map((t) => {
        const tone = TONE[t.kind]
        return (
          <div
            key={t.id}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => {
              hoveredIdsRef.current.add(t.id)
              pause(t.id)
            }}
            onMouseLeave={() => {
              hoveredIdsRef.current.delete(t.id)
              if (!focusedIdsRef.current.has(t.id)) {
                resume(t.id)
              }
            }}
            onFocus={() => {
              focusedIdsRef.current.add(t.id)
              pause(t.id)
            }}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                focusedIdsRef.current.delete(t.id)
                if (!hoveredIdsRef.current.has(t.id)) {
                  resume(t.id)
                }
              }
            }}
            style={{ animation: 'ga-toast-in 160ms ease-out' }}
            className={`ga-paper-popover pointer-events-auto select-text max-w-md w-fit flex items-start gap-2.5 rounded-xl border ${tone.ring} pl-4 pr-2.5 py-2.5 text-sm text-ink`}
          >
            <tone.Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.iconCls}`} strokeWidth={2} aria-hidden="true" />
            <span className="min-w-0 flex-1 whitespace-pre-line leading-5 break-words">{t.message}</span>
            <CloseIconButton
              label="关闭提示"
              className="-mr-0.5 -mt-0.5 shrink-0"
              onClick={() => dismiss(t.id)}
            />
          </div>
        )
      })}
    </div>
  )
}
