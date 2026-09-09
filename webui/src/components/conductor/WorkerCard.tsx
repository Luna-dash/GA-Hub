import { memo } from 'react'
import { CheckCircle2, CircleDashed, FileCheck2, ListChecks, LoaderCircle } from 'lucide-react'
import type { ConductorSubagent } from '@/api/types'
import { milestonesOf, reviewFacts, subagentPhase, workerTitle, phaseDot } from './presentation'

export const WorkerCard = memo(function WorkerCard({ sub, index, selected, onSelect }: {
  sub: ConductorSubagent; index?: number; selected: boolean; onSelect: () => void
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const milestones = milestonesOf(sub)
  const issues = (facts.deliverables_missing?.length ?? 0) + (facts.deliverables_stale?.length ?? 0)
    + (facts.quality_checks?.checks?.filter(check => check.passed === false).length ?? 0)
  const reached = milestones.filter(item => Boolean(item.reached_at)).length
  const progress = milestones.length > 0 ? Math.round((reached / milestones.length) * 100) : view.phase === 'accepted' ? 100 : 0
  const StatusIcon = view.phase === 'running' || view.phase === 'reworking' ? LoaderCircle : view.phase === 'accepted' ? CheckCircle2 : CircleDashed
  return <button type="button" className="conductor-worker-card" onClick={onSelect}
    data-selected={selected} aria-pressed={selected} aria-label={`查看子任务：${workerTitle(sub)}`}>
    <div className="conductor-worker-card-heading">
      <span className="conductor-worker-index">{index ? `子代理 ${index}` : '子代理'}</span>
      <span className="conductor-worker-status"><StatusIcon size={14} className={view.phase === 'running' || view.phase === 'reworking' ? 'animate-spin' : ''} /><span className={phaseDot(view.phase)} />{view.label}</span>
    </div>
    <h3 className="conductor-worker-title">{workerTitle(sub)}</h3>
    <p className="conductor-worker-summary">{sub.reply || sub.review_note || '等待执行结果'}</p>
    <div className="conductor-worker-progress" aria-label={`${workerTitle(sub)}里程碑进度`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
    <div className="conductor-worker-meta"><span><FileCheck2 size={13} />{facts.manifest?.deliverables?.length ?? 0} 项交付</span>
      <span><ListChecks size={13} />{milestones.filter(item => Boolean(item.reached_at)).length}/{milestones.length} 里程碑</span>
      {sub.attempt > 1 && <span>第 {sub.attempt} 次</span>}</div>
    {issues > 0 && <p className="text-xs text-status-danger">{issues} 项需要处理</p>}
  </button>
})
