import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { EmailConfig, TaskRun, TaskSchedule, TaskScheduleType } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { ModalOverlay } from '@/components/ModalOverlay'
import { formatRelativeTime } from '@/utils/timeFormat'
import { errorMessageFromError } from '@/utils/sessionUi'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { useHubEvent } from '@/hooks/useHubEvent'
import { queryKeys } from '@/queries/queryKeys'
import { CronExpressionParser } from 'cron-parser'
import { CronCardLine, CronPreview } from '@/components/CronPreview'
import { ChevronLeft, ChevronRight, Mail, Plus } from '@/components/ActionIcons'

const RUNS_PER_PAGE = 10
const pageButtonClass = 'inline-grid size-8 place-items-center rounded-md border border-line bg-bg-card text-ink hover:border-accent hover:text-accent focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink'

export default function Tasks() {
  const qc = useQueryClient()
  const { data: schData } = useQuery({
    queryKey: queryKeys.tasks.schedules,
    queryFn: api.taskSchedules,
  })
  const { data: runData } = useQuery({
    queryKey: queryKeys.tasks.runs,
    queryFn: () => api.taskRuns(80),
  })

  useHubEvent('task:', (event) => {
    if (event.topic === 'task:upsert' || event.topic === 'task:delete') {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
    }
    if (event.topic === 'task:fired' || event.topic === 'task:done' || event.topic === 'task:error') {
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.runs })
    }
  })
  const [editor, setEditor] = useState<Partial<TaskSchedule> | null>(null)
  const [runPage, setRunPage] = useState(0)

  const schedules = schData?.schedules ?? []
  const runs = runData?.runs ?? []
  const pageCount = Math.max(1, Math.ceil(runs.length / RUNS_PER_PAGE))
  const page = Math.min(runPage, pageCount - 1)
  useEffect(() => {
    if (page !== runPage) setRunPage(page)
  }, [page, runPage])
  const start = page * RUNS_PER_PAGE
  const pageRuns = runs.slice(start, start + RUNS_PER_PAGE)

  const triggerNow = async (id: string) => {
    const ok = await dialog.confirm(
      '立即触发一次定时任务？',
      '这会让 Agent 立刻执行该任务 Prompt，完成后按任务设置发送邮件。',
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
      actions={
        <button
          onClick={() => setEditor({ type: 'cron', enabled: true, cron: '0 8 * * *', name: '', notify_email: false })}
          className="ga-btn-primary"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>新建任务</span>
        </button>
      }
    >
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        <section>
          <h2 className="text-sm font-semibold text-ink mb-3">任务计划</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {schedules.map((s) => <TaskCard key={s.id} s={s} onEdit={() => setEditor(s)} onFire={() => triggerNow(s.id)} />)}
            {schedules.length === 0 && <div className="text-ink-faint text-sm">尚无定时任务</div>}
          </div>
        </section>

        <EmailSettings />

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-ink">运行历史</h2>
            {pageCount > 1 && (
              <nav aria-label="运行历史分页" className="flex items-center gap-2 text-xs text-ink-faint">
                <button type="button" aria-label="上一页" title="上一页" className={pageButtonClass}
                  disabled={page === 0} onClick={() => setRunPage(page - 1)}>
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <span role="status" className="min-w-28 text-center tabular-nums whitespace-nowrap">
                  第 {page + 1} / {pageCount} 页 · {runs.length} 条
                </span>
                <button type="button" aria-label="下一页" title="下一页" className={pageButtonClass}
                  disabled={page === pageCount - 1} onClick={() => setRunPage(page + 1)}>
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </nav>
            )}
          </div>
          <div className="rounded-xl border border-line bg-bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-soft text-xs text-ink-muted">
                <tr>
                  <th className="text-left p-2.5">时间</th>
                  <th className="text-left p-2.5">任务</th>
                  <th className="text-left p-2.5">状态</th>
                  <th className="text-left p-2.5">结果</th>
                  <th className="text-left p-2.5">邮件</th>
                </tr>
              </thead>
              <tbody>
                {pageRuns.map((r: TaskRun) => (
                  <tr key={r.id} className="border-t border-line/60 align-top">
                    <td className="p-2.5 text-ink-muted whitespace-nowrap">{formatRelativeTime(r.fired_at)}</td>
                    <td className="p-2.5 text-ink">{r.task_name || r.task_id}</td>
                    <td className="p-2.5"><StatusBadge status={r.status} /></td>
                    <td className="p-2.5 text-ink-muted max-w-lg">
                      <div className="line-clamp-2 break-words">{r.result_preview || r.prompt_preview || '—'}</div>
                      {r.stream_id && <div className="text-[10px] text-ink-faint font-mono mt-1">{r.stream_id}</div>}
                    </td>
                    <td className="p-2.5 text-xs">
                      {r.email_sent && <span className="text-status-success">已发送</span>}
                      {!r.email_sent && r.email_error && <span className="text-status-danger" title={r.email_error}>失败</span>}
                      {!r.email_sent && !r.email_error && <span className="text-ink-faint">—</span>}
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-ink-faint text-sm">尚无运行历史</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {editor && <TaskDialog initial={editor} onClose={() => setEditor(null)} />}
    </PageShell>
  )
}

function TaskCard({ s, onEdit, onFire }: { s: TaskSchedule; onEdit: () => void; onFire: () => void }) {
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.upsertTaskSchedule({ ...s, type: s.type as TaskScheduleType, enabled: !s.enabled })
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
    } catch (e: unknown) {
      await dialog.alert('切换失败', errorMessageFromError(e))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (busy) return
    const ok = await dialog.confirm('删除该定时任务？', s.name || s.id, {
      confirmText: '删除',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await api.deleteTaskSchedule(s.id)
      toast.success('已删除定时任务')
      void qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
    } catch (e: unknown) {
      await dialog.alert('删除失败', errorMessageFromError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`rounded-xl border p-4 ${s.enabled ? 'border-accent/60 bg-accent-soft/20' : 'border-line bg-bg-card'}`}>
      <div className="flex items-baseline justify-between mb-2 gap-2">
        <div className="text-sm font-semibold text-ink truncate" title={s.name || s.id}>{s.name || s.id}</div>
        <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded ${s.enabled ? 'bg-status-success-soft text-status-success' : 'border border-line bg-bg-soft text-ink-muted'}`}>
          {s.enabled ? '启用' : '禁用'}
        </span>
      </div>
      <div className="text-xs text-ink-faint mb-1 font-mono">{s.id}</div>
      <div className="text-sm text-ink mb-2">
        {s.type === 'cron' && <CronCardLine expr={s.cron} />}
        {s.type === 'interval' && `每 ${s.interval_minutes} 分钟`}
      </div>
      <div className="text-xs text-ink-faint">邮件 {s.notify_email ? '开启' : '关闭'} · 已触发 {s.fire_count ?? 0} 次</div>
      <div className="text-xs text-ink-faint mt-1">上次 {s.last_fired_at ? formatRelativeTime(s.last_fired_at) : '—'}</div>
      <div className="flex gap-2 mt-3 flex-wrap">
        <button onClick={onFire} disabled={busy} className="ga-solid-primary text-xs px-2.5 py-1 rounded">立即触发</button>
        <button onClick={toggle} disabled={busy} className="text-xs px-2.5 py-1 rounded border border-line text-ink hover:bg-ink/5 disabled:opacity-40">{s.enabled ? '禁用' : '启用'}</button>
        <button onClick={onEdit} disabled={busy} className="text-xs px-2.5 py-1 rounded border border-line text-ink hover:bg-ink/5 disabled:opacity-40">编辑</button>
        <button onClick={remove} disabled={busy} className="text-xs px-2.5 py-1 rounded border border-status-danger-line text-status-danger hover:bg-status-danger-soft disabled:opacity-40">删除</button>
      </div>
    </div>
  )
}

function TaskDialog({ initial, onClose }: { initial: Partial<TaskSchedule>; onClose: () => void }) {
  const qc = useQueryClient()
  const [s, setS] = useState<Partial<TaskSchedule>>({
    type: 'cron',
    enabled: true,
    name: '',
    prompt: '',
    cron: '0 8 * * *',
    interval_minutes: 60,
    notify_email: false,
    email_to: '',
    email_subject: 'GenericAgent 定时任务结果: {name}',
    ...initial,
  })
  const [saving, setSaving] = useState(false)
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
    if (s.notify_email && !(s.email_to || '').trim()) {
      await dialog.alert('请填写收件人', '已开启邮件通知，但收件人为空。')
      return
    }
    setSaving(true)
    try {
      await api.upsertTaskSchedule({ ...s, type })
      qc.invalidateQueries({ queryKey: queryKeys.tasks.schedules })
      onClose()
    } catch (e: any) {
      await dialog.alert('保存失败', errorMessageFromError(e))
    } finally {
      setSaving(false)
    }
  }
  return (
    <ModalOverlay onClose={() => { if (!saving) onClose() }} closeOnBackdrop={!saving} labelledBy="task-dialog-title" panelClassName="p-6 w-[38rem] max-w-[92vw] max-h-[92vh] overflow-y-auto">
      <h3 id="task-dialog-title" className="text-base font-semibold mb-4">{initial.id ? '编辑定时任务' : '新建定时任务'}</h3>
      <Field label="名称">
        <input value={s.name || ''} onChange={(e) => setS({ ...s, name: e.target.value })} className={inp} placeholder="每日早报" />
      </Field>
      <Field label="类型">
        <select value={s.type} onChange={(e) => setS({ ...s, type: e.target.value as TaskScheduleType })} className={inp}>
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
          <input type="number" min={1} value={s.interval_minutes ?? 60}
            onChange={(e) => setS({ ...s, interval_minutes: +e.target.value })} className={inp} />
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
      <Field label="邮件通知">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!s.notify_email} onChange={(e) => setS({ ...s, notify_email: e.target.checked })} />
          <span className="text-ink">任务完成后发送邮件</span>
        </label>
      </Field>
      {s.notify_email && (
        <>
          <Field label="收件人（留空使用默认收件人）">
            <input value={s.email_to || ''} onChange={(e) => setS({ ...s, email_to: e.target.value })} className={inp} placeholder="you@example.com" />
          </Field>
          <Field label="邮件标题">
            <input value={s.email_subject || ''} onChange={(e) => setS({ ...s, email_subject: e.target.value })} className={inp} placeholder="GenericAgent 定时任务结果: {name}" />
          </Field>
        </>
      )}
      <Field label="启用">
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} />
          <span className="text-ink">保存后立即生效</span>
        </label>
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} disabled={saving} className="px-3 py-1.5 rounded-lg border border-line text-ink disabled:opacity-50">取消</button>
        <button onClick={save} disabled={saving} className="ga-solid-primary px-3 py-1.5 rounded-lg">{saving ? '保存中…' : '保存'}</button>
      </div>
    </ModalOverlay>
  )
}

function EmailSettings() {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: queryKeys.tasks.emailConfig, queryFn: api.taskEmailConfig })
  const [editing, setEditing] = useState(false)
  const [cfg, setCfg] = useState<Partial<EmailConfig> & { password?: string }>({})
  const [testTo, setTestTo] = useState('')
  const [result, setResult] = useState('')
  const [testing, setTesting] = useState(false)

  const startEdit = () => {
    setCfg({
      host: data?.host || '',
      port: data?.port || 587,
      username: data?.username || '',
      password: '',
      from_addr: data?.from_addr || '',
      default_to: data?.default_to || '',
      use_tls: data?.use_tls ?? true,
      use_ssl: data?.use_ssl ?? false,
    })
    setEditing(true)
    setResult('')
  }
  const [savingCfg, setSavingCfg] = useState(false)
  const save = async () => {
    if (savingCfg) return
    setSavingCfg(true)
    try {
      await api.saveTaskEmailConfig(cfg)
      await qc.invalidateQueries({ queryKey: queryKeys.tasks.emailConfig })
      setEditing(false)
      setResult('已保存')
    } catch (e: any) {
      const msg = errorMessageFromError(e)
      setResult(`保存失败: ${msg}`)
      await dialog.alert('保存失败', msg)
    } finally {
      setSavingCfg(false)
    }
  }
  const test = async () => {
    if (testing) return
    const testRecipient = testTo.trim()
    const recipient = testRecipient || (cfg.default_to || '').trim()
    const ok = await dialog.confirm(
      '发送测试邮件？',
      `将先保存当前 SMTP 配置，然后发送一封测试邮件到：\n${recipient || '默认收件人（当前未填写，可能发送失败）'}`,
      { confirmText: '发送测试' },
    )
    if (!ok) return

    setTesting(true)
    setResult('')
    try {
      await api.saveTaskEmailConfig(cfg)
      await qc.invalidateQueries({ queryKey: queryKeys.tasks.emailConfig })
      const r = await api.testTaskEmail(testRecipient, 'GenericAgent 邮件测试', '这是一封来自 GA-Hub 的测试邮件。')
      const msg = r.ok ? `测试邮件已发送到 ${r.to}` : `发送失败: ${r.error || 'unknown'}`
      setResult(msg)
      if (r.ok) {
        await dialog.alert('测试邮件已发送', `收件人：${r.to}`)
      } else {
        await dialog.alert('测试邮件发送失败', r.error || 'unknown')
      }
    } catch (e: any) {
      const msg = errorMessageFromError(e)
      setResult(`发送失败: ${msg}`)
      await dialog.alert('测试邮件发送失败', msg)
    } finally {
      setTesting(false)
    }
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3 gap-3">
        <h2 className="text-sm font-semibold text-ink">邮件设置</h2>
        <button onClick={startEdit} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded border border-line text-ink hover:bg-ink/5"><Mail className="h-3.5 w-3.5" aria-hidden="true" /><span>配置 SMTP</span></button>
      </div>
      <div className="rounded-xl border border-line bg-bg-card p-4 text-sm text-ink-muted">
        {data?.host
          ? <div>{data.host}:{data.port} · {data.username || '无需登录'} · 默认收件人 {data.default_to || '未设置'} · 密码 {data.password_set ? '已保存' : '未设置'}</div>
          : <div>未配置 SMTP。任务仍会执行，但邮件通知会失败。</div>}
        {result && <div className="mt-2 text-xs text-accent">{result}</div>}
      </div>
      {editing && (
        <ModalOverlay onClose={() => setEditing(false)} labelledBy="smtp-dialog-title" panelClassName="p-6 w-[34rem] max-w-[92vw]">
          <div>
            <h3 id="smtp-dialog-title" className="text-base font-semibold mb-4">SMTP 邮件配置</h3>
            <Field label="SMTP Host"><input value={cfg.host || ''} onChange={(e) => setCfg({ ...cfg, host: e.target.value })} className={inp} placeholder="smtp.example.com" /></Field>
            <Field label="端口"><input type="number" value={cfg.port ?? 587} onChange={(e) => setCfg({ ...cfg, port: +e.target.value })} className={inp} /></Field>
            <Field label="用户名"><input value={cfg.username || ''} onChange={(e) => setCfg({ ...cfg, username: e.target.value })} className={inp} /></Field>
            <Field label="密码 / 授权码（留空保留旧密码）"><input type="password" value={cfg.password || ''} onChange={(e) => setCfg({ ...cfg, password: e.target.value })} className={inp} /></Field>
            <Field label="发件人"><input value={cfg.from_addr || ''} onChange={(e) => setCfg({ ...cfg, from_addr: e.target.value })} className={inp} placeholder="bot@example.com" /></Field>
            <Field label="默认收件人"><input value={cfg.default_to || ''} onChange={(e) => setCfg({ ...cfg, default_to: e.target.value })} className={inp} placeholder="you@example.com" /></Field>
            <div className="flex gap-4 mb-3 text-sm text-ink">
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!cfg.use_tls} onChange={(e) => setCfg({ ...cfg, use_tls: e.target.checked })} />STARTTLS</label>
              <label className="inline-flex items-center gap-2"><input type="checkbox" checked={!!cfg.use_ssl} onChange={(e) => setCfg({ ...cfg, use_ssl: e.target.checked })} />SSL</label>
            </div>
            <Field label="测试收件人（留空使用默认）"><input value={testTo} onChange={(e) => setTestTo(e.target.value)} className={inp} /></Field>
            <div className="flex justify-between gap-2 mt-4">
              <button
                onClick={test}
                disabled={testing}
                className="px-3 py-1.5 rounded-lg border border-line text-ink disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testing ? '发送中…' : '发送测试'}
              </button>
              <div className="flex gap-2">
                <button onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-lg border border-line text-ink">取消</button>
                <button onClick={save} disabled={savingCfg} className="ga-solid-primary px-3 py-1.5 rounded-lg">{savingCfg ? '保存中…' : '保存'}</button>
              </div>
            </div>
          </div>
        </ModalOverlay>
      )}
    </section>
  )
}

const TASK_RUN_STATUS_LABELS: Record<string, string> = {
  done: '完成',
  running: '运行中',
  error: '失败',
  failed: '失败',
}

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'done'
    ? 'bg-status-success-soft text-status-success'
    : status === 'running'
      ? 'bg-status-warning-soft text-status-warning'
      : 'bg-status-danger-soft text-status-danger'
  return <span className={`text-[10px] px-1.5 py-0.5 rounded ${cls}`}>{TASK_RUN_STATUS_LABELS[status] ?? status}</span>
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

