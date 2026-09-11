// HistoryPanel — the task-history list, rendered inside the header drawer.
//
// History is a look-back surface, not a daily driver: it lives behind the
// header trigger so the left column can lead with the task that is actually
// running. Rows are intentionally minimal — title + counts + time and one
// status glyph (✓ done / ✗ failed / ◔ running); with a handful of tasks,
// filters/search/sort are ceremony, not help. Terminal rows are always
// deletable; while the conductor runs, live rows stay locked — once it stops
// (paused session) all are.
//
// Row computation lives in presentation.ts (`historyRowsOf`) because the
// header trigger shows the same attention count this list renders.
import { memo } from 'react'
import { CheckCircle2, History, Loader, Trash2, XCircle } from 'lucide-react'
import { formatRelativeTime } from '@/utils/timeFormat'
import type { HistoryRow } from './presentation'

type Props = {
  rows: HistoryRow[]
  selectedId?: string
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  deletingIds?: ReadonlySet<string>
}

export const HistoryPanel = memo(function HistoryPanel({ rows, selectedId, onSelect, onDelete, deletingIds }: Props) {
  // No visible header: the dropdown hangs off the 历史任务 trigger, which
  // already carries the count and the 待处理 badge — repeating them here is
  // ceremony. The sr-only heading keeps the dialog labelled for AT.
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 id="conductor-history-title" className="sr-only">历史任务</h2>
      <div className="conductor-history-list" aria-label="历史任务列表">
        {rows.map((row) => (
          <div key={row.requestId} className="conductor-history-item" data-deleting={deletingIds?.has(row.requestId) || undefined}>
            <button type="button" className="conductor-history-row"
              data-selected={selectedId === row.requestId} aria-current={selectedId === row.requestId ? 'true' : undefined}
              onClick={() => onSelect(row.requestId)} aria-label={`切换到任务：${row.title}`}>
              {/* Status glyph leads the row: it is the first thing the eye
                  needs when stepping through tasks in the open dropdown. */}
              <span className="conductor-history-status" title={row.view.label}>
                {row.view.tone === 'done' ? <CheckCircle2 size={15} className="text-status-success" />
                  : row.closed ? <XCircle size={15} className="text-status-danger" />
                  : <Loader size={15} className="conductor-history-running" />}
              </span>
              <span className="conductor-history-title">{row.title}</span>
              <span className="conductor-history-meta">
                <span>{row.total ? `已通过 ${row.accepted}/${row.total}` : '尚未指派子代理'}</span>
                <time>{formatRelativeTime(row.createdAt)}</time>
              </span>
            </button>
            {row.deletable && (
              <button type="button" className="conductor-history-delete" title="从历史中删除该任务"
                aria-label={`删除任务：${row.title}`} disabled={deletingIds?.has(row.requestId)}
                onClick={() => onDelete(row.requestId)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      {rows.length === 0 && (
        <div className="conductor-empty"><History size={24} strokeWidth={1.4} /><p>暂无任务</p></div>
      )}
    </div>
  )
})
