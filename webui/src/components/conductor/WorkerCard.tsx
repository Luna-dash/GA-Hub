// WorkerCard — one card per subagent in the implementation-process grid.
// Collapsed: identity, phase, progress. Expanded in place: the actual
// execution process (prompt, milestone timeline, deliverable checklist and
// the live reply stream). Deep review stays in the right-hand dossier.
import { memo } from 'react'
import { CheckCircle2, CircleDashed, FileCheck2, ListChecks, LoaderCircle } from 'lucide-react'
import type { ConductorSubagent } from '@/api/types'
import { MessageContent } from '@/components/MessageContent'
import { formatClock } from '@/utils/timeFormat'
import {
  basenamePath,
  milestonesOf,
  phaseDot,
  reviewFacts,
  stripContractTail,
  subagentPhase,
  workerTitle,
} from './presentation'

export const WorkerCard = memo(function WorkerCard({ sub, index, selected, expanded = false, onToggle, onOpenDossier }: {
  sub: ConductorSubagent; index?: number; selected: boolean; expanded?: boolean
  onToggle: () => void; onOpenDossier: () => void
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const milestones = milestonesOf(sub)
  const reached = milestones.filter(item => Boolean(item.reached_at)).length
  const progress = milestones.length > 0 ? Math.round((reached / milestones.length) * 100) : view.phase === 'accepted' ? 100 : 0
  const StatusIcon = view.phase === 'running' || view.phase === 'reworking' ? LoaderCircle : view.phase === 'accepted' ? CheckCircle2 : CircleDashed
  const deliverables = facts.manifest?.deliverables ?? []
  const missing = new Set(facts.deliverables_missing ?? [])
  const stale = new Set(facts.deliverables_stale ?? [])
  const reply = (sub.reply || '').trim()
  return <article className="conductor-worker-card" data-expanded={expanded || undefined} data-selected={selected || undefined}>
    <button type="button" className="conductor-worker-toggle" onClick={onToggle}
      aria-expanded={expanded} aria-pressed={selected}
      aria-label={`查看子任务：${workerTitle(sub)}`}>
      <span className="conductor-worker-card-heading">
        <span className="conductor-worker-index">{index ? `子代理 ${index}` : '子代理'}</span>
        <span className="conductor-worker-status"><StatusIcon size={14} className={view.phase === 'running' || view.phase === 'reworking' ? 'animate-spin' : ''} /><span className={phaseDot(view.phase)} />{view.label}</span>
      </span>
      <h3 className="conductor-worker-title">{workerTitle(sub)}</h3>
      {!expanded && <p className="conductor-worker-summary">{sub.reply || sub.review_note || '等待执行结果'}</p>}
      <span className="conductor-worker-progress" aria-label={`${workerTitle(sub)}里程碑进度`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></span>
      <span className="conductor-worker-meta"><span><FileCheck2 size={13} />{facts.manifest?.deliverables?.length ?? 0} 项交付</span>
        <span><ListChecks size={13} />{reached}/{milestones.length} 里程碑</span>
        {sub.attempt > 1 && <span>第 {sub.attempt} 次</span>}</span>
    </button>
    {expanded && (
      <div className="conductor-worker-process" aria-label={`${workerTitle(sub)} 执行过程`}>
        {milestones.length > 0 && (
          <section className="conductor-worker-process-block">
            <h4>里程碑</h4>
            <ul>
              {milestones.map((ms) => {
                const done = Boolean(ms.reached_at)
                const missed = !done && Boolean(ms.missed_at)
                return <li key={ms.id} className={done ? 'is-done' : missed ? 'is-missed' : 'is-pending'}>
                  <span className="conductor-worker-process-dot" aria-hidden="true" />
                  <span className="min-w-0 flex-1">{ms.desc}</span>
                  <span className="conductor-worker-process-time">
                    {done ? `✓ ${formatClock(ms.reached_at!)}` : missed ? '已超时' : '进行中'}
                  </span>
                </li>
              })}
            </ul>
          </section>
        )}
        {deliverables.length > 0 && (
          <section className="conductor-worker-process-block">
            <h4>交付物</h4>
            <ul>
              {deliverables.map((item, index2) => {
                const path = item.path || `交付物 ${index2 + 1}`
                const gone = missing.has(path)
                const untouched = stale.has(path)
                return <li key={path} className={gone ? 'is-missed' : untouched ? 'is-stale' : 'is-done'}>
                  <span className="conductor-worker-process-dot" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-all">{basenamePath(path)}</span>
                  <span className="conductor-worker-process-time">{gone ? '缺失' : untouched ? '未更新' : '✓'}</span>
                </li>
              })}
            </ul>
          </section>
        )}
        <section className="conductor-worker-process-block">
          <h4>{sub.status === 'running' ? '进行中摘要' : '文字结果'}</h4>
          {reply ? (
            <div className="conductor-worker-reply">
              <MessageContent content={reply} format="markdown" markdownMode="plain" />
            </div>
          ) : (
            <p className="conductor-worker-noresult">
              {sub.status === 'running' ? '还没有可展示的中间结果。' : '没有文字结果；完整卷宗里可核对交付物路径。'}
            </p>
          )}
        </section>
        <div className="conductor-worker-process-actions">
          {sub.review_note && <p className="conductor-worker-review-note">上一轮验收意见：{sub.review_note}</p>}
          <button type="button" className="ga-btn w-full justify-center px-2 text-xs" onClick={onOpenDossier}>
            <FileCheck2 size={13} />打开完整卷宗
          </button>
        </div>
      </div>
    )}
  </article>
})
