// WorkerDossier — the right-hand detail panel for one selected subagent.
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '@/api/client'
import type { ConductorSubagent } from '@/api/types'
import { MessageContent } from '@/components/MessageContent'
import { queryKeys } from '@/queries/queryKeys'
import { toast } from '@/stores/toastStore'
import { writeClipboard } from '@/utils/clipboard'
import { formatClock } from '@/utils/timeFormat'
import type { SubagentRowControl } from './presentation'
import {
  basenamePath,
  deliverablesOf,
  deliverableVerified,
  isReviewable,
  milestoneCheckSummary,
  milestonesOf,
  phaseDot,
  phaseTone,
  reviewFacts,
  splitReplyByMilestones,
  splitWorkerTurns,
  stripContractTail,
  subagentPhase,
  workerTitle,
} from './presentation'

async function copyPath(path: string) {
  const ok = await writeClipboard(path)
  if (ok) toast.success('已复制路径')
  else toast.error('复制失败，请手动选中路径')
}

async function revealDeliverable(path: string, mode: 'open' | 'folder') {
  try {
    const result = await api.revealFile(path, mode)
    if (!result.ok) toast.error('无法打开该路径，请确认文件是否还存在。')
  } catch {
    toast.error('无法打开该路径，请确认文件是否还存在。')
  }
}

export function WorkerDossier({
  sub,
  workerNumber,
  control,
}: {
  sub: ConductorSubagent
  workerNumber?: number
  control: SubagentRowControl
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const running = sub.status === 'running'
  // Archived workers are persisted history the engine pool no longer knows
  // about: their list row already carries the full snapshot, so fetching
  // would only round-trip a 404-and-fallback. Offer reading, never actions.
  const archived = Boolean(sub.archived)
  const { data, isLoading, error } = useQuery({
    queryKey: [...queryKeys.conductor.subagent(sub.id), sub.boot_id, sub.active_generation, sub.command_revision],
    queryFn: () => api.conductorSubagent(sub.id, 20_000),
    // Running workers stream partial results; refresh quietly so the dossier
    // reflects the latest reply without a manual refetch. Lifecycle SSE also
    // invalidates this query from the page.
    refetchInterval: running ? 5000 : false,
    refetchIntervalInBackground: false,
    enabled: !archived,
  })
  const detail = reviewFacts(data ?? sub)
  // Manifest first (live snapshots carry it); archive rows rebuild the list
  // from the prompt's contract section and the machine checks, so a verified
  // delivery never shows as "0 交付" just because the journal lacked a manifest.
  const deliverables = deliverablesOf(detail)
  const missing = new Set(detail.deliverables_missing ?? facts.deliverables_missing ?? [])
  const stale = new Set(detail.deliverables_stale ?? facts.deliverables_stale ?? [])
  const checks = detail.quality_checks?.checks ?? facts.quality_checks?.checks ?? []
  const detailMilestones = milestonesOf(detail)
  const milestones = detailMilestones.length > 0 ? detailMilestones : milestonesOf(sub)
  const reply = stripContractTail((detail.reply || sub.reply || '').trim())
  const replyTurns = splitWorkerTurns(reply)
  // Archived workers (engine pool reset) are historical records: the engine
  // can no longer apply accept/rework/abort, so only reading is offered.
  const reviewable = !archived && isReviewable(sub)
  const abortable = !archived && (sub.status === 'running' || reviewable)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line/70 px-4 py-3">
        <div className="mb-1 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-1.5">
            {workerNumber ? <span className="conductor-dossier-index" aria-hidden="true">#{workerNumber}</span> : null}
            <h2 className="text-sm font-semibold text-ink">工人卷宗</h2>
          </div>
          <span className={clsx('flex items-center gap-1.5 text-[11px] font-medium', phaseTone(view.phase))}>
            <span className={phaseDot(view.phase)} />
            {view.label}
          </span>
        </div>
        <p className="text-sm font-medium leading-5 text-ink">{workerTitle(sub)}</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">
          {view.detail}{sub.attempt > 1 ? ` · 第 ${sub.attempt} 次处理` : ''}
          {detail.done_marker === false && sub.status === 'stopped' ? ' · 未确认完成' : ''}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm leading-6 text-ink">
        {isLoading && <p className="mb-3 text-xs text-ink-muted">正在拉取完整回复…</p>}
        {error && <p className="mb-3 text-xs text-status-danger">完整结果暂时拉不到，先显示列表里已有的摘要。</p>}

        {detail.manifest?.done_when && (
          <section className="mb-4">
            <h3 className="conductor-dossier-h">完成条件</h3>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5">{detail.manifest.done_when}</p>
          </section>
        )}

        {detail.review_note && (
          <section className="mb-4">
            <h3 className="conductor-dossier-h">验收意见</h3>
            <p
              className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-line bg-bg-soft px-2.5 py-2 text-xs leading-5"
              data-testid="dossier-review-note"
            >
              {detail.review_note}
            </p>
          </section>
        )}

        {deliverables.length > 0 && (
          <section className="mb-4">
            <h3 className="conductor-dossier-h">约定交付物</h3>
            <ul className="mt-1 space-y-1 text-xs" aria-label="约定交付物">
              {deliverables.map((item, index) => {
                const path = item.path || `交付物 ${index + 1}`
                const gone = missing.has(path)
                const untouched = stale.has(path)
                const verified = deliverableVerified(detail, path)
                const mark = gone ? '✗ 缺失' : untouched ? '△ 未更新'
                  : verified === false ? '✗ 未通过'
                    : verified === true || detail.manifest?.deliverables?.length ? '✓' : '·'
                return (
                  <li key={path} className={clsx('break-all', gone && 'text-status-danger', untouched && !gone && 'text-status-warning-strong')}>
                    {mark} {path}
                    {item.desc ? ` · ${item.desc}` : ''}
                    {item.path && (
                      <span className="ml-2 inline-flex gap-2 align-baseline text-[11px] text-status-info">
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() => void revealDeliverable(item.path!, 'open')}
                        >
                          打开
                        </button>
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() => void revealDeliverable(item.path!, 'folder')}
                        >
                          所在位置
                        </button>
                        <button
                          type="button"
                          className="underline-offset-2 hover:underline"
                          onClick={() => void copyPath(item.path!)}
                        >
                          复制路径
                        </button>
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {checks.length > 0 && (
          <section className="mb-4">
            <h3 className="conductor-dossier-h">机器检查</h3>
            <ul className="mt-1 space-y-1 text-xs" aria-label="机器检查">
              {checks.map((check, index) => (
                <li key={`${check.kind}-${index}`} className={check.passed === false ? 'text-status-danger' : ''}>
                  {check.passed === false ? '✗' : '✓'} {check.kind}
                  {check.path ? ` · ${basenamePath(check.path)}` : ''}
                  {check.detail ? ` — ${check.detail}` : ''}
                  {check.severity === 'advisory' ? '（提示项）' : ''}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="conductor-dossier-h">进度里程碑</h3>
          {milestones.length > 0 ? (
            <ul className="mt-1 space-y-1.5 text-xs" aria-label="进度里程碑">
              {milestones.map((ms) => {
                const reached = Boolean(ms.reached_at)
                const missed = !reached && Boolean(ms.missed_at)
                return (
                  <li key={ms.id} className="flex items-start gap-2 leading-5">
                    <span
                      className={clsx(
                        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                        reached ? 'bg-status-success-strong' : missed ? 'bg-status-danger' : 'bg-status-warning',
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className={clsx('break-words', reached ? 'text-ink' : missed ? 'text-status-danger' : 'text-ink-muted')}>
                        {ms.desc}
                      </span>
                      <span className="ml-1.5 whitespace-nowrap text-[10px] text-ink-faint">
                        {reached && ms.reached_at
                          ? `已达成 ${formatClock(ms.reached_at)}`
                          : missed
                            ? '已超时，等待指挥处理'
                            : '进行中'}
                      </span>
                      <span className="block text-[10px] leading-4 text-ink-faint">
                        {milestoneCheckSummary(ms.check)}
                      </span>
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : isLoading ? null : (
            <p className="mt-1 text-xs text-ink-muted" aria-label="进度里程碑">
              该子任务未设置里程碑；执行推进见右侧「对话」标签。
            </p>
          )}
        </section>

        <section>
          <h3 className="conductor-dossier-h">
            {sub.status === 'running' ? '进行中摘要' : '文字结果'}
          </h3>
          {reply ? (
            <div className="conductor-dossier-reply mt-1 space-y-3">
              {replyTurns.map((turn, turnIndex) => (
                <div key={`turn-${turnIndex}`} className="space-y-2">
                  {replyTurns.length > 1 && (
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                      {turn.index > 0 ? `第 ${turn.index} 轮` : '前置说明'}
                    </p>
                  )}
                  {/* Reached-milestone marker lines are lifted out of the
                      prose without rendering chips: the 进度里程碑 section
                      above already carries that state — chips here read as
                      the same fact twice. */}
                  {splitReplyByMilestones(turn.text, milestones).map((segment, index) => (
                    segment.kind === 'text' ? (
                      <MessageContent
                        key={`text-${turnIndex}-${index}`}
                        content={segment.text}
                        format="markdown"
                        markdownMode="plain"
                      />
                    ) : null
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">
              {sub.status === 'running'
                ? '还没有可展示的中间结果。'
                : archived
                  ? '存档未保留执行正文（引擎日志只记录长度，事后无法找回）；结论性内容见右侧「对话」标签，交付物路径可直接打开核对。'
                  : '没有文字结果。请对照上面的交付物路径直接打开文件核对。'}
            </p>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-line/70 px-4 py-3">
        {archived && (
          <p className="mb-2 text-xs text-ink-muted">
            存档记录：引擎中已无此工作进程，仅可查看，不能执行验收操作。
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {reviewable && !control.reworkOpen && (
            <>
              <button
                type="button"
                className="ga-btn ga-btn-primary px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onAccept}
              >
                通过
              </button>
              <button
                type="button"
                className="ga-btn px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onReworkOpen}
              >
                打回返工
              </button>
            </>
          )}
          {abortable && (
            <button
              type="button"
              className="ga-btn px-3 py-1 text-xs text-status-danger"
              disabled={control.busy}
              onClick={control.onAbort}
            >
              终止
            </button>
          )}
          {control.busy && <span className="text-xs text-ink-muted">处理中…</span>}
        </div>
        {control.reworkOpen && (
          <div className="mt-2 rounded-lg border border-line bg-bg-soft px-3 py-2">
            <textarea
              aria-label="打回原因"
              value={control.reworkReason}
              placeholder="说明打回原因与整改要求（必填）"
              className="min-h-16 w-full resize-none rounded border border-line bg-bg px-2 py-1.5 text-xs leading-5 text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
              onChange={(event) => control.onReworkReasonChange(event.target.value)}
            />
            <div className="mt-1.5 flex justify-end gap-2">
              <button type="button" className="ga-btn px-3 py-1 text-xs" onClick={control.onReworkCancel}>取消</button>
              <button
                type="button"
                className="ga-btn ga-btn-primary px-3 py-1 text-xs"
                disabled={!control.reworkReason.trim() || control.busy}
                onClick={control.onReworkSubmit}
              >
                确认打回
              </button>
            </div>
          </div>
        )}
        {control.evidence && (
          <div
            role="alert"
            data-testid={`subagent-evidence-${sub.id}`}
            className="mt-2 rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-xs leading-5 text-status-danger-muted"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-status-danger">机器验收未通过 · 证据</span>
              <button
                type="button"
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-bg-soft"
                onClick={control.onEvidenceDismiss}
              >
                收起
              </button>
            </div>
            <ul className="mt-1 space-y-0.5">
              {(control.evidence.deliverables_missing ?? []).map((path) => (
                <li key={`missing-${path}`}>✗ 交付物缺失：{path}</li>
              ))}
              {(control.evidence.deliverables_stale ?? []).map((path) => (
                <li key={`stale-${path}`}>✗ 交付物未更新：{path}</li>
              ))}
              {(control.evidence.quality_checks?.checks ?? [])
                .filter((check) => check.passed === false)
                .map((check, checkIndex) => (
                  <li key={`check-${checkIndex}`}>
                    ✗ {check.kind}{check.path ? ` · ${check.path}` : ''}
                    {check.detail ? ` — ${check.detail}` : ''}
                    {check.severity === 'advisory' ? '（提示项，不阻塞）' : ''}
                  </li>
                ))}
            </ul>
            <div className="mt-1.5 flex flex-wrap gap-2">
              <button
                type="button"
                className="ga-btn px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onForceAccept}
              >
                强制通过（人工核对后）
              </button>
              <button
                type="button"
                className="ga-btn px-3 py-1 text-xs"
                disabled={control.busy}
                onClick={control.onReworkOpen}
              >
                打回返工
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
