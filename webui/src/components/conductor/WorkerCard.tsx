// WorkerCard — one card per subagent in the implementation-process grid.
// Collapsed: identity, phase, progress. Expanded in place: the actual
// execution process (prompt, milestone timeline, deliverable checklist and
// the live reply stream). Deep review stays in the right-hand dossier.
import { memo } from 'react'
import clsx from 'clsx'
import { CheckCircle2, CircleDashed, LoaderCircle } from 'lucide-react'
import type { ConductorSubagent } from '@/api/types'
import { MessageContent } from '@/components/MessageContent'
import { formatClock } from '@/utils/timeFormat'
import {
  basenamePath,
  deliverableVerified,
  deliverablesOf,
  milestonesOf,
  phaseDot,
  phaseTone,
  reviewFacts,
  stripContractTail,
  subagentPhase,
  workerTitle,
} from './presentation'

export const WorkerCard = memo(function WorkerCard({ sub, selected, expanded = false, onToggle }: {
  sub: ConductorSubagent; selected: boolean; expanded?: boolean
  onToggle: () => void
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  // Archived rows are persisted history (engine pool is gone). They render
  // read-only and must say so: the badge plus an honest fallback line keep
  // a finished-but-truncated record from reading like a stalled live worker.
  const archived = Boolean(sub.archived)
  const milestones = milestonesOf(sub)
  const reached = milestones.filter(item => Boolean(item.reached_at)).length
  const progress = milestones.length > 0 ? Math.round((reached / milestones.length) * 100) : view.phase === 'accepted' ? 100 : 0
  const StatusIcon = view.phase === 'running' || view.phase === 'reworking' ? LoaderCircle : view.phase === 'accepted' ? CheckCircle2 : CircleDashed
  const deliverables = deliverablesOf(facts)
  const missing = new Set(facts.deliverables_missing ?? [])
  const stale = new Set(facts.deliverables_stale ?? [])
  const reply = stripContractTail((sub.reply || '').trim())
  const summary = reply || sub.review_note
    || (archived ? '存档记录：执行文字结果未随快照保留，交付物与检查仍可查看' : '等待执行结果')
  // Collapsed-card footnote: the live numbers stay one hover away instead of
  // claiming a dedicated row on every card.
  const metaNote = `${deliverables.length} 项交付 · ${reached}/${milestones.length} 里程碑`
    + (sub.attempt > 1 ? ` · 第 ${sub.attempt} 次` : '')
  return <article className="conductor-worker-card" data-expanded={expanded || undefined} data-selected={selected || undefined} data-archived={archived || undefined}>
    <button type="button" className="conductor-worker-toggle" onClick={onToggle}
      aria-expanded={expanded} aria-pressed={selected}
      aria-label={`查看子任务：${workerTitle(sub)}`}>
      <span className="conductor-worker-card-heading">
        <h3 className={clsx('conductor-worker-title', phaseTone(view.phase))}><StatusIcon size={14}
          className={view.phase === 'running' || view.phase === 'reworking' ? 'animate-spin' : ''}
          aria-label={view.label} />{workerTitle(sub)}</h3>
        <span className="conductor-worker-status"><span className={phaseDot(view.phase)} />{archived ? '存档' : view.label}</span>
      </span>
      {!expanded && <p className="conductor-worker-summary" title={metaNote}>{summary}</p>}
      {!expanded && <span className="conductor-worker-progress" title={metaNote} aria-hidden="true"><span style={{ width: `${progress}%` }} /></span>}
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
                // Without a live manifest the engine's machine checks are the
                // only evidence on record; say "已约定" when there are none.
                const verified = deliverableVerified(facts, path)
                const state = gone ? '缺失' : untouched ? '未更新' : verified === false ? '未通过'
                  : verified === true || facts.manifest?.deliverables?.length ? '✓' : '已约定'
                return <li key={path} className={gone ? 'is-missed' : untouched ? 'is-stale' : 'is-done'}>
                  <span className="conductor-worker-process-dot" aria-hidden="true" />
                  <span className="min-w-0 flex-1 break-all">{basenamePath(path)}</span>
                  <span className="conductor-worker-process-time">{state}</span>
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
              {sub.status === 'running' ? '还没有可展示的中间结果。'
                : archived ? '存档未保留执行正文，事后无法找回；可对照上方交付物路径直接打开文件核对。'
                  : '没有文字结果；可对照上方交付物路径直接打开文件核对。'}
            </p>
          )}
        </section>
        {sub.review_note && (
          <div className="conductor-worker-process-actions">
            <p className="conductor-worker-review-note">上一轮验收意见：{sub.review_note}</p>
          </div>
        )}
      </div>
    )}
  </article>
})
