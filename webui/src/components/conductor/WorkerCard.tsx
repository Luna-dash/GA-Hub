// WorkerCard — one slim queue row per subagent in the implementation-process
// list. The row carries identity, phase and the live numbers only; the actual
// execution record (milestones, deliverables, reply stream, review controls)
// lives exclusively in the right-hand dossier, which a click opens. The old
// in-place expansion duplicated that dossier section for section.
import { memo } from 'react'
import clsx from 'clsx'
import { CheckCircle2, CircleDashed, LoaderCircle } from 'lucide-react'
import type { ConductorSubagent } from '@/api/types'
import {
  briefWorkerTitle,
  deliverablesOf,
  milestonesOf,
  phaseDot,
  phaseTone,
  reviewFacts,
  subagentPhase,
  workerTitle,
} from './presentation'

export const WorkerCard = memo(function WorkerCard({ sub, index, selected, onSelect }: {
  sub: ConductorSubagent; index?: number; selected: boolean
  onSelect: () => void
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  // Archived rows are persisted history (engine pool is gone). They render
  // read-only and must say so: the badge plus a dashed border keep a
  // finished-but-truncated record from reading like a stalled live worker.
  const archived = Boolean(sub.archived)
  const milestones = milestonesOf(sub)
  const reached = milestones.filter(item => Boolean(item.reached_at)).length
  const progress = milestones.length > 0 ? Math.round((reached / milestones.length) * 100) : view.phase === 'accepted' ? 100 : 0
  const StatusIcon = view.phase === 'running' || view.phase === 'reworking' ? LoaderCircle : view.phase === 'accepted' ? CheckCircle2 : CircleDashed
  const deliverables = deliverablesOf(facts)
  // Row footnote: the live numbers stay one glance away instead of one click
  // away — the dossier owns the details. Sections without data drop out.
  const metaParts = [
    deliverables.length > 0 ? `${deliverables.length} 项交付` : '',
    milestones.length > 0 ? `${reached}/${milestones.length} 里程碑` : '',
    sub.attempt > 1 ? `第 ${sub.attempt} 次` : '',
  ].filter(Boolean)
  const metaNote = metaParts.join(' · ')
  const numberLabel = index ? `#${index}` : ''
  return <article className="conductor-worker-card" data-selected={selected || undefined} data-archived={archived || undefined}>
    <button type="button" className="conductor-worker-toggle" onClick={onSelect}
      aria-pressed={selected}
      aria-label={`查看子代理 ${numberLabel}：${workerTitle(sub)}`}>
      <span className="conductor-worker-index" aria-hidden="true">{numberLabel}</span>
      <h3 className={clsx('conductor-worker-title', phaseTone(view.phase))} title={workerTitle(sub)}>
        <StatusIcon size={14}
          className={view.phase === 'running' || view.phase === 'reworking' ? 'animate-spin' : ''}
          aria-label={view.label} />
        <span className="conductor-worker-title-text">{briefWorkerTitle(sub)}</span>
      </h3>
      {metaNote && <span className="conductor-worker-meta">{metaNote}</span>}
      <span className="conductor-worker-status"><span className={phaseDot(view.phase)} />{archived ? '存档' : view.label}</span>
    </button>
    {milestones.length > 0 && (
      <span className="conductor-worker-progress" aria-hidden="true"><span style={{ width: `${progress}%` }} /></span>
    )}
  </article>
})
