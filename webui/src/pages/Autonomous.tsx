// Autonomous evolution: schedule CRUD + run history + report viewer.

import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import cronstrue from 'cronstrue/i18n'
import { CronExpressionParser } from 'cron-parser'
import { api } from '@/api/client'
import type { Schedule, ScheduleType } from '@/api/types'
import { MarkdownView } from '@/components/MarkdownView'
import { PageShell } from '@/components/PageShell'
import { relTime } from '@/utils/foldTurns'
import { dialog } from '@/stores/dialogStore'

export function Autonomous() {
  const qc = useQueryClient()
  const { data: schData } = useQuery({ queryKey: ['schedules'], queryFn: api.schedules, refetchInterval: 8000 })
  const { data: runData } = useQuery({ queryKey: ['auto.runs'], queryFn: () => api.runs(50), refetchInterval: 8000 })
  const { data: rep } = useQuery({ queryKey: ['auto.reports'], queryFn: api.reports, refetchInterval: 12000 })

  const [editor, setEditor] = useState<Partial<Schedule> | null>(null)
  const [activeReport, setActiveReport] = useState<string | null>(null)
  const { data: report } = useQuery({
    queryKey: ['auto.report', activeReport],
    queryFn: () => api.report(activeReport!),
    enabled: !!activeReport,
  })

  const schedules = schData?.schedules ?? []
  const runs = runData?.runs ?? []
  const reports = rep?.reports ?? []

  const triggerNow = async (id: string) => {
    const ok = await dialog.confirm(
      '立即触发一次自主任务？',
      '这会让 Agent 立刻开始执行 SOP，可能持续较长时间。',
      { confirmText: '触发' },
    )
    if (!ok) return
    await api.triggerSchedule(id)
    qc.invalidateQueries({ queryKey: ['auto.runs'] })
  }

  return (
    <PageShell
      title="自主进化"
      description="自定义空闲触发 / cron / 周期，让 GenericAgent 在无人值守时自我学习成长。"
      actions={
        <button
          onClick={() => setEditor({ type: 'idle', enabled: true, name: '' })}
          className="ga-btn-primary"
        >+ 新建计划</button>
      }
    >
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        {/* schedules */}
        <section>
          <h2 className="text-sm font-semibold text-slate-300 mb-3">调度计划</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {schedules.map((s) => <ScheduleCard key={s.id} s={s} onEdit={() => setEditor(s)} onFire={() => triggerNow(s.id)} />)}
            {schedules.length === 0 && <div className="text-slate-500 text-sm">尚无计划</div>}
          </div>
        </section>

        {/* runs */}
        <section>
          <h2 className="text-sm font-semibold text-slate-300 mb-3">触发历史</h2>
          <div className="rounded-xl border border-line bg-bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs text-slate-400">
                <tr><th className="text-left p-2.5">时间</th><th className="text-left p-2.5">计划</th><th className="text-left p-2.5">提示</th><th className="text-left p-2.5">报告</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-line/60">
                    <td className="p-2.5 text-slate-400 whitespace-nowrap">{relTime(r.fired_at)}</td>
                    <td className="p-2.5 text-slate-200">{r.schedule_id}</td>
                    <td className="p-2.5 text-slate-400 truncate max-w-md">{r.prompt_preview}</td>
                    <td className="p-2.5">
                      {r.report_paths?.length
                        ? r.report_paths.map((p) => p.split('/').pop()).map((n) => (
                          <button key={n} onClick={() => setActiveReport(n!)} className="text-accent text-xs hover:underline mr-2">{n}</button>
                        ))
                        : <span className="text-slate-600 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-500 text-sm">尚未触发过自主任务</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        {/* reports browser */}
        <section>
          <h2 className="text-sm font-semibold text-slate-300 mb-3">所有报告 ({reports.length})</h2>
          <div className="flex flex-wrap gap-2">
            {reports.map((r) => (
              <button
                key={r.name}
                onClick={() => setActiveReport(r.name)}
                className={`px-3 py-1.5 text-xs rounded-lg border ${activeReport === r.name ? 'border-accent text-accent' : 'border-line text-slate-300 hover:bg-white/5'}`}
              >
                {r.name}
              </button>
            ))}
            {reports.length === 0 && <div className="text-slate-500 text-sm">temp/autonomous_reports/ 下还没有报告</div>}
          </div>
        </section>
      </div>

      {editor && <ScheduleDialog initial={editor} onClose={() => setEditor(null)} />}
      {activeReport && report && <ReportDrawer name={activeReport} content={report.content} onClose={() => setActiveReport(null)} />}
    </PageShell>
  )
}

function ScheduleCard({ s, onEdit, onFire }: { s: Schedule; onEdit: () => void; onFire: () => void }) {
  const qc = useQueryClient()
  const toggle = async () => {
    await api.upsertSchedule({ ...s, enabled: !s.enabled })
    qc.invalidateQueries({ queryKey: ['schedules'] })
  }
  const remove = async () => {
    const ok = await dialog.confirm('删除该计划？', s.name || s.id, {
      confirmText: '删除',
      tone: 'danger',
    })
    if (!ok) return
    await api.deleteSchedule(s.id)
    qc.invalidateQueries({ queryKey: ['schedules'] })
  }
  return (
    <div className={`rounded-xl border p-4 ${s.enabled ? 'border-accent/60 bg-accent-soft/20' : 'border-line bg-bg-card'}`}>
      <div className="flex items-baseline justify-between mb-2">
        <div className="text-sm font-semibold text-slate-200">{s.name || s.id}</div>
        <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.enabled ? 'bg-emerald-900/40 text-emerald-300' : 'bg-slate-700 text-slate-400'}`}>
          {s.enabled ? '启用' : '禁用'}
        </span>
      </div>
      <div className="text-xs text-slate-500 mb-1">{s.id}</div>
      <div className="text-sm text-slate-300 mb-2">
        {s.type === 'idle' && `离线 ${s.idle_minutes} 分钟后触发`}
        {s.type === 'cron' && <CronCardLine expr={s.cron} />}
        {s.type === 'interval' && `每 ${s.interval_minutes} 分钟`}
      </div>
      <div className="text-xs text-slate-500">已触发 {s.fire_count} 次 · 上次 {s.last_fired_at ? relTime(s.last_fired_at) : '—'}</div>
      <div className="flex gap-2 mt-3 flex-wrap">
        <button onClick={onFire} className="text-xs px-2.5 py-1 rounded bg-accent text-white">立即触发</button>
        <button onClick={toggle} className="text-xs px-2.5 py-1 rounded border border-line text-slate-300 hover:bg-white/5">{s.enabled ? '禁用' : '启用'}</button>
        <button onClick={onEdit} className="text-xs px-2.5 py-1 rounded border border-line text-slate-300 hover:bg-white/5">编辑</button>
        <button onClick={remove} className="text-xs px-2.5 py-1 rounded border border-rose-700/60 text-rose-300 hover:bg-rose-900/20">删除</button>
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
  const save = async () => {
    await api.upsertSchedule({ ...s, type: (s.type ?? 'idle') as ScheduleType })
    qc.invalidateQueries({ queryKey: ['schedules'] })
    onClose()
  }
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-bg-soft border border-line rounded-xl p-6 w-[34rem] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-4">{initial.id ? '编辑计划' : '新建自主进化计划'}</h3>
        <Field label="名称">
          <input value={s.name || ''} onChange={(e) => setS({ ...s, name: e.target.value })} className={inp} placeholder="人类可读的备注" />
        </Field>
        <Field label="类型">
          <select value={s.type} onChange={(e) => setS({ ...s, type: e.target.value as ScheduleType })} className={inp}>
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
            <span className="text-slate-300">立即生效</span>
          </label>
        </Field>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-line text-slate-300">取消</button>
          <button onClick={save} className="px-3 py-1.5 rounded-lg bg-accent text-white">保存</button>
        </div>
      </div>
    </div>
  )
}

function ReportDrawer({ name, content, onClose }: { name: string; content: string; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-30 bg-black/60 flex items-end justify-end" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-[42rem] h-full bg-bg-soft border-l border-line p-6 overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-mono text-slate-300">{name}</h3>
          <button onClick={onClose} className="text-slate-400 text-xl leading-none">×</button>
        </div>
        <MarkdownView>{content}</MarkdownView>
      </div>
    </div>
  )
}

const inp = 'w-full bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent text-slate-200'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      {children}
    </div>
  )
}

// CronPreview — show human-readable description + next 3 fire times beneath
// the cron input, or a red-tinted error if the expression is unparseable.
// Uses local timezone (matches the backend's interpretation; see
// services/autonomous_scheduler.py).
function CronPreview({ expr }: { expr: string }) {
  const lang = navigator.language?.toLowerCase().startsWith('zh') ? 'zh_CN' : 'en'
  const result = useMemo(() => {
    const e = expr.trim()
    if (!e) return { ok: true as const, desc: '', next: [] as Date[] }
    try {
      const parsed = CronExpressionParser.parse(e)
      const desc = cronstrue.toString(e, { locale: lang })
      const next: Date[] = []
      for (let i = 0; i < 3; i++) next.push(parsed.next().toDate())
      return { ok: true as const, desc, next }
    } catch (err: any) {
      return { ok: false as const, error: String(err?.message || err) }
    }
  }, [expr, lang])

  if (!expr.trim()) return null

  if (!result.ok) {
    return (
      <div className="mt-1.5 text-xs text-rose-400 bg-rose-900/20 border border-rose-700/40 rounded px-2 py-1">
        ✗ {result.error}
      </div>
    )
  }

  return (
    <div className="mt-1.5 text-xs text-slate-400 space-y-0.5">
      <div className="text-emerald-400">✓ {result.desc}</div>
      {result.next.length > 0 && (
        <div className="text-slate-500">
          下次触发：{result.next.map(formatLocal).join(' · ')}
        </div>
      )}
    </div>
  )
}

function formatLocal(d: Date): string {
  // YY-MM-DD HH:mm in local time, tight format
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Card-line summary: show the cron expression + next fire time (best-effort).
function CronCardLine({ expr }: { expr: string }) {
  const next = useMemo(() => {
    try { return CronExpressionParser.parse(expr).next().toDate() }
    catch { return null }
  }, [expr])
  return (
    <div>
      <span className="font-mono text-xs">{expr}</span>
      {next && <span className="text-xs text-slate-500 ml-2">→ {formatLocal(next)}</span>}
    </div>
  )
}
