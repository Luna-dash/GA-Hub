// TaskCard — the current-task card: title row with inline actions, the one
// status line (stage detail + live numbers) and the collapsible 子代理派发
// module. Pure presentation: every handler and counter arrives via props
// from the page, which owns the data wiring and the review actions.
import { CheckCircle2, ChevronDown, LayoutGrid, RotateCcw } from 'lucide-react'
import type { ConductorSubagent, ConductorWorkflow } from '@/api/types'
import { useNowTick } from '@/hooks/useNowTick'
import { formatDurationSeconds } from '@/utils/timeFormat'
import { WorkflowBadge } from './WorkflowBadge'
import { WorkerCard } from './WorkerCard'
import { isWorkflowClosed } from './presentation'

/**
 * Live elapsed time for the open task. The clock ticks in its own component
 * so a 1s update re-renders one label — the page-level 30s tick used to make
 * "已进行 12:30" sit frozen long enough to read as stalled.
 */
function WorkflowElapsed({ startedAt }: { startedAt: number }) {
  const nowMs = useNowTick(1000)
  return <span>已进行 {formatDurationSeconds(nowMs / 1000 - startedAt)}</span>
}

export function TaskCard({
  workflow,
  started,
  view,
  title,
  workerCount,
  acceptedCount,
  activeCount,
  liveStartedAt,
  finishedDuration,
  pendingReview,
  workers,
  workerNumberById,
  selectedSid,
  collapsed,
  onToggleCollapsed,
  isResuming,
  onResume,
  onRetry,
  onSelectWorker,
}: {
  workflow?: ConductorWorkflow
  started: boolean
  view: { label: string; detail: string; tone: 'active' | 'review' | 'done' | 'error' | 'idle' }
  title: string
  workerCount: number
  acceptedCount: number
  activeCount: number
  liveStartedAt: number | null
  finishedDuration: string
  pendingReview: ConductorSubagent[]
  workers: ConductorSubagent[]
  workerNumberById: Map<string, number>
  selectedSid: string | null
  collapsed: boolean
  onToggleCollapsed: () => void
  isResuming: boolean
  onResume: () => void
  onRetry: () => void
  onSelectWorker: (sid: string) => void
}) {
  return (
    <section aria-label="当前任务" className="conductor-current">
      <div className="conductor-current-title-row">
        <WorkflowBadge tone={view.tone} label={view.label} />
        <p className="conductor-current-title" title={title || undefined}>{title || '尚未收到任务'}</p>
        {/* The single most important next actions ride on the title
            row itself, where the eye lands first — resume, pending
            reviews, retry. Absent actions leave no residue. */}
        <span className="conductor-current-actions">
          {!started && workflow && !isWorkflowClosed(workflow) && (
            <button type="button" className="ga-btn conductor-action-btn" disabled={isResuming}
              title="只恢复这一个任务：拉起监督者并重放它的原始指令，其他未闭合任务不受影响"
              onClick={onResume}>
              <RotateCcw size={14} />{isResuming ? '恢复中…' : '恢复此任务'}
            </button>
          )}
          {pendingReview.length > 0 && (
            <button type="button" className="ga-btn conductor-action-btn conductor-action-strong"
              title="打开右侧交付详情进行验收"
              onClick={() => onSelectWorker(pendingReview[0].id)}>
              <CheckCircle2 size={14} />{pendingReview.length} 个待验收
            </button>
          )}
          {view.tone === 'error' && (
            <button type="button" className="ga-btn-danger conductor-action-btn" onClick={onRetry}>
              <RotateCcw size={14} />重新发起
            </button>
          )}
        </span>
      </div>
      {/* One status line under the title: the stage detail (only
          stages with a non-obvious consequence carry text) and the
          live numbers share the row — two stacked micro-lines said
          "where things stand" twice. Inline flow wraps gracefully
          when a failure reason is long; each stat stays unbroken. */}
      {(view.detail || workflow) && (
        <p className="conductor-current-meta" aria-label="当前任务概览">
          {view.detail && <span className="conductor-current-detail">{view.detail}</span>}
          {workflow && (
            <span className="conductor-current-stats">
              <span>已通过 {acceptedCount}/{workerCount}{workerCount === 0 && '（未指派）'}</span>
              {activeCount > 0 && <span>执行中 {activeCount}</span>}
              {liveStartedAt !== null
                ? <WorkflowElapsed startedAt={liveStartedAt} />
                : finishedDuration && <span>{finishedDuration}</span>}
            </span>
          )}
        </p>
      )}
      {/* The 子代理派发 module: header line when folded, one slim row
          per worker when open. Rows are capped to a centred column —
          one-liners never need the full board width. Folding is the
          board-wide whitespace click (see the board handler on the
          page); this header button is the accessible toggle. */}
      <section className="conductor-process" aria-label="子代理派发">
        <div className="conductor-process-module">
          <h3 className="conductor-process-title">
            <button
              type="button"
              className="conductor-process-head"
              aria-expanded={!collapsed}
              aria-controls="conductor-process-grid"
              onClick={onToggleCollapsed}
            >
              <ChevronDown size={13} className="conductor-process-chevron" aria-hidden="true" />
              <span>子代理派发</span>
              <span className="conductor-process-summary">· {workerCount ? `${workerCount} 个子代理` : '暂无子代理'}</span>
            </button>
          </h3>
          {!collapsed && (
            <div id="conductor-process-grid" className="conductor-worker-grid" aria-label="子代理详情">
              {/* The row gets the page-level handler verbatim rather than a
                  per-row closure: WorkerCard is memo'd, and an inline arrow
                  allocated here would fail that comparison on every parent
                  render (every composer keystroke re-renders the page). The
                  row knows its own id, so it can pass it along itself. */}
              {workers.map((sub) => <WorkerCard key={sub.id} sub={sub} index={workerNumberById.get(sub.id)} selected={sub.id === selectedSid}
                onSelect={onSelectWorker} />)}
            </div>
          )}
          {!collapsed && workers.length === 0 && workerCount > 0 && (
            <p className="conductor-process-empty-note">子代理明细已随引擎池清空，仅保留通过数与对话记录。</p>
          )}
          {!collapsed && workers.length === 0 && workerCount === 0 && (
            <div className="conductor-empty"><LayoutGrid size={26} strokeWidth={1.4} /><p>尚未指派子代理</p></div>
          )}
        </div>
      </section>
    </section>
  )
}
