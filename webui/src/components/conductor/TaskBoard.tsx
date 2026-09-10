// TaskBoard — history compressed into one collapsible bar; each row carries
// a delete action. Terminal rows are always deletable; while the conductor
// runs, live rows stay locked — once it stops (paused session) all are.
// Rows are intentionally minimal: title + counts + time, and a single status
// glyph at the end (✓ done / ✗ failed / ◔ running) — no badges, filters,
// search or sort; with a handful of tasks those are ceremony, not help.
import { memo, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ChevronDown, History, Loader, Trash2, XCircle } from 'lucide-react'
import type { ConductorWorkflow, ConductorSubagent } from '@/api/types'
import { storageKeys } from '@/config/storageKeys'
import { formatRelativeTime } from '@/utils/timeFormat'
import { isReviewable, isWorkflowClosed, workflowPresentation } from './presentation'

type Props = {
  workflows: ConductorWorkflow[]
  workers: ConductorSubagent[]
  titles: Map<string, string>
  selectedId?: string
  started: boolean
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  deletingIds?: ReadonlySet<string>
}

export const TaskBoard = memo(function TaskBoard({ workflows, workers, titles, selectedId, started, onSelect, onDelete, deletingIds }: Props) {
  const [listOpen, setListOpen] = useState(() => localStorage.getItem(storageKeys.conductorHistoryOpen) === '1')
  useEffect(() => {
    localStorage.setItem(storageKeys.conductorHistoryOpen, listOpen ? '1' : '0')
  }, [listOpen])
  const rows = useMemo(() => {
    const byId = new Map(workers.map(worker => [worker.id, worker]))
    const byRequest = new Map<string, ConductorSubagent[]>()
    for (const worker of workers) {
      if (worker.request_id) {
        const siblings = byRequest.get(worker.request_id) ?? []
        siblings.push(worker)
        byRequest.set(worker.request_id, siblings)
      }
    }
    return workflows.map(workflow => {
    const owned = [...new Set([...Object.keys(workflow.subagents).map(id => byId.get(id)),
      ...(byRequest.get(workflow.request_id) ?? [])])].filter((worker): worker is ConductorSubagent => Boolean(worker))
    const view = workflowPresentation(workflow, started)
    const closed = isWorkflowClosed(workflow)
    const needsAttention = view.tone === 'error' || (!closed && (workflow.stage === 'awaiting_review'
      || workflow.stage === 'recoverable_failure' || owned.some(isReviewable)))
    // Count from the merged worker list when we have it: archived rows are
    // in `owned` but absent from the tracker's subagents map, and a history
    // row saying "尚未指派" while the board shows four cards contradicts
    // itself. The tracker map stays the fallback for workers already pruned
    // from both pool and archive.
    const total = owned.length || Object.keys(workflow.subagents).length
    const accepted = owned.length
      ? owned.filter(worker => worker.review_status === 'accepted').length
      : Object.values(workflow.subagents).filter(worker => worker.state === 'accepted').length
    return { workflow, owned, view, needsAttention, closed, accepted,
      deletable: closed || !started,
      title: titles.get(workflow.request_id) || '未命名任务', total }
    })
  }, [workflows, workers, titles, started])
  const attentionCount = rows.filter(row => row.needsAttention).length
  // Fixed order: whatever needs a human decision first, then newest first.
  // A one-glance list does not need a sort control.
  const visible = [...rows].sort((a, b) =>
    Number(b.needsAttention) - Number(a.needsAttention) || b.workflow.created_at - a.workflow.created_at)

  return <section aria-label="任务历史" className="conductor-history">
    <button type="button" className="conductor-history-bar" aria-expanded={listOpen}
      aria-label={listOpen ? '折叠历史任务' : '展开历史任务'}
      onClick={() => setListOpen(value => !value)}>
      <History size={15} />
      <h2>历史任务 <span>{workflows.length}</span></h2>
      {attentionCount > 0 && <span className="conductor-history-bar-attention">{attentionCount} 待处理</span>}
      <ChevronDown size={15} className="conductor-history-chevron" data-open={listOpen || undefined} />
    </button>
    {listOpen && (
      <div className="conductor-history-body">
        <div className="conductor-history-list" aria-label="历史任务列表">
          {visible.map(({ workflow, title, view, total, accepted, needsAttention, deletable, closed }) => (
            <div key={workflow.request_id} className="conductor-history-item" data-deleting={deletingIds?.has(workflow.request_id) || undefined}>
              <button type="button" className="conductor-history-row"
                data-selected={selectedId === workflow.request_id} aria-current={selectedId === workflow.request_id ? 'true' : undefined}
                onClick={() => onSelect(workflow.request_id)} aria-label={`切换到任务：${title}`}>
                <span className="conductor-history-title">{title}</span>
                <span className="conductor-history-meta"><span>{total ? `${accepted}/${total} 子任务已通过` : '尚未指派'}</span><time>{formatRelativeTime(workflow.created_at)}</time></span>
                <span className="conductor-history-status" title={view.label}>
                  {workflow.status === 'completed' ? <CheckCircle2 size={15} className="text-status-success" />
                    : closed ? <XCircle size={15} className="text-status-danger" />
                    : <Loader size={15} className="conductor-history-running" />}
                </span>
              </button>
              {deletable && (
                <button type="button" className="conductor-history-delete" title="从历史中删除该任务"
                  aria-label={`删除任务：${title}`} disabled={deletingIds?.has(workflow.request_id)}
                  onClick={() => onDelete(workflow.request_id)}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
        {visible.length === 0 && <div className="conductor-empty"><History size={24} strokeWidth={1.4} />
          <p>暂无任务</p></div>}
      </div>
    )}
  </section>
})
