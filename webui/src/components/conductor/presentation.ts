// presentation.ts — shared Conductor presentation helpers.
//
// Pure decisions only: task-text compaction, stage/copy mapping, tone
// classes, and the review-facts view of an engine subagent snapshot. No
// React and no fetching, so the page and every component under
// components/conductor/ agree on exactly one source of truth.

import clsx from 'clsx'
import type { ConductorSubagent, ConductorWorkflow } from '@/api/types'

export function compactTaskText(text: string): string {
  const compact = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*(?:#{1,6}|[-*])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!compact) return '未提供任务说明'
  return compact.length > 180 ? `${compact.slice(0, 180)}…` : compact
}

/** Engine verification payload from a 409 completion_unverified accept. */
export type SubagentEvidence = {
  error?: string
  checks_ok?: boolean
  deliverables_missing?: string[]
  deliverables_stale?: string[]
  quality_checks?: {
    checks?: Array<{
      kind?: string
      path?: string
      passed?: boolean
      status?: string
      severity?: string
      detail?: string
    }>
    checks_ok?: boolean
  }
  verification?: { verified?: boolean }
  [key: string]: unknown
}

/** Snapshot fields the engine already sends; OpenAPI extra:allow. */
export type SubagentManifest = {
  goal?: string
  done_when?: string
  deliverables?: Array<{ path?: string; desc?: string }>
}

export type SubagentReviewFacts = ConductorSubagent & {
  deliverables_missing?: string[]
  deliverables_stale?: string[]
  done_marker?: boolean
  quality_checks?: SubagentEvidence['quality_checks']
  manifest?: SubagentManifest
  verification?: { verified?: boolean; done_marker?: boolean }
}

export function reviewFacts(sub: ConductorSubagent): SubagentReviewFacts {
  return sub as SubagentReviewFacts
}

/** Engine-verified deliverable checks; plan-milestone checks are excluded. */
function deliverableChecks(facts: SubagentReviewFacts) {
  return (facts.quality_checks?.checks ?? []).filter((check) => {
    const kind = check.kind ?? ''
    return kind === 'path_exists' || kind === 'file_exists'
      || kind === 'file_contains' || kind === 'file_modified_after'
  })
}

/**
 * The deliverable list for one worker. The engine snapshot carries a manifest,
 * but journal-backfilled archive rows do not — their prompt still contains the
 * contract sections the hub rendered ([Deliverables] "- path -- desc"), and the
 * machine checks list every delivered path. Reading only the manifest showed a
 * verified task as "0 交付", so rebuild the list from those two sources.
 */
export function deliverablesOf(facts: SubagentReviewFacts): Array<{ path?: string; desc?: string }> {
  const manifest = facts.manifest?.deliverables
  if (manifest && manifest.length > 0) return manifest
  const fromPrompt = parseContractDeliverables(facts.prompt ?? '')
  if (fromPrompt.length > 0) return fromPrompt
  const seen = new Set<string>()
  const paths: Array<{ path: string }> = []
  for (const check of deliverableChecks(facts)) {
    const path = check.path
    if (path && !seen.has(path)) {
      seen.add(path)
      paths.push({ path })
    }
  }
  for (const path of [...(facts.deliverables_missing ?? []), ...(facts.deliverables_stale ?? [])]) {
    if (!seen.has(path)) {
      seen.add(path)
      paths.push({ path })
    }
  }
  return paths
}

/** Extract "[Deliverables]" entries: "- <path>" with optional " -- desc". */
export function parseContractDeliverables(prompt: string): Array<{ path?: string; desc?: string }> {
  const match = /\[Deliverables\][^\n]*\n([\s\S]*?)(?=\n\[|$)/.exec(prompt)
  if (!match) return []
  const items: Array<{ path?: string; desc?: string }> = []
  for (const line of match[1].split('\n')) {
    const entry = /^-\s*(.+)$/.exec(line.trim())?.[1]
    if (!entry) {
      // The section ends at the first non-item line (the root-policy note).
      if (line.trim() && items.length > 0) break
      continue
    }
    const [rawPath, ...rest] = entry.split(' -- ')
    const path = rawPath.trim()
    // Guard against the note line sneaking in: only accept path-looking text.
    if (!path || /[（()）\s]allowed|must resolve/i.test(path)) continue
    items.push({ path, ...(rest.length > 0 ? { desc: rest.join(' -- ').trim() } : {}) })
  }
  return items
}

/**
 * Verification badge for one deliverable path: machine checks carry the
 * truth when a manifest is absent, so a passed check on this path renders ✓
 * even on archive rows.
 */
export function deliverableVerified(facts: SubagentReviewFacts, path: string): boolean | undefined {
  const relevant = deliverableChecks(facts).filter((check) => check.path === path)
  if (relevant.length === 0) return undefined
  return relevant.every((check) => check.passed === true || check.status === 'passed')
}

export function basenamePath(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}

export function isReviewable(sub: ConductorSubagent): boolean {
  // Archived rows are read-only history: the engine can no longer act on
  // them, so they must never count as awaiting review (attention badges,
  // review-queue jumps and shortcuts all derive from this single gate).
  return !sub.archived && sub.status === 'stopped'
    && !['accepted', 'rejected'].includes(sub.review_status)
}

export function workerTitle(sub: ConductorSubagent): string {
  const facts = reviewFacts(sub)
  return compactTaskText(facts.manifest?.goal || sub.prompt)
}

/** Rail-safe title for one-line CTAs; the dossier shows the full text. */
export function shortWorkerTitle(sub: ConductorSubagent): string {
  const title = workerTitle(sub)
  return title.length > 28 ? `${title.slice(0, 28)}…` : title
}

/** Actions the review row can offer; the page supplies the implementations. */
export type SubagentRowControl = {
  evidence?: SubagentEvidence
  busy: boolean
  reworkOpen: boolean
  reworkReason: string
  onAccept: () => void
  onForceAccept: () => void
  onAbort: () => void
  onReworkOpen: () => void
  onReworkReasonChange: (value: string) => void
  onReworkCancel: () => void
  onReworkSubmit: () => void
  onEvidenceDismiss: () => void
}

export type SubagentPhase = 'running' | 'reworking' | 'reviewing' | 'accepted' | 'stopped'

// The hub decides each worker's stage (conductor_vocabulary.subagent_stage);
// the page only maps stage -> label/tone copy.
export const WORKER_STAGE_VIEW: Record<string, { phase: SubagentPhase; label: string; detail: string }> = {
  running: { phase: 'running', label: '执行中', detail: '子代理正在处理这项任务' },
  reworking: { phase: 'reworking', label: '返工中', detail: '正在按验收意见重新处理' },
  reviewing: { phase: 'reviewing', label: '待你验收', detail: '执行完成，等待验收' },
  accepted: { phase: 'accepted', label: '已通过', detail: '结果已通过验收' },
  stopped: { phase: 'stopped', label: '已停止', detail: '这项任务当前没有继续执行' },
}

export function subagentPhase(sub: ConductorSubagent): {
  phase: SubagentPhase
  label: string
  detail: string
} {
  return WORKER_STAGE_VIEW[sub.stage ?? 'stopped'] ?? WORKER_STAGE_VIEW.stopped
}

export type WorkflowTone = 'active' | 'review' | 'done' | 'error' | 'idle'

// Terminal stages: nothing further will happen on this workflow. Keep the
// cancelled/killed states here as a compatibility guard for older snapshots
// whose `stage` was not normalized to `failed` yet.
export const WORKFLOW_STAGE_CLOSED = new Set(['completed', 'failed', 'cancelled', 'killed'])
export const WORKFLOW_STATUS_CLOSED = new Set(['cancelled', 'killed'])

export function isWorkflowClosed(workflow: ConductorWorkflow | undefined): boolean {
  if (!workflow) return false
  return Boolean(workflow.terminal_event)
    || WORKFLOW_STAGE_CLOSED.has(workflow.stage ?? '')
    || WORKFLOW_STATUS_CLOSED.has(workflow.status)
}
// Stages that stall while the conductor itself is stopped.
export const WORKFLOW_STAGE_PAUSABLE = new Set([
  'planning', 'supervising', 'reworking', 'awaiting_review', 'aggregating',
])

export const WORKFLOW_STAGE_VIEW: Record<string, { label: string; detail: string; tone: WorkflowTone }> = {
  planning: { label: '正在规划', detail: 'Conductor 正在理解需求并准备分派。', tone: 'active' },
  supervising: { label: '执行中', detail: 'Conductor 已完成分派，子代理正在处理。', tone: 'active' },
  reworking: { label: '返工中', detail: '未通过的部分已交回子代理继续处理。', tone: 'active' },
  awaiting_review: { label: '待你验收', detail: '子任务已完成，等待验收。', tone: 'review' },
  aggregating: { label: '正在汇总', detail: '子任务均已通过，Conductor 正在整理最终交付。', tone: 'review' },
  recoverable_failure: { label: '子代理失败', detail: '子代理处理失败，Conductor 正在决定返工或补派。', tone: 'active' },
  completed: { label: '已完成', detail: '所有子任务已通过验收，交付结果已发送。', tone: 'done' },
  failed: { label: '执行失败', detail: '工作流未能完成，原因已写入本轮对话。', tone: 'error' },
  cancelled: { label: '已中断', detail: '任务已被中断，不会继续执行。', tone: 'idle' },
  killed: { label: '已终止', detail: '任务进程已终止，不会继续执行。', tone: 'idle' },
}

export function workflowPresentation(
  workflow: ConductorWorkflow | undefined,
  started = true,
): { label: string; detail: string; tone: WorkflowTone } {
  if (!workflow) {
    return { label: '等待任务', detail: '发送任务后，这里会显示分派和执行进度。', tone: 'idle' }
  }
  if (workflow.status === 'cancelled' || workflow.status === 'killed') {
    return WORKFLOW_STAGE_VIEW[workflow.status]
  }
  const view = WORKFLOW_STAGE_VIEW[workflow.stage ?? 'planning'] ?? WORKFLOW_STAGE_VIEW.planning
  if (!started && WORKFLOW_STAGE_PAUSABLE.has(workflow.stage ?? '')) {
    return { label: '已暂停', detail: 'Conductor 已停止；点“恢复此任务”可单独续跑这一个任务，顶部“启动”仅拉起监督者，都不会自动重跑其他任务。', tone: 'idle' }
  }
  // Surface the tracker-persisted reason directly: a page opened after the
  // failure never saw the live transition, so the reason must come from the
  // workflow snapshot itself.
  if (view === WORKFLOW_STAGE_VIEW.failed && workflow.error) {
    return { ...view, detail: `失败原因：${workflow.error}` }
  }
  return view
}

export function isNearScrollBottom(el: HTMLDivElement | null): boolean {
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 96
}

export function phaseTone(phase: SubagentPhase): string {
  return clsx(
    phase === 'running' && 'text-status-warning',
    phase === 'reworking' && 'text-status-warning-strong',
    phase === 'reviewing' && 'text-status-info',
    phase === 'accepted' && 'text-status-success',
    phase === 'stopped' && 'text-ink-muted',
  )
}

export function phaseDot(phase: SubagentPhase): string {
  return clsx(
    'h-1.5 w-1.5 shrink-0 rounded-full',
    phase === 'running' && 'bg-status-warning-strong',
    phase === 'reworking' && 'bg-status-warning-hot',
    phase === 'reviewing' && 'bg-status-info',
    phase === 'accepted' && 'bg-status-success-strong',
    // stopped: one-off neutral, sanctioned by the palette comment
    phase === 'stopped' && 'bg-[#9A8E7D]',
  )
}

export type WorkerMilestoneCheck = {
  kind?: string
  path?: string
  contains?: string
  after_epoch?: number
}

export type WorkerMilestone = {
  id: string
  desc: string
  status?: string
  check?: WorkerMilestoneCheck | null
  reached_at?: number | null
  missed_at?: number | null
  budget_seconds?: number
}

export function milestonesOf(sub: ConductorSubagent): WorkerMilestone[] {
  return ((sub as { plan_milestones?: WorkerMilestone[] | null }).plan_milestones) ?? []
}

/** One-line human hint for a milestone's mechanical check. */
export function milestoneCheckSummary(check?: WorkerMilestoneCheck | null): string {
  const kind = check?.kind ?? ''
  if (kind === 'archive_contains') return '输出标记检查'
  const base = check?.path ? basenamePath(check.path) : ''
  if (kind === 'file_exists') return base ? `文件存在 · ${base}` : '文件存在检查'
  if (kind === 'file_contains') return base ? `内容检查 · ${base}` : '内容检查'
  if (kind === 'file_modified_after') return base ? `更新检查 · ${base}` : '更新检查'
  return '机械检查'
}

/**
 * The engine's completion contract appends a marker pair to the final reply
 * (conductor_core._DONE_TAIL_RE): the canonical `[[GAHUB_TASK_DONE]]
 * <summary>…</summary>` since 2026-09-08, or the legacy `[DONE]
 * <summary>…</summary>`. That is protocol noise for a human reader — strip
 * it before rendering.
 */
export function stripContractTail(reply: string): string {
  return reply
    .replace(/(?:\[\[GAHUB_TASK_DONE\]\]|\[DONE\])\s*<summary>[\s\S]*?<\/summary>\s*$/i, '')
    .trimEnd()
}

export type ReplySegment =
  | { kind: 'text'; text: string }
  | { kind: 'milestone'; milestone: WorkerMilestone }

/**
 * Split a worker reply at reached archive_contains milestones: the marker
 * line the worker emitted is lifted out of the prose and rendered as an
 * inline anchor chip, so a reader can see WHERE each milestone completed.
 * Cuts happen at line boundaries to keep surrounding markdown intact, and
 * each milestone anchors at most once (its first marker occurrence).
 */
export function splitReplyByMilestones(reply: string, milestones: WorkerMilestone[]): ReplySegment[] {
  if (!reply) return []
  const anchored = milestones.filter((ms) => (
    ms.check?.kind === 'archive_contains'
    && Boolean(ms.check.contains)
    && Boolean(ms.reached_at)
  ))
  if (anchored.length === 0) return [{ kind: 'text', text: reply }]

  type Cut = { start: number; end: number; milestone: WorkerMilestone }
  const cuts: Cut[] = []
  for (const ms of anchored) {
    const marker = ms.check!.contains as string
    const first = reply.indexOf(marker)
    if (first === -1) continue
    const lineStart = reply.lastIndexOf('\n', first)
    const start = lineStart === -1 ? 0 : lineStart + 1
    const lineEnd = reply.indexOf('\n', first + marker.length)
    const end = lineEnd === -1 ? reply.length : lineEnd + 1
    cuts.push({ start, end, milestone: ms })
  }
  if (cuts.length === 0) return [{ kind: 'text', text: reply }]
  cuts.sort((left, right) => left.start - right.start)

  const segments: ReplySegment[] = []
  let cursor = 0
  for (const cut of cuts) {
    if (cut.start < cursor) continue // overlapping marker line (dedupe)
    const before = reply.slice(cursor, cut.start)
    if (before.trim()) segments.push({ kind: 'text', text: before })
    segments.push({ kind: 'milestone', milestone: cut.milestone })
    cursor = cut.end
  }
  const tail = reply.slice(cursor)
  if (tail.trim()) segments.push({ kind: 'text', text: tail })
  return segments
}
