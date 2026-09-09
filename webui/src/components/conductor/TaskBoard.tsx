import { memo, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock3, Layers3, Search } from 'lucide-react'
import type { ConductorWorkflow, ConductorSubagent } from '@/api/types'
import { formatRelativeTime } from '@/utils/timeFormat'
import { isReviewable, workflowPresentation, WORKFLOW_STAGE_CLOSED } from './presentation'
import { WorkflowBadge } from './WorkflowBadge'

type Filter = 'all' | 'active' | 'attention' | 'done'
type Props = {
  workflows: ConductorWorkflow[]
  workers: ConductorSubagent[]
  titles: Map<string, string>
  selectedId?: string
  started: boolean
  onSelect: (id: string) => void
}

export const TaskBoard = memo(function TaskBoard({ workflows, workers, titles, selectedId, started, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('attention')
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
    const closed = WORKFLOW_STAGE_CLOSED.has(workflow.stage ?? '')
    const needsAttention = view.tone === 'error' || (!closed && (workflow.stage === 'awaiting_review'
      || workflow.stage === 'recoverable_failure' || owned.some(isReviewable)))
    const accepted = Object.values(workflow.subagents).filter(worker => worker.state === 'accepted').length
    return { workflow, owned, view, needsAttention, closed, accepted,
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

  return <section aria-label="任务看板" className="conductor-board">
    <div className="conductor-board-heading">
      <h2><Layers3 size={17} />任务看板 <span>{workflows.length}</span></h2>
      <select aria-label="任务排序" value={sort} onChange={event => setSort(event.target.value)}>
        <option value="attention">待处理优先</option><option value="recent">最新任务优先</option>
      </select>
    </div>
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
    </div>
    <div className="conductor-task-grid" aria-label="任务历史">
      {visible.map(({ workflow, title, view, total, accepted, needsAttention, owned }) => (
        <button key={workflow.request_id} type="button" className="conductor-task-card"
          data-selected={selectedId === workflow.request_id} aria-current={selectedId === workflow.request_id ? 'true' : undefined}
          onClick={() => onSelect(workflow.request_id)} aria-label={`切换到任务：${title}`}>
          <div className="conductor-card-top"><WorkflowBadge tone={view.tone} label={view.label} />
            {needsAttention ? <AlertCircle size={15} className="text-status-warning-strong" />
              : workflow.status === 'completed' ? <CheckCircle2 size={15} className="text-status-success" /> : <Clock3 size={15} />}
          </div>
          <h3>{title}</h3>
          <p className="conductor-card-summary">{workflow.error || (owned.find(worker => worker.status === 'running')?.reply) || view.detail}</p>
          <div className="conductor-card-progress" role="progressbar" aria-label={`${title}验收进度`} aria-valuemin={0}
            aria-valuenow={accepted} aria-valuemax={Math.max(1, total)}><span style={{ width: `${total ? accepted / total * 100 : 0}%` }} /></div>
          <div className="conductor-card-footer"><span>{total ? `${accepted}/${total} 子任务已通过` : '尚未指派'}</span>
            <time>{formatRelativeTime(workflow.created_at)}</time></div>
        </button>
      ))}
    </div>
    {visible.length === 0 && <div className="conductor-empty"><Layers3 size={28} strokeWidth={1.4} />
      <p>{rows.length ? '没有匹配的任务' : '暂无任务'}</p></div>}
  </section>
})
