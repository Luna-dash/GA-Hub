import { memo } from 'react'
import { ArrowUpRight, FileCheck2, ListChecks } from 'lucide-react'
import type { ConductorSubagent } from '@/api/types'
import { milestonesOf, reviewFacts, subagentPhase, workerTitle, phaseDot } from './presentation'

export const WorkerCard = memo(function WorkerCard({ sub, selected, onSelect }: {
  sub: ConductorSubagent; selected: boolean; onSelect: () => void
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const milestones = milestonesOf(sub)
  const issues = (facts.deliverables_missing?.length ?? 0) + (facts.deliverables_stale?.length ?? 0)
    + (facts.quality_checks?.checks?.filter(check => check.passed === false).length ?? 0)
  return <button type="button" className="conductor-worker-card" onClick={onSelect}
    data-selected={selected} aria-pressed={selected} aria-label={`查看子任务：${workerTitle(sub)}`}>
    <div className="conductor-card-top"><span className="flex items-center gap-1.5 text-xs"><span className={phaseDot(view.phase)} />{view.label}</span>
      <ArrowUpRight size={15} /></div>
    <h3>{workerTitle(sub)}</h3>
    <p className="conductor-worker-summary">{sub.reply || sub.review_note || '等待执行结果'}</p>
    <div className="conductor-worker-meta"><span><FileCheck2 size={13} />{facts.manifest?.deliverables?.length ?? 0} 项交付</span>
      <span><ListChecks size={13} />{milestones.filter(item => Boolean(item.reached_at)).length}/{milestones.length} 里程碑</span>
      {sub.attempt > 1 && <span>第 {sub.attempt} 次</span>}</div>
    {issues > 0 && <p className="text-xs text-status-danger">{issues} 项需要处理</p>}
  </button>
})
