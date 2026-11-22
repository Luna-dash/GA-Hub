// Autonomous evolution: schedule CRUD + run history + report viewer.

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CronExpressionParser } from 'cron-parser'
import { api } from '@/api/client'
import type { Schedule, ScheduleType } from '@/api/types'
import { MessageContent } from '@/components/MessageContent'
import { PageShell } from '@/components/PageShell'
import { ModalOverlay } from '@/components/ModalOverlay'
import { formatRelativeTime } from '@/utils/timeFormat'
import { dialog } from '@/stores/dialogStore'
import { errorMessageFromError } from '@/utils/sessionUi'
import { useHubEvent } from '@/hooks/useHubEvent'
import { queryKeys } from '@/queries/queryKeys'
import { CronCardLine, CronPreview } from '@/components/CronPreview'
import { writeClipboard } from '@/utils/clipboard'
import { Calendar, Clock, CloseIconButton, CopyIcon, FileText, History, Pencil, Play, Plus, Power, RefreshIcon, Save, Sparkles, Trash2 } from '@/components/ActionIcons'

export default function Autonomous() {
  const qc = useQueryClient()
  const { data: schData } = useQuery({
    queryKey: queryKeys.schedules,
    queryFn: api.schedules,
  })
  const { data: runData } = useQuery({
    queryKey: queryKeys.autonomous.runs,
    queryFn: () => api.runs(50),
  })
  const { data: rep } = useQuery({
    queryKey: queryKeys.autonomous.reports,
    queryFn: api.reports,
  })

  useHubEvent('autonomous:', (event) => {
    if (event.topic === 'autonomous:upsert' || event.topic === 'autonomous:delete' || event.topic === 'autonomous:fired') {
      qc.invalidateQueries({ queryKey: queryKeys.schedules })
    }
    if (event.topic === 'autonomous:report_saved') {
      qc.invalidateQueries({ queryKey: queryKeys.autonomous.runs })
      qc.invalidateQueries({ queryKey: queryKeys.autonomous.reports })
    }
  })

  const [editor, setEditor] = useState<Partial<Schedule> | null>(null)
  const [activeReport, setActiveReport] = useState<string | null>(null)
  const {
    data: report,
    isLoading: reportLoading,
    isError: reportError,
    error: reportErr,
    refetch: refetchReport,
  } = useQuery({
    queryKey: queryKeys.autonomous.report(activeReport),
    queryFn: () => api.report(activeReport!),
    enabled: !!activeReport,
  })

  const schedules = schData?.schedules ?? []
  const runs = runData?.runs ?? []
  const reports = rep?.reports ?? []
  const enabledCount = schedules.filter((s) => s.enabled).length
  const totalFires = schedules.reduce((sum, s) => sum + (s.fire_count ?? 0), 0)

  const triggerNow = async (id: string) => {
    const ok = await dialog.confirm(
      '立即触发一次自主任务？',
      '这会让 Agent 立刻开始执行 SOP，可能持续较长时间。',
      { confirmText: '触发' },
    )
    if (!ok) return
    try {
      await api.triggerSchedule(id)
      qc.invalidateQueries({ queryKey: queryKeys.autonomous.runs })
    } catch (e: any) {
      await dialog.alert('触发失败', errorMessageFromError(e))
    }
  }

  return (
    <PageShell
      title="自主进化"
      actions={
        <button
          onClick={() => setEditor({ type: 'idle', enabled: true, name: '' })}
          className="ga-btn-primary"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>新建计划</span>
        </button>
      }
    >
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        {/* overview */}
        <section aria-label="运行概览" className="ga-paper-card px-5 py-3.5 grid grid-cols-1 sm:grid-cols-3 gap-4 divide-y sm:divide-y-0 sm:divide-x divide-line/35">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-soft text-accent ring-1 ring-line/45">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <div className="text-xs text-ink-faint">调度计划（已启用 / 总计）</div>
              <div className="mt-0.5 text-base font-semibold tabular-nums text-ink">{enabledCount} <span className="text-xs font-normal text-ink-faint">/ {schedules.length}</span></div>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-3 sm:pt-0 sm:pl-4">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-soft text-accent ring-1 ring-line/45">
              <History className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <div className="text-xs text-ink-faint">累计触发执行</div>
              <div className="mt-0.5 text-base font-semibold tabular-nums text-ink">{totalFires} <span className="text-xs font-normal text-ink-faint">次</span></div>
            </div>
          </div>
          <div className="flex items-center gap-3 pt-3 sm:pt-0 sm:pl-4">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-soft text-accent ring-1 ring-line/45">
              <FileText className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <div className="text-xs text-ink-faint">已归档进化报告</div>
              <div className="mt-0.5 text-base font-semibold tabular-nums text-ink">{reports.length} <span className="text-xs font-normal text-ink-faint">份</span></div>
            </div>
          </div>
        </section>

        {/* schedules */}
        <section>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-ink">调度计划</h2>
            <span className="text-xs text-ink-faint tabular-nums">{schedules.length} 项配置</span>
          </div>
          {schedules.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {schedules.map((s) => <ScheduleCard key={s.id} s={s} onEdit={() => setEditor(s)} onFire={() => triggerNow(s.id)} />)}
            </div>
          ) : (
            <div className="ga-paper-card border-dashed bg-bg-card/50 p-8 text-center">
              <div className="mx-auto flex max-w-sm flex-col items-center gap-2.5">
                <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-line/80 bg-bg-soft text-accent">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="text-sm font-medium text-ink">尚无自主进化计划</div>
                <p className="text-xs text-ink-faint">可按系统空闲时间、Cron 定时或固定间隔周期触发 Agent 执行反思与知识整理。</p>
                <button
                  type="button"
                  onClick={() => setEditor({ type: 'idle', enabled: true, name: '' })}
                  className="ga-btn-sm-primary mt-1"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>创建自主计划</span>
                </button>
              </div>
            </div>
          )}
        </section>

        {/* runs */}
        <section>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-ink">触发历史</h2>
            <span className="text-xs text-ink-faint tabular-nums">最近 {runs.length} 条</span>
          </div>
          <div className="ga-paper-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-line/45 bg-bg-soft/65 text-xs font-medium text-ink-muted">
                  <tr>
                    <th className="text-left px-3.5 py-2.5">时间</th>
                    <th className="text-left px-3.5 py-2.5">计划</th>
                    <th className="text-left px-3.5 py-2.5">提示</th>
                    <th className="text-left px-3.5 py-2.5">报告</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/35">
                  {runs.map((r) => (
                    <tr key={r.id} className="hover:bg-bg-soft/55 transition-colors">
                      <td className="px-3.5 py-2.5 text-xs tabular-nums text-ink-muted whitespace-nowrap">{formatRelativeTime(r.fired_at)}</td>
                      <td className="px-3.5 py-2.5">
                        <span className="inline-flex items-center rounded-md border border-line/70 bg-bg-soft/80 px-2 py-0.5 font-mono text-xs text-ink">{r.schedule_id}</span>
                      </td>
                      <td className="px-3.5 py-2.5 text-ink-muted truncate max-w-md" title={r.prompt_preview}>{r.prompt_preview || '—'}</td>
                      <td className="px-3.5 py-2.5">
                        {r.report_paths?.length
                          ? <div className="flex flex-wrap gap-1.5">
                              {r.report_paths.map((p) => p.split('/').pop()).map((n) => (
                                <button key={n} type="button" onClick={() => setActiveReport(n!)} className="ga-btn-link">
                                  <FileText className="h-3 w-3 shrink-0" aria-hidden="true" />
                                  <span>{n}</span>
                                </button>
                              ))}
                            </div>
                          : <span className="text-ink-faint text-xs">—</span>}
                      </td>
                    </tr>
                  ))}
                  {runs.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-ink-faint text-sm">尚未触发过自主任务</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* reports browser */}
        <section>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h2 className="text-sm font-semibold text-ink">所有报告 ({reports.length})</h2>
            {reports.length > 0 && <span className="text-xs text-ink-faint">点击报告在右侧抽屉预览</span>}
          </div>
          {reports.length > 0 ? (
            <div className="ga-paper-card p-4 flex flex-wrap gap-2">
              {reports.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  onClick={() => setActiveReport(r.name)}
                  title={`${r.name}${r.size ? ` (${(r.size / 1024).toFixed(1)} KB)` : ''}`}
                  className={activeReport === r.name ? 'ga-btn-sm-primary' : 'ga-btn-sm'}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="ga-paper-card border-dashed bg-bg-card/50 p-6 text-center text-ink-faint text-sm">尚无自主进化报告，任务触发保存后会显示在此。</div>
          )}
        </section>
      </div>

      {editor && <ScheduleDialog initial={editor} onClose={() => setEditor(null)} />}
      {activeReport && (
        <ReportDrawer
          name={activeReport}
          content={report?.content}
          isLoading={reportLoading}
          isError={reportError}
          errorMessage={reportError ? errorMessageFromError(reportErr) : undefined}
          onRetry={() => { void refetchReport() }}
          onClose={() => setActiveReport(null)}
        />
      )}
    </PageShell>
  )
}

function ScheduleCard({ s, onEdit, onFire }: { s: Schedule; onEdit: () => void; onFire: () => void }) {
  const qc = useQueryClient()
  const toggle = async () => {
    try {
      await api.upsertSchedule({ ...s, type: s.type as ScheduleType, enabled: !s.enabled })
      qc.invalidateQueries({ queryKey: queryKeys.schedules })
    } catch (e: any) {
      await dialog.alert('切换失败', errorMessageFromError(e))
    }
  }
  const remove = async () => {
    const ok = await dialog.confirm('删除该计划？', s.name || s.id, {
      confirmText: '删除',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteSchedule(s.id)
      qc.invalidateQueries({ queryKey: queryKeys.schedules })
    } catch (e: any) {
      await dialog.alert('删除失败', errorMessageFromError(e))
    }
  }
  const typeMeta = s.type === 'idle'
    ? { label: '空闲触发', icon: Sparkles }
    : s.type === 'cron'
      ? { label: 'Cron 定时', icon: Calendar }
      : { label: '周期循环', icon: Clock }
  const TypeIcon = typeMeta.icon
  return (
    <div className={`ga-paper-card p-4 flex flex-col justify-between gap-3 ${s.enabled ? 'border-l-[3px] border-l-accent' : ''}`}>
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-1" title={`ID: ${s.id}`}>
              <span className="inline-flex items-center gap-1 rounded-md bg-bg-soft px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
                <TypeIcon className="h-3 w-3 text-accent" aria-hidden="true" />
                {typeMeta.label}
              </span>
            </div>
            <div className="text-sm font-semibold text-ink truncate" title={`${s.name || s.id} (${s.id})`}>{s.name || s.id}</div>
          </div>
          <span className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${s.enabled ? 'bg-status-success-soft border border-status-success-line text-status-success' : 'bg-bg-soft text-ink-muted'}`}>
            {s.enabled ? '启用' : '禁用'}
          </span>
        </div>

        <div className="ga-paper-subcard px-3 py-2 text-sm text-ink">
          {s.type === 'idle' && `离线 ${s.idle_minutes} 分钟后触发`}
          {s.type === 'cron' && <CronCardLine expr={s.cron} />}
          {s.type === 'interval' && `每 ${s.interval_minutes} 分钟`}
        </div>

        {s.prompt?.trim() && (
          <p className="text-xs text-ink-muted line-clamp-2 break-words" title={s.prompt}>
            {s.prompt}
          </p>
        )}
      </div>

      <div className="space-y-2.5 pt-1">
        <hr className="ga-hairline" />
        <div className="flex items-center justify-between text-xs tabular-nums text-ink-faint">
          <span>已触发 {s.fire_count} 次</span>
          <span>上次 {s.last_fired_at ? formatRelativeTime(s.last_fired_at) : '—'}</span>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <button type="button" onClick={onFire} className="ga-btn-sm-primary px-2.5">
            <Play className="h-3 w-3" aria-hidden="true" />
            <span>立即触发</span>
          </button>
          <button type="button" onClick={toggle} className="ga-btn-sm px-2.5">
            <Power className="h-3 w-3" aria-hidden="true" />
            <span>{s.enabled ? '禁用' : '启用'}</span>
          </button>
          <button type="button" onClick={onEdit} className="ga-btn-sm px-2.5">
            <Pencil className="h-3 w-3" aria-hidden="true" />
            <span>编辑</span>
          </button>
          <button type="button" onClick={remove} className="ga-btn-sm-danger px-2.5">
            <Trash2 className="h-3 w-3" aria-hidden="true" />
            <span>删除</span>
          </button>
        </div>
      </div>
    </div>
  )
}

function ScheduleDialog({ initial, onClose }: { initial: Partial<Schedule>; onClose: () => void }) {
  const qc = useQueryClient()
  const [s, setS] = useState<Partial<Schedule>>({
    type: 'idle',
    enabled: true,
    name: '',
    prompt: '',
    idle_minutes: 30,
    cron: '0 9 * * *',
    interval_minutes: 60,
    ...initial,
  })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (saving) return
    const type = (s.type ?? 'idle') as ScheduleType
    if (type === 'idle') {
      const mins = Number(s.idle_minutes)
      if (!Number.isFinite(mins) || mins < 1) {
        await dialog.alert('空闲时间无效', '空闲分钟数必须为不小于 1 的数字。')
        return
      }
    } else if (type === 'interval') {
      const mins = Number(s.interval_minutes)
      if (!Number.isFinite(mins) || mins < 1) {
        await dialog.alert('周期无效', '间隔分钟数必须为不小于 1 的数字。')
        return
      }
    } else if (type === 'cron') {
      try {
        CronExpressionParser.parse((s.cron || '').trim())
      } catch {
        await dialog.alert('cron 表达式无效', '请检查 cron 表达式格式，例如 0 9 * * *。')
        return
      }
    }
    setSaving(true)
    try {
      await api.upsertSchedule({ ...s, type })
      void qc.invalidateQueries({ queryKey: queryKeys.schedules })
      onClose()
    } catch (e: any) {
      await dialog.alert('保存失败', errorMessageFromError(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ModalOverlay onClose={() => { if (!saving) onClose() }} closeOnBackdrop={!saving} labelledBy="autonomous-schedule-title" panelClassName="p-6 w-[34rem] max-w-[92vw]">
        <div className="flex items-center justify-between gap-3 border-b border-line/70 pb-3 mb-4">
          <h3 id="autonomous-schedule-title" className="text-base font-semibold text-ink">{initial.id ? '编辑计划' : '新建自主进化计划'}</h3>
          <CloseIconButton label="关闭弹窗" variant="ghost" iconSize={16} disabled={saving} onClick={onClose} />
        </div>
        <Field label="名称">
          <input value={s.name || ''} onChange={(e) => setS({ ...s, name: e.target.value })} className={inp} placeholder="人类可读的备注" />
        </Field>
        <Field label="类型">
          <select value={s.type} onChange={(e) => setS({ ...s, type: e.target.value as ScheduleType })} className={`${inp} ga-select`}>
            <option value="idle">空闲 (Idle)</option>
            <option value="cron">定时 (Cron)</option>
            <option value="interval">周期 (Interval)</option>
          </select>
        </Field>
        {s.type === 'idle' && (
          <Field label="空闲分钟">
            <input type="number" min={1} value={s.idle_minutes ?? 30}
                   onChange={(e) => setS({ ...s, idle_minutes: +e.target.value })} className={inp} />
          </Field>
        )}
        {s.type === 'cron' && (
          <Field label="Cron 表达式">
            <input value={s.cron || ''} onChange={(e) => setS({ ...s, cron: e.target.value })} className={inp + ' font-mono'} placeholder="分 时 日 月 周（本地时区）" />
            <CronPreview expr={s.cron || ''} />
          </Field>
        )}
        {s.type === 'interval' && (
          <Field label="间隔分钟">
            <input type="number" min={1} value={s.interval_minutes ?? 60}
                   onChange={(e) => setS({ ...s, interval_minutes: +e.target.value })} className={inp} />
          </Field>
        )}
        <Field label="触发 Prompt（留空使用默认 [AUTO] 提示）">
          <textarea
            value={s.prompt || ''}
            onChange={(e) => setS({ ...s, prompt: e.target.value })}
            rows={3}
            className={inp + ' resize-none font-mono text-xs'}
            placeholder="[AUTO]🤖 请阅读 autonomous_operation_sop 并执行任务"
          />
        </Field>
        <Field label="启用">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
            <span className="text-ink">立即生效</span>
          </label>
        </Field>
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} disabled={saving} className="ga-btn">取消</button>
          <button type="button" onClick={save} disabled={saving} className="ga-btn-primary">
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{saving ? '保存中…' : '保存'}</span>
          </button>
        </div>
    </ModalOverlay>
  )
}

function ReportDrawer({
  name,
  content,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  onClose,
}: {
  name: string
  content?: string
  isLoading: boolean
  isError: boolean
  errorMessage?: string
  onRetry: () => void
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!content) return
    await writeClipboard(content)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <ModalOverlay onClose={onClose} align="right" panelClassName="w-[44rem] max-w-[94vw] h-full border-l flex flex-col overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-line/70 bg-bg-card/85 px-6 py-3.5 shrink-0">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line/75 bg-bg-soft text-accent">
              <FileText className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <h3 className="truncate text-sm font-mono font-medium text-ink">{name}</h3>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!isLoading && !isError && content && (
              <button type="button" onClick={() => { void copy() }} className="ga-btn-sm">
                <CopyIcon copied={copied} size={12} />
                <span>{copied ? '已复制' : '复制'}</span>
              </button>
            )}
            <CloseIconButton label="关闭报告" variant="ghost" iconSize={16} onClick={onClose} className="text-ink-muted hover:text-ink" />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <div role="status" className="py-12 text-center text-sm text-ink-muted">正在读取报告…</div>
          ) : isError ? (
            <div role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft p-4 text-sm text-status-danger space-y-3">
              <p>报告加载失败：{errorMessage || '未知错误'}</p>
              <button type="button" onClick={onRetry} className="ga-btn"><RefreshIcon size={13} /><span>重试</span></button>
            </div>
          ) : (
            <MessageContent content={content ?? ''} format="markdown" />
          )}
        </div>
    </ModalOverlay>
  )
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

