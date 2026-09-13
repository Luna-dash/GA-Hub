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

/** Stable per-workflow worker numbers (#1, #2, …): dispatch order, ties
 *  broken by id so parallel spawns never swap positions between polls. */
export function workerNumbers(subs: ConductorSubagent[]): Map<string, number> {
  const ordered = [...subs].sort((left, right) =>
    left.created_at - right.created_at || left.id.localeCompare(right.id))
  return new Map(ordered.map((sub, index) => [sub.id, index + 1]))
}

/** User-typed text often carries blank lines from pasted formatting. In the
 *  dense work-log rendering every blank line is pure vertical cost, so they
 *  are dropped entirely — the line structure survives, the gaps don't. */
export function collapseBlankLines(text: string): string {
  return text.split('\n').filter((line) => line.trim().length > 0).join('\n')
}

// The engine embeds turn markers and tool chatter inside a worker's reply
// (frontends/gahub/conductor_core.py `_TURN_SPLIT_RE` / `clean_log_text`).
// The chat-grade process view splits on the markers and strips the noise.
const WORKER_TURN_RE = /\**LLM Running \(Turn (\d+)\) \.\.\.\**/g

/** Strip engine noise from worker output: raw 5-backtick dumps, tool-call
 *  arg blocks, <thinking> blocks, [Status]/[Info] lines, stray
 *  angle-bracket tags (e.g. leftover </summary>) that would render as
 *  nothing or leak as literal markup.
 *
 *  Milestone marker lines (MILESTONE-m1-DONE, …) are engine protocol — the
 *  archive_contains scanner consumes them and the 进度里程碑 section shows
 *  the resulting state — so the bare marker lines never render as content. */
export function sanitizeWorkerOutput(text: string): string {
  if (!text) return ''
  let s = text
  s = s.replace(/`{5}\n[\s\S]*?`{5}\n?/g, '')
  s = s.replace(/🛠️ Tool: `([^`\n]+)`\s*📥 args:\n`{4}[\s\S]*?`{4}\n?/g, '🛠️ `$1`\n')
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>\s*/gi, '')
  s = s.replace(/^[ \t]*\[(?:Info|Status)\][^\n]*\n?/gm, '')
  s = s.replace(/^[ \t]*MILESTONE-[A-Za-z0-9._-]+-DONE[ \t.!。]*$/gm, '')
  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^<>\n]*)?>/g, '')
  return s
}

/** One entry per LLM turn, in order: the engine's "LLM Running (Turn N)"
 *  markers become turn numbers; text before the first marker keeps index 0
 *  and renders as a "前置说明" segment when turns exist. */
export function splitWorkerTurns(reply: string): Array<{ index: number; text: string }> {
  const text = sanitizeWorkerOutput(reply).trim()
  if (!text) return []
  const marks: Array<{ start: number; end: number; n: number }> = []
  const marker = new RegExp(WORKER_TURN_RE.source, 'g')
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    marks.push({ start: match.index, end: match.index + match[0].length, n: Number(match[1]) })
  }
  if (marks.length === 0) return [{ index: 1, text }]
  const turns: Array<{ index: number; text: string }> = []
  const pre = text.slice(0, marks[0].start).trim()
  if (pre) turns.push({ index: 0, text: pre })
  marks.forEach((mark, i) => {
    const stop = i + 1 < marks.length ? marks[i + 1].start : text.length
    const body = text.slice(mark.end, stop).trim()
    if (body) turns.push({ index: mark.n || i + 1, text: body })
  })
  return turns
}

/** Card title: derive a name-sized summary of what this worker is for.
 *  Priority: manifest goal → the dispatch prompt's [Task Goal] section → the
 *  first line that reads like content (contract tags, markdown scaffolding
 *  and list markers are noise, not a name) → hard cap. The full dispatch
 *  text stays in the dossier and the hover tooltip. */
export function briefWorkerTitle(sub: ConductorSubagent): string {
  const facts = reviewFacts(sub)
  const goal = typeof facts.manifest?.goal === 'string' ? facts.manifest.goal.trim() : ''
  const prompt = String(sub.prompt || '')
  const source = goal || parseContractGoal(prompt) || firstContentLine(prompt)
  return capTitle(source || prompt)
}

/** Extract the dispatch template's "[Task Goal]" section content. */
function parseContractGoal(prompt: string): string {
  const match = /\[Task Goal\][^\n]*\n([\s\S]*?)(?=\n\[|$)/i.exec(prompt)
  if (!match) return ''
  return match[1].replace(/\s+/g, ' ').trim()
}

/** First prompt line that reads like content rather than scaffolding. */
function firstContentLine(prompt: string): string {
  for (const raw of prompt.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // Contract tags "[Deliverables] …", markdown headers/lists, 【里程碑】
    // style markers and numbered items are all structure, none is a name.
    if (/^(#{1,6}\s|[-*•]\s|\[[^\]]*\]|【[^】]*】|\d+[.、)])/.test(line)) continue
    if (line.length < 4) continue
    return line
  }
  return ''
}

function capTitle(source: string): string {
  const clean = source.replace(/\s+/g, ' ').trim()
  if (!clean) return '未提供任务说明'
  if (clean.length <= 24) return clean
  const clause = (clean.split(/[，。；：！？、,]/, 1)[0] ?? '').trim()
  if (clause.length >= 4 && clause.length <= 24) return clause
  return `${clean.slice(0, 24)}…`
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

// `detail` is the inline text next to the live numbers on the single status
// line under the task title. The 2026-09 audit ruled it earns its space only
// when it says something the badge and the numbers cannot: a failure REASON
// (nowhere else visible at a glance) or a reading correction for an alarming
// badge (子代理失败 is not terminal). Sentences that restate the badge or the
// 已通过 numbers were dropped — the board keeps process numbers and
// post-completion review facts, nothing else.
export const WORKFLOW_STAGE_VIEW: Record<string, { label: string; detail: string; tone: WorkflowTone }> = {
  planning: { label: '正在规划', detail: '', tone: 'active' },
  supervising: { label: '执行中', detail: '', tone: 'active' },
  reworking: { label: '返工中', detail: '', tone: 'active' },
  awaiting_review: { label: '待你验收', detail: '', tone: 'review' },
  aggregating: { label: '正在汇总', detail: '', tone: 'review' },
  recoverable_failure: { label: '子代理失败', detail: 'Conductor 正在决定返工或补派。', tone: 'active' },
  completed: { label: '已完成', detail: '', tone: 'done' },
  failed: { label: '执行失败', detail: '', tone: 'error' },
  cancelled: { label: '已中断', detail: '', tone: 'idle' },
  killed: { label: '已终止', detail: '', tone: 'idle' },
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
    // The 恢复此任务 button on the title row carries the continuation
    // semantics in its tooltip; a paused task needs no prose here.
    return { label: '已暂停', detail: '', tone: 'idle' }
  }
  // Surface the tracker-persisted reason directly: a page opened after the
  // failure never saw the live transition, so the reason must come from the
  // workflow snapshot itself. It is the ONLY place the reason renders.
  if (view === WORKFLOW_STAGE_VIEW.failed && workflow.error) {
    return { ...view, detail: `失败原因：${workflow.error}` }
  }
  return view
}

export type HistoryRow = {
  requestId: string
  title: string
  view: { label: string; detail: string; tone: WorkflowTone }
  total: number
  accepted: number
  needsAttention: boolean
  deletable: boolean
  closed: boolean
  createdAt: number
}

/**
 * The history list model: one row per workflow, attention first then newest.
 * Lives here (not in the panel) because the header trigger needs the same
 * attention count the list renders — one computation, one truth.
 */
export function historyRowsOf(
  workflows: ConductorWorkflow[],
  workers: ConductorSubagent[],
  titles: Map<string, string>,
  started: boolean,
): HistoryRow[] {
  const byId = new Map(workers.map((worker) => [worker.id, worker]))
  const byRequest = new Map<string, ConductorSubagent[]>()
  for (const worker of workers) {
    if (worker.request_id) {
      const siblings = byRequest.get(worker.request_id) ?? []
      siblings.push(worker)
      byRequest.set(worker.request_id, siblings)
    }
  }
  const rows = workflows.map((workflow) => {
    const owned = [...new Set([
      ...Object.keys(workflow.subagents).map((id) => byId.get(id)),
      ...(byRequest.get(workflow.request_id) ?? []),
    ])].filter((worker): worker is ConductorSubagent => Boolean(worker))
    const view = workflowPresentation(workflow, started)
    const closed = isWorkflowClosed(workflow)
    const needsAttention = view.tone === 'error' || (!closed && (workflow.stage === 'awaiting_review'
      || workflow.stage === 'recoverable_failure' || owned.some(isReviewable)))
    // Count from the merged worker list when we have it: archived rows are
    // in `owned` but absent from the tracker's subagents map, and a history
    // row saying "尚未指派" while the board shows four cards contradicts
    // itself. The tracker map stays the fallback for workers already pruned
    // from both pool and archive.
    const total = owned.length || Object.keys(workflow.subagents).length
    const accepted = owned.length
      ? owned.filter((worker) => worker.review_status === 'accepted').length
      : Object.values(workflow.subagents).filter((worker) => worker.state === 'accepted').length
    return {
      requestId: workflow.request_id,
      title: titles.get(workflow.request_id) || '未命名任务',
      view,
      total,
      accepted,
      needsAttention,
      deletable: closed || !started,
      closed,
      createdAt: workflow.created_at,
    }
  })
  // Fixed order: whatever needs a human decision first, then newest first.
  // A one-glance list does not need a sort control.
  return rows.sort((a, b) =>
    Number(b.needsAttention) - Number(a.needsAttention) || b.createdAt - a.createdAt)
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
 * it before rendering. Completion is already surfaced as UI state
 * (done_marker → 阶段/「未确认完成」), so the token carries no information
 * a reader needs.
 *
 * Two shapes are stripped, in order:
 * 1. the full pair (marker + `<summary>` line);
 * 2. a bare trailing canonical marker — workers routinely emit the marker
 *    and drop the summary line (the engine then reports done_marker=false).
 *    Only the double-bracket form qualifies: a lone legacy `[DONE]` is
 *    ambiguous with ordinary prose AND the engine refuses to read it as a
 *    completion signal on its own, so leaving it is the safer default.
 * Anything mid-text is left alone: only the tail is contract.
 */
export function stripContractTail(reply: string): string {
  return reply
    .replace(/(?:\[\[GAHUB_TASK_DONE\]\]|\[DONE\])\s*<summary>[\s\S]*?<\/summary>\s*$/i, '')
    .replace(/\[\[GAHUB_TASK_DONE\]\]\s*$/i, '')
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
