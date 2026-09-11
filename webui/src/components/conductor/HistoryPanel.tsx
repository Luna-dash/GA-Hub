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
  const attentionCount = rows.filter((row) => row.needsAttention).length
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="conductor-history-head">
        <h2 id="conductor-history-title" className="text-sm font-semibold text-ink">
          历史任务 <span className="conductor-history-head-count">{rows.length}</span>
        </h2>
        {attentionCount > 0 && (
          <span className="rounded-full border border-status-warning-line bg-status-warning-soft px-2 py-0.5 text-[10px] text-status-warning">
            {attentionCount} 待处理
          </span>
        )}
      </div>
      <p className="conductor-history-note">
        点选一条即切换到该任务；再点选同一条回到最新任务。
      </p>
      <div className="conductor-history-list" aria-label="历史任务列表">
        {rows.map((row) => (
          <div key={row.requestId} className="conductor-history-item" data-deleting={deletingIds?.has(row.requestId) || undefined}>
            <button type="button" className="conductor-history-row"
              data-selected={selectedId === row.requestId} aria-current={selectedId === row.requestId ? 'true' : undefined}
              onClick={() => onSelect(row.requestId)} aria-label={`切换到任务：${row.title}`}>
              <span className="conductor-history-title">{row.title}</span>
              <span className="conductor-history-meta">
                <span>{row.total ? `已通过 ${row.accepted}/${row.total}` : '尚未指派子代理'}</span>
                <time>{formatRelativeTime(row.createdAt)}</time>
              </span>
              <span className="conductor-history-status" title={row.view.label}>
                {row.view.tone === 'done' ? <CheckCircle2 size={15} className="text-status-success" />
                  : row.closed ? <XCircle size={15} className="text-status-danger" />
                  : <Loader size={15} className="conductor-history-running" />}
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
