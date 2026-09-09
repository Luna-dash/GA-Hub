// TaskBoard — history compressed into one collapsible bar; each row carries
// a delete action. Terminal rows are always deletable; while the conductor
// runs, live rows stay locked — once it stops (paused session) all are.
import { memo, useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Clock3, History, Search, Trash2 } from 'lucide-react'
import type { ConductorWorkflow, ConductorSubagent } from '@/api/types'
import { storageKeys } from '@/config/storageKeys'
import { formatRelativeTime } from '@/utils/timeFormat'
import { isReviewable, isWorkflowClosed, workflowPresentation } from './presentation'
import { WorkflowBadge } from './WorkflowBadge'

type Filter = 'all' | 'active' | 'attention' | 'done'
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
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('attention')
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
    const accepted = Object.values(workflow.subagents).filter(worker => worker.state === 'accepted').length
    return { workflow, owned, view, needsAttention, closed, accepted,
      deletable: closed || !started,
      title: titles.get(workflow.request_id) || '未命名任务', total: Object.keys(workflow.subagents).length }
    })
  }, [workflows, workers, titles, started])
  const counts = {
    all: rows.length, active: rows.filter(row => !row.closed).length,
    attention: rows.filter(row => row.needsAttention).length,
    done: rows.filter(row => row.workflow.status === 'completed').length,
  }
  const visible = rows.filter(row => (
    (filter === 'all' || (filter === 'active' && !row.closed)
      || (filter === 'attention' && row.needsAttention) || (filter === 'done' && row.workflow.status === 'completed'))
    && `${row.title} ${row.workflow.request_id}`.toLowerCase().includes(search.trim().toLowerCase())
  )).sort((a, b) => sort === 'attention'
    ? Number(b.needsAttention) - Number(a.needsAttention) || b.workflow.created_at - a.workflow.created_at
    : b.workflow.created_at - a.workflow.created_at)

  return <section aria-label="任务历史" className="conductor-history">
    <button type="button" className="conductor-history-bar" aria-expanded={listOpen}
      aria-label={listOpen ? '折叠历史任务' : '展开历史任务'}
      onClick={() => setListOpen(value => !value)}>
      <History size={15} />
      <h2>历史任务 <span>{workflows.length}</span></h2>
      {counts.attention > 0 && <span className="conductor-history-bar-attention">{counts.attention} 待处理</span>}
      <ChevronDown size={15} className="conductor-history-chevron" data-open={listOpen || undefined} />
    </button>
    {listOpen && (
      <div className="conductor-history-body">
        <div className="conductor-board-tools">
          <div className="conductor-filters" role="tablist" aria-label="任务状态">
            {([['all', '全部'], ['active', '进行中'], ['attention', '待处理'], ['done', '已完成']] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>
                {label}<span>{counts[key]}</span>
              </button>
            ))}
          </div>
          <label className="conductor-search"><Search size={15} aria-hidden="true" />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />
          </label>
          <select aria-label="任务排序" value={sort} onChange={event => setSort(event.target.value)}>
            <option value="attention">待处理优先</option><option value="recent">最新任务优先</option>
          </select>
        </div>
        <div className="conductor-history-list" aria-label="历史任务列表">
          {visible.map(({ workflow, title, view, total, accepted, needsAttention, deletable }) => (
            <div key={workflow.request_id} className="conductor-history-item" data-deleting={deletingIds?.has(workflow.request_id) || undefined}>
              <button type="button" className="conductor-history-row"
                data-selected={selectedId === workflow.request_id} aria-current={selectedId === workflow.request_id ? 'true' : undefined}
                onClick={() => onSelect(workflow.request_id)} aria-label={`切换到任务：${title}`}>
                <span className="conductor-history-status"><WorkflowBadge tone={view.tone} label={view.label} />
                  {needsAttention ? <AlertCircle size={15} className="text-status-warning-strong" />
                    : workflow.status === 'completed' ? <CheckCircle2 size={15} className="text-status-success" /> : <Clock3 size={15} />}
                </span>
                <span className="conductor-history-title">{title}</span>
                <span className="conductor-history-meta"><span>{total ? `${accepted}/${total} 子任务已通过` : '尚未指派'}</span><time>{formatRelativeTime(workflow.created_at)}</time></span>
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
          <p>{rows.length ? '没有匹配的任务' : '暂无任务'}</p></div>}
      </div>
    )}
  </section>
})
