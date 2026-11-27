// HistoryDropdown — the 历史任务 trigger with its anchored popover.
//
// History is a look-back surface, not a daily driver: it hangs off the header
// so the left column can lead with the task that is actually running. The
// dropdown is deliberately non-modal — no backdrop, no scroll lock, no focus
// trap; it dismisses on Escape (returning focus to the trigger) or on a
// pointer press outside the trigger + panel, and stays open across row
// selection because stepping through tasks is the whole point.
import { useEffect, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { Z_LAYERS } from '@/config/zLayers'
import { useOverlayRegistration } from '@/hooks/useOverlayRegistration'
import { hasHigherLayerOverlay } from '@/utils/overlayStack'
import type { HistoryRow } from './presentation'
import { HistoryPanel } from './HistoryPanel'

export function HistoryDropdown({ rows, selectedId, onSelect, onDelete, deletingIds }: {
  rows: HistoryRow[]
  selectedId?: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  deletingIds: ReadonlySet<string>
}) {
  const [open, setOpen] = useState(false)
  const popAreaRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const attention = rows.filter((row) => row.needsAttention).length

  useOverlayRegistration({
    active: open,
    zIndex: Z_LAYERS.popover,
    getPanel: () => popAreaRef.current,
    onEscape: () => {
      setOpen(false)
      triggerRef.current?.focus()
    },
    trapFocus: false,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (hasHigherLayerOverlay(Z_LAYERS.popover)) return
      const area = popAreaRef.current
      if (area && !area.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  return (
    <div className="conductor-header-history" ref={popAreaRef}>
      <button
        type="button"
        ref={triggerRef}
        className="ga-btn conductor-history-trigger"
        aria-label="历史任务"
        aria-haspopup="dialog"
        aria-controls="conductor-history-dropdown"
        aria-expanded={open}
        title="查看历史任务（按需回看）"
        onClick={() => setOpen((current) => !current)}
      >
        <History size={14} />
        <span>历史任务</span>
        <span className="conductor-history-trigger-count">{rows.length}</span>
        {attention > 0 && (
          <span className="rounded-full border border-status-warning-line bg-status-warning-soft px-1.5 text-[10px] text-status-warning">
            {attention} 待处理
          </span>
        )}
      </button>
      {open && (
        <div
          id="conductor-history-dropdown"
          role="dialog"
          aria-labelledby="conductor-history-title"
          style={{ zIndex: Z_LAYERS.popover }}
          className="conductor-history-pop"
        >
          <HistoryPanel
            rows={rows}
            selectedId={selectedId}
            onSelect={onSelect}
            onDelete={onDelete}
            deletingIds={deletingIds}
          />
        </div>
      )}
    </div>
  )
}
