// CronPreview — shared by Autonomous and Tasks (was duplicated verbatim in
// both pages and had already drifted in markup).
//
// Shows a human-readable description + next 3 fire times beneath the cron
// input, or a red-tinted error if the expression is unparseable. Uses local
// timezone (matches the backend's interpretation; see
// services/autonomous_scheduler.py).
import { useMemo } from 'react'
import cronstrue from 'cronstrue/i18n'
import { CronExpressionParser } from 'cron-parser'

function formatLocal(d: Date): string {
  // YY-MM-DD HH:mm in local time, tight format
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function CronPreview({ expr }: { expr: string }) {
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
      <div className="mt-1.5 text-xs text-status-danger bg-status-danger-soft border border-status-danger-line rounded px-2 py-1">
        ✗ {result.error}
      </div>
    )
  }

  return (
    <div className="mt-1.5 text-xs text-slate-400 space-y-0.5">
      <div className="text-status-success">✓ {result.desc}</div>
      {result.next.length > 0 && (
        <div className="text-slate-500">
          下次触发：{result.next.map(formatLocal).join(' · ')}
        </div>
      )}
    </div>
  )
}

// Card-line summary: show the cron expression + next fire time (best-effort).
export function CronCardLine({ expr }: { expr: string }) {
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
