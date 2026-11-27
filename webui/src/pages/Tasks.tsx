import { QueryLoadState } from '@/components/QueryLoadState'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { TaskRun, TaskSchedule, TaskScheduleType } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { ModalOverlay } from '@/components/ModalOverlay'
import { formatRelativeTime } from '@/utils/timeFormat'
import { errorMessageFromError } from '@/utils/sessionUi'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { useHubEvent } from '@/hooks/useHubEvent'
import { useDirtyClose } from '@/hooks/useDirtyClose'
import { queryKeys } from '@/queries/queryKeys'
import { CronExpressionParser } from 'cron-parser'
import { CronCardLine, CronPreview } from '@/components/CronPreview'
import { MarkdownView } from '@/components/MarkdownView'
import { Calendar, ChevronLeft, ChevronRight, Clock, CloseIconButton, History, Pencil, Play, Plus, Power, Save, Trash2 } from '@/components/ActionIcons'

const RUNS_PER_PAGE = 10
const pageButtonClass = 'ga-btn-icon'

export default function Tasks() {
  const qc = useQueryClient()
  const schedulesQuery = useQuery({
    queryKey: queryKeys.tasks.schedules,
    queryFn: api.taskSchedules,
  })
  const schData = schedulesQuery.data
  const runsQuery = useQuery({
    queryKey: queryKeys.tasks.runs,
    queryFn: () => api.taskRuns(80),
  })
  const runData = runsQuery.data

  useHubEvent('task:', (event) => {
    if (event.topic === 'task:upsert' || event.topic === 'task:delete') {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
    }
    if (event.topic === 'task:fired' || event.topic === 'task:done' || event.topic === 'task:error') {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.runs })
    }
  })
  const [editor, setEditor] = useState<Partial<TaskSchedule> | null>(null)
  const [selectedRun, setSelectedRun] = useState<TaskRun | null>(null)
  const [runPage, setRunPage] = useState(0)

  const schedules = schData?.schedules ?? []
  const runs = runData?.runs ?? []
  const enabledCount = schedules.filter((s) => s.enabled).length
  const runningCount = runs.filter((r) => r.status === 'running').length
  const pageCount = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE))
  const page = Math.min(runPage, pageCount - 1)
  useEffect(() => {
    if (page !== runPage) setRunPage(page)
  }, [page, runPage])
  const start = page * RUNS_PER_PAGE
  const pageRuns = runs.slice(start, start + RUNS_PER_PAGE)

  const triggerNow = async (id: string): Promise<void> => {
    const ok = await dialog.confirm(
      '立即触发一次定时任务？',
      '这会让 Agent 立刻执行该任务 Prompt，可在运行历史中查看执行结果。',
      { confirmText: '触发' },
    )
    if (!ok) return
    try {
      await api.triggerTaskSchedule(id)
      toast.success('已触发定时任务')
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.runs })
    } catch (e: unknown) {
      await dialog.alert('触发失败', errorMessageFromError(e))
    }
  }

  return (
    <PageShell
      title="定时任务"
      titleExtra={
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium" aria-label="任务状态概览">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-line/65 bg-bg-soft/90 px-2.5 py-0.5 tabular-nums text-ink-muted">
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${enabledCount > 0 ? 'bg-status-success' : 'bg-ink-faint/55'}`}
            />
            <span>已启用 {enabledCount}/{schedules.length}</span>
          </span>
          <span className="inline-flex items-center gap-1 rounded-full border border-line/65 bg-bg-soft/90 px-2.5 py-0.5 tabular-nums text-ink-faint">
            <History className="h-3 w-3" aria-hidden="true" />
            <span>记录 {runs.length} 条</span>
          </span>
          {runningCount > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full border border-status-warning-line bg-status-warning-soft px-2 py-0.5 tabular-nums text-status-warning">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-warning animate-pulse" />
              <span>运行中 {runningCount}</span>
            </span>
          )}
        </div>
      }
      actions={
        <button
          type="button"
          onClick={() => setEditor({ type: 'cron', enabled: true, cron: '0 8 * * *', name: '' })}
          className="ga-btn-primary"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>新建任务</span>
        </button>
      }
    >
      <div className="ga-page-board">
        <section>
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">任务计划</h2>
            <span className="text-xs tabular-nums text-ink-faint">{schedules.length} 项任务</span>
          </div>
          {!schedulesQuery.data && (schedulesQuery.isLoading || schedulesQuery.isError) ? (
            <QueryLoadState query={schedulesQuery} label="计划" />
          ) : schedules.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {schedules.map((s) => <TaskCard key={s.id} s={s} onEdit={() => setEditor(s)} onFire={() => triggerNow(s.id)} />)}
            </div>
          ) : (
            <div className="ga-paper-card border-dashed bg-bg-card/55 p-8 text-center">
              <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line/80 bg-bg-soft text-accent">
                  <Calendar className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="text-sm font-medium text-ink">尚无定时任务</div>
                <p className="text-xs text-ink-faint">可配置按 Cron 时间点或间隔周期自动执行任务，结果将在运行历史中记录。</p>
                <button
                  type="button"
                  onClick={() => setEditor({ type: 'cron', enabled: true, cron: '0 8 * * *', name: '' })}
                  className="ga-btn-sm-primary mt-1"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>创建定时任务</span>
                </button>
              </div>
            </div>
          )}
        </section>

        <section>
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-ink">运行历史</h2>
              {runs.length > 0 && <span className="text-[11px] tabular-nums text-ink-faint">共 {runs.length} 条</span>}
            </div>
            {pageCount > 1 && (
              <nav aria-label="运行历史分页" className="flex items-center gap-1.5 text-xs text-ink-faint">
                <button type="button" aria-label="上一页" title="上一页" className={pageButtonClass}
                  disabled={page === 0} onClick={() => setRunPage(page - 1)}>
                  <ChevronLeft size={15} aria-hidden="true" />
                </button>
                <span role="status" className="min-w-28 text-center tabular-nums whitespace-nowrap text-[11px]">
                  第 {page + 1} / {pageCount} 页 · {runs.length} 条
                </span>
                <button type="button" aria-label="下一页" title="下一页" className={pageButtonClass}
                  disabled={page === pageCount - 1} onClick={() => setRunPage(page + 1)}>
                  <ChevronRight size={15} aria-hidden="true" />
                </button>
              </nav>
            )}
          </div>
          <div className="ga-paper-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-line/45 bg-bg-soft/65 text-[11px] font-medium text-ink-faint">
                  <tr>
                    <th className="px-3 py-2 text-left whitespace-nowrap">时间</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap">任务</th>
                    <th className="px-3 py-2 text-left whitespace-nowrap">状态</th>
                    <th className="px-3 py-2 text-left">结果摘要</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/35">
                  {pageRuns.map((r: TaskRun) => {
                    const preview = r.has_result ? r.result_preview : '未记录最终结论'
                    const inlinePreview = preview.replace(/^[#>*\-\s]+/gm, '').replace(/\s+/g, ' ').trim()
                    return (
                    <tr key={r.id} className="align-middle transition-colors hover:bg-bg-soft/55">
                      <td className="px-3 py-1.5 text-[11px] tabular-nums text-ink-muted whitespace-nowrap">{formatRelativeTime(r.fired_at)}</td>
                      <td className="px-3 py-1.5 font-medium text-ink whitespace-nowrap max-w-[12rem] truncate" title={r.task_name || r.task_id}>{r.task_name || r.task_id}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap"><StatusBadge status={r.status} /></td>
                      <td className="px-3 py-1.5 text-ink-muted max-w-xl">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="truncate" title={preview || undefined}>
                            {inlinePreview || preview || '—'}
                          </span>
                          {r.has_result && (
                            <button type="button" className="ga-btn-xs shrink-0" onClick={() => setSelectedRun(r)}>
                              详情
                            </button>
                          )}
                          {r.stream_id && (
                            <span className="shrink-0 rounded bg-bg-soft px-1.5 py-0.5 font-mono text-[10px] leading-none text-ink-faint">
                              {r.stream_id}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    )
                  })}
                  {runs.length === 0 && <tr><td colSpan={4} className="px-3 py-5 text-center text-xs text-ink-faint"><QueryLoadState query={runsQuery} label="运行历史">尚无运行历史</QueryLoadState></td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>

      {editor && <TaskDialog initial={editor} onClose={() => setEditor(null)} />}
      {selectedRun && <TaskResultDialog run={selectedRun} onClose={() => setSelectedRun(null)} />}
    </PageShell>
  )
}

function TaskCard({ s, onEdit, onFire }: { s: TaskSchedule; onEdit: () => void; onFire: () => Promise<void> }) {
  const qc = useQueryClient()
  const [busyAction, setBusyAction] = useState<'fire' | 'toggle' | 'delete' | null>(null)
  const busyRef = useRef(false)
  const busy = busyAction !== null
  const fire = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyAction('fire')
    try {
      await onFire()
    } finally {
      busyRef.current = false
      setBusyAction(null)
    }
  }
  const toggle = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyAction('toggle')
    try {
      await api.upsertTaskSchedule({ ...s, type: s.type as TaskScheduleType, enabled: !s.enabled })
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
    } catch (e: unknown) {
      await dialog.alert('切换失败', errorMessageFromError(e))
    } finally {
      busyRef.current = false
      setBusyAction(null)
    }
  }
  const remove = async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusyAction('delete')
    try {
      const ok = await dialog.confirm('删除该定时任务？', s.name || s.id, {
        confirmText: '删除',
        tone: 'danger',
      })
      if (!ok) return
      await api.deleteTaskSchedule(s.id)
      toast.success('已删除定时任务')
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
    } catch (e: unknown) {
      await dialog.alert('删除失败', errorMessageFromError(e))
    } finally {
      busyRef.current = false
      setBusyAction(null)
    }
  }
  const TypeIcon = s.type === 'cron' ? Calendar : Clock
  return (
    <div className={`ga-paper-card flex flex-col justify-between gap-3 p-4 ${s.enabled ? 'ring-1 ring-accent/20' : 'opacity-90'}`}>
      <div className="space-y-2.5">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1 ${
                s.enabled
                  ? 'bg-accent-soft/80 text-accent ring-accent/25'
                  : 'bg-bg-soft text-ink-faint ring-line/50'
              }`}
              title={s.type === 'cron' ? 'Cron 定时' : '周期循环'}
            >
              <TypeIcon className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold leading-snug text-ink" title={`${s.name || s.id} (${s.id})`}>
                {s.name || s.id}
              </div>
              <div className="text-[11px] leading-tight text-ink-faint">
                {s.type === 'cron' ? 'Cron 定时' : '周期循环'}
              </div>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${
              s.enabled
                ? 'border border-status-success-line bg-status-success-soft text-status-success'
                : 'bg-bg-soft text-ink-muted'
            }`}
          >
            {s.enabled ? '启用' : '禁用'}
          </span>
        </div>

        <div className="rounded-lg border border-line/45 bg-bg-soft/80 px-2.5 py-1.5 text-xs text-ink">
          {s.type === 'cron' ? <CronCardLine expr={s.cron} /> : `每 ${s.interval_minutes} 分钟`}
        </div>

        <p
          className={`min-h-[2rem] text-xs leading-relaxed line-clamp-2 break-words ${s.prompt?.trim() ? 'text-ink-muted' : 'italic text-ink-faint'}`}
          title={s.prompt || undefined}
        >
          {s.prompt?.trim() || '未设置 Prompt'}
        </p>
      </div>

      <div className="space-y-2 border-t border-line/45 pt-2.5">
        <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-ink-faint">
          <span>触发 {s.fire_count ?? 0} 次</span>
          <span>{s.last_fired_at ? `最近 ${formatRelativeTime(s.last_fired_at)}` : '尚未触发'}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <button type="button" onClick={() => { void fire() }} disabled={busy} className="ga-btn-sm-primary px-2.5">
            <Play className="h-3 w-3" aria-hidden="true" />
            <span>{busyAction === 'fire' ? '触发中…' : '立即触发'}</span>
          </button>
          <div className="ga-btn-group">
            <button
              type="button"
              onClick={() => { void toggle() }}
              disabled={busy}
              className="ga-btn-group-item"
              title={s.enabled ? '暂停任务' : '启用任务'}
            >
              <Power className="h-3 w-3" aria-hidden="true" />
              <span>{busyAction === 'toggle' ? (s.enabled ? '禁用中…' : '启用中…') : (s.enabled ? '禁用' : '启用')}</span>
            </button>
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              aria-label="编辑任务"
              title="编辑"
              className="ga-btn-group-item px-2"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => { void remove() }}
              disabled={busy}
              aria-label="删除任务"
              title={busyAction === 'delete' ? '删除中…' : '删除'}
              className="ga-btn-group-item-danger px-2"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              {busyAction === 'delete' && <span>删除中…</span>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskDialog({ initial, onClose }: { initial: Partial<TaskSchedule>; onClose: () => void }) {
  const qc = useQueryClient()
  const [initialSnapshot] = useState<Partial<TaskSchedule>>(() => ({
    type: 'cron',
    enabled: true,
    name: '',
    prompt: '',
    cron: '0 8 * * *',
    interval_minutes: 60,
    ...initial,
  }))
  const [s, setS] = useState<Partial<TaskSchedule>>(initialSnapshot)
  const [saving, setSaving] = useState(false)
  const numEq = (a?: number, b?: number) => (Number.isNaN(a) && Number.isNaN(b)) || a === b
  const isDirty = (s.name ?? '') !== (initialSnapshot.name ?? '')
    || s.type !== initialSnapshot.type
    || Boolean(s.enabled) !== Boolean(initialSnapshot.enabled)
    || (s.prompt ?? '') !== (initialSnapshot.prompt ?? '')
    || (s.type === 'cron' && (s.cron ?? '') !== (initialSnapshot.cron ?? ''))
    || (s.type === 'interval' && !numEq(s.interval_minutes, initialSnapshot.interval_minutes))
  const { requestClose } = useDirtyClose({ dirty: isDirty, busy: saving, onClose })
  const save = async () => {
    if (saving) return
    const type = (s.type ?? 'cron') as TaskScheduleType
    if (!(s.name || '').trim()) {
      await dialog.alert('请填写名称', '任务名称不能为空。')
      return
    }
    if (!(s.prompt || '').trim()) {
      await dialog.alert('请填写 Prompt', '任务 Prompt 不能为空。')
      return
    }
    if (type === 'cron') {
      try {
        CronExpressionParser.parse((s.cron || '').trim())
      } catch {
        await dialog.alert('cron 表达式无效', '请检查 cron 表达式格式，例如 0 8 * * *。')
        return
      }
    } else if (type === 'interval') {
      const mins = Number(s.interval_minutes)
      if (!Number.isFinite(mins) || mins < 1) {
        await dialog.alert('周期无效', '执行周期必须为不小于 1 的分钟数。')
        return
      }
    }
    setSaving(true)
    try {
      await api.upsertTaskSchedule({
        ...s, type,
        interval_minutes: Number.isNaN(s.interval_minutes) ? undefined : s.interval_minutes,
      })
      qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
      onClose()
    } catch (e: any) {
      await dialog.alert('保存失败', errorMessageFromError(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ModalOverlay onClose={requestClose} closeOnBackdrop={false} labelledBy="task-dialog-title" panelClassName="p-6 w-[38rem] max-w-[92vw] max-h-[92vh] overflow-y-auto">
      <div className="flex items-center justify-between gap-3 border-b border-line/70 pb-3 mb-4">
        <h3 id="task-dialog-title" className="text-base font-semibold text-ink">{initial.id ? '编辑定时任务' : '新建定时任务'}</h3>
        <CloseIconButton label="关闭弹窗" variant="ghost" iconSize={16} disabled={saving} onClick={requestClose} />
      </div>
      <Field label="名称">
        <input value={s.name || ''} onChange={(e) => setS({ ...s, name: e.target.value })} className={inp} placeholder="每日早报" />
      </Field>
      <Field label="类型">
        <select value={s.type} onChange={(e) => setS({ ...s, type: e.target.value as TaskScheduleType })} className={`${inp} ga-select`}>
          <option value="cron">定时 (Cron)</option>
          <option value="interval">周期 (Interval)</option>
        </select>
      </Field>
      {s.type === 'cron' && (
        <Field label="Cron 表达式">
          <input value={s.cron || ''} onChange={(e) => setS({ ...s, cron: e.target.value })} className={inp + ' font-mono'} placeholder="分 时 日 月 周（本地时区）" />
          <CronPreview expr={s.cron || ''} />
        </Field>
      )}
      {s.type === 'interval' && (
        <Field label="间隔分钟">
          <input type="number" min={1} value={Number.isNaN(s.interval_minutes) ? '' : s.interval_minutes ?? 60}
            onChange={(e) => setS({ ...s, interval_minutes: e.currentTarget.valueAsNumber })} className={inp} />
        </Field>
      )}
      <Field label="任务 Prompt">
        <textarea
          value={s.prompt || ''}
          onChange={(e) => setS({ ...s, prompt: e.target.value })}
          rows={5}
          className={inp + ' resize-none text-xs leading-relaxed'}
          placeholder="每天抓取 XXX 信息，总结成 5 条要点；如果有重要变化，请在结论里标出。"
        />
      </Field>
      <Field label="启用">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          <span className="text-ink">保存后立即生效</span>
        </label>
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <button type="button" onClick={requestClose} disabled={saving} className="ga-btn">取消</button>
        <button type="button" onClick={save} disabled={saving} className="ga-btn-primary">
          <Save className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{saving ? '保存中…' : '保存'}</span>
        </button>
      </div>
    </ModalOverlay>
  )
}

function TaskResultDialog({ run, onClose }: { run: TaskRun; onClose: () => void }) {
  const result = useQuery({
    queryKey: ['tasks.runResult', run.id],
    queryFn: () => api.taskRunResult(run.id),
    staleTime: Infinity,
  })
  return (
    <ModalOverlay onClose={onClose} labelledBy="task-result-title" panelClassName="flex flex-col w-[48rem] max-w-[92vw] max-h-[85vh] p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="task-result-title" className="text-base font-semibold text-ink">运行结论</h2>
          <p className="text-xs text-ink-muted">{run.task_name || run.task_id} · {formatRelativeTime(run.fired_at)}</p>
        </div>
        <CloseIconButton label="关闭运行结论" title="关闭" variant="ghost" iconSize={15} onClick={onClose} />
      </div>
      <div className="min-h-0 min-w-0 overflow-auto text-sm text-ink">
        {result.isPending ? <p role="status">正在加载结论…</p> : result.isError ? (
          <div role="alert">
            无法加载完整结论。<button type="button" className="ga-btn-link ml-1" onClick={() => { void result.refetch() }}>重试</button>
          </div>
        ) : <MarkdownView>{result.data.result_text}</MarkdownView>}
      </div>
    </ModalOverlay>
  )
}

const TASK_RUN_STATUS_LABELS: Record<string, string> = {
  done: '完成',
  running: '运行中',
  error: '失败',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'done'
    ? 'bg-status-success-soft text-status-success'
    : status === 'running'
      ? 'bg-status-warning-soft text-status-warning'
      : 'bg-status-danger-soft text-status-danger'
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium leading-none ${cls}`}>{TASK_RUN_STATUS_LABELS[status] ?? status}</span>
}

const inp = 'w-full bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent text-ink'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-xs text-ink-faint mb-1">{label}</div>
      {children}
    </div>
  )
}

