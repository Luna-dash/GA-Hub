// WorkerDossier — the right-hand detail panel for one selected subagent.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '@/api/client'
import type { ConductorSubagent } from '@/api/types'
import { queryKeys } from '@/queries/queryKeys'
import { toast } from '@/stores/toastStore'
import { writeClipboard } from '@/utils/clipboard'
import type { SubagentRowControl } from './presentation'
import {
  basenamePath,
  isReviewable,
  phaseDot,
  phaseTone,
  reviewFacts,
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
  control,
}: {
  sub: ConductorSubagent
  control: SubagentRowControl
}) {
  const view = subagentPhase(sub)
  const facts = reviewFacts(sub)
  const running = sub.status === 'running'
  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.conductor.subagent(sub.id),
    queryFn: () => api.conductorSubagent(sub.id, 20_000),
    // Running workers stream partial results; refresh quietly so the dossier
    // reflects the latest reply without a manual refetch. Lifecycle SSE also
    // invalidates this query from the page.
    refetchInterval: running ? 5000 : false,
    refetchIntervalInBackground: false,
  })
  const detail = reviewFacts(data ?? sub)
  const deliverables = detail.manifest?.deliverables ?? facts.manifest?.deliverables ?? []
  const missing = new Set(detail.deliverables_missing ?? facts.deliverables_missing ?? [])
  const stale = new Set(detail.deliverables_stale ?? facts.deliverables_stale ?? [])
  const checks = detail.quality_checks?.checks ?? facts.quality_checks?.checks ?? []
  const reply = (detail.reply || sub.reply || '').trim()
  const reviewable = isReviewable(sub)
  const abortable = sub.status === 'running' || reviewable

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-line/70 px-4 py-3">
        <div className="mb-1 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">工人卷宗</h2>
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
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">完成条件</h3>
            <p className="mt-1 whitespace-pre-wrap text-xs leading-5">{detail.manifest.done_when}</p>
          </section>
        )}

        {detail.review_note && (
          <section className="mb-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">验收意见</h3>
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
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">约定交付物</h3>
            <ul className="mt-1 space-y-1 text-xs" aria-label="约定交付物">
              {deliverables.map((item, index) => {
                const path = item.path || `交付物 ${index + 1}`
                const gone = missing.has(path)
                const untouched = stale.has(path)
                return (
                  <li key={path} className={clsx('break-all', gone && 'text-status-danger', untouched && !gone && 'text-status-warning-strong')}>
                    {gone ? '✗ 缺失' : untouched ? '△ 未更新' : '✓'} {path}
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
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">机器检查</h3>
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
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">
            {sub.status === 'running' ? '进行中摘要' : '文字结果'}
          </h3>
          {reply ? (
            <div className="mt-1 whitespace-pre-wrap break-words text-xs leading-5">{reply}</div>
          ) : (
            <p className="mt-1 text-xs text-ink-muted">
              {sub.status === 'running'
                ? '还没有可展示的中间结果。'
                : '没有文字结果。请对照上面的交付物路径直接打开文件核对。'}
            </p>
          )}
        </section>
      </div>

      <div className="shrink-0 border-t border-line/70 px-4 py-3">
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
              className="min-h-16 w-full resize-none rounded border border-line bg-bg px-2 py-1.5 text-xs leading-5 text-ink placeholder:text-[#8A7A63] focus:border-accent focus:outline-none"
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
