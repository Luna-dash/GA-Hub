// WorkflowBadge — colored stage chip for the current-task card.
import clsx from 'clsx'

export function WorkflowBadge({
  tone,
  label,
}: {
  tone: 'active' | 'review' | 'done' | 'error' | 'idle'
  label: string
}) {
  return (
    <span
      className={clsx(
        'shrink-0 rounded px-2 py-0.5 text-[11px] font-medium',
        tone === 'active' && 'bg-status-warning-soft text-status-warning',
        tone === 'review' && 'bg-status-info-soft text-status-info',
        tone === 'done' && 'bg-status-success-soft text-status-success',
        tone === 'error' && 'bg-status-danger-soft text-status-danger',
        tone === 'idle' && 'bg-bg-soft text-ink-muted',
      )}
    >
      {label}
    </span>
  )
}
