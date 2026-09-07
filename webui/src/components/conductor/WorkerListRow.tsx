// WorkerListRow — one subagent row in the left "工人" list.
import clsx from 'clsx'
import type { ConductorSubagent } from '@/api/types'
import {
  milestonesOf,
  phaseDot,
  phaseTone,
  reviewFacts,
  subagentPhase,
  workerTitle,
} from './presentation'

export function WorkerListRow({
  sub,
  selected,
  onSelect,
}: {
  sub: ConductorSubagent
  selected: boolean
  onSelect: () => void
}) {
  const view = subagentPhase(sub)
  const milestones = milestonesOf(sub)
  const facts = reviewFacts(sub)
  const missing = facts.deliverables_missing?.length ?? 0
  const stale = facts.deliverables_stale?.length ?? 0
  const failed = (facts.quality_checks?.checks ?? []).filter((check) => check.passed === false).length
  const issueCount = missing + stale + failed

  return (
    <button
      type="button"
      onClick={onSelect}
      className={clsx(
        'block w-full border-b border-line/70 px-3.5 py-2.5 text-left last:border-b-0',
        selected ? 'bg-[#F4EDE3]' : 'hover:bg-bg-soft',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={clsx('flex items-center gap-1.5 text-[11px] font-medium', phaseTone(view.phase))}>
          <span className={phaseDot(view.phase)} />
          {view.label}
        </span>
        {sub.attempt > 1 && <span className="shrink-0 text-[11px] text-status-warning-strong">第 {sub.attempt} 次</span>}
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium leading-5 text-ink">{workerTitle(sub)}</p>
      {milestones.length > 0 && (
        <div className="mt-1 space-y-0.5" aria-label="里程碑进度">
          {milestones.map((ms) => (
            <div key={ms.id} className="flex items-center gap-1.5 text-[11px] leading-4">
              <span
                className={clsx(
                  'h-1 w-1 shrink-0 rounded-full',
                  ms.status === 'reached' ? 'bg-status-success-strong' : ms.status === 'missed' ? 'bg-status-danger' : 'bg-status-warning',
                )}
                aria-hidden="true"
              />
              <span
                className={clsx(
                  'min-w-0 flex-1 truncate',
                  ms.status === 'reached' ? 'text-ink-faint' : 'text-ink-muted',
                )}
              >
                {ms.desc}
              </span>
              <span className="shrink-0 text-[10px] text-ink-faint">
                {ms.status === 'reached' ? '已达成' : ms.status === 'missed' ? '超时' : '进行中'}
              </span>
            </div>
          ))}
        </div>
      )}
      {issueCount > 0 && (
        <p className="mt-0.5 text-[11px] leading-4 text-status-danger">
          {missing > 0 ? `${missing} 项缺失` : ''}
          {stale > 0 ? `${missing > 0 ? ' · ' : ''}${stale} 项未更新` : ''}
          {failed > 0 ? `${missing + stale > 0 ? ' · ' : ''}${failed} 项检查失败` : ''}
        </p>
      )}
    </button>
  )
}
