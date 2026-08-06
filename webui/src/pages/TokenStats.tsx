import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import type { TokenHistoryPoint, TokenStatsResponse, TokenTotals } from '@/api/types'

const exactNf = new Intl.NumberFormat('zh-CN')
const compactNf = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })
const exact = (n: number) => exactNf.format(Math.round(n || 0))
const fmt = (n: number) => Math.abs(n || 0) < 1_000 ? exact(n) : compactNf.format(n || 0).toLowerCase()
const dateKey = (timestamp: number) => new Date(timestamp * 1000).toISOString().slice(0, 10)
const dateLabel = (key: string) => { const [, m, d] = key.split('-'); return `${Number(m)}/${Number(d)}` }

type DailyPoint = { date: string; total: number; requests: number; input: number; output: number }

function Metric({ label, value, hint, accent = false, suffix = '' }: { label: string; value: number; hint: string; accent?: boolean; suffix?: string }) {
  return <div className="min-w-0 border-r border-line/70 last:border-r-0 px-5 py-4">
    <div className="text-xs text-slate-500">{label}</div>
    <div className={`mt-2 truncate font-mono text-2xl font-semibold ${accent ? 'text-accent' : 'text-[#2C2418]'}`} title={`${exact(value)}${suffix}`}>{suffix ? value.toFixed(1) : fmt(value)}{suffix}</div>
    <div className="mt-1 text-[11px] text-slate-400">{hint}</div>
  </div>
}

function Composition({ totals }: { totals?: TokenTotals }) {
  const rows = [
    ['输入', totals?.input ?? 0, 'bg-sky-500'],
    ['输出', totals?.output ?? 0, 'bg-amber-500'],
    ['缓存创建', totals?.cache_create ?? 0, 'bg-violet-500'],
    ['缓存读取', totals?.cache_read ?? 0, 'bg-emerald-500'],
  ] as const
  const total = rows.reduce((sum, [, value]) => sum + value, 0)
  return <div className="grid gap-3 sm:grid-cols-2">
    {rows.map(([label, value, color]) => {
      const share = total ? value / total * 100 : 0
      return <div key={label} className="rounded-xl border border-line/70 bg-black/[.015] p-3">
        <div className="flex items-center justify-between gap-3"><span className="flex items-center gap-2 text-xs text-slate-500"><i className={`h-2 w-2 rounded-full ${color}`} />{label}</span><span className="font-mono text-sm font-medium text-[#2C2418]">{fmt(value)}</span></div>
        <div className="mt-2 text-[11px] text-slate-400">占输入侧总量的 {share.toFixed(1)}%</div>
      </div>
    })}
  </div>
}

function DailyChart({ points }: { points: DailyPoint[] }) {
  const width = 760, height = 220, left = 42, right = 12, top = 18, bottom = 34
  const max = Math.max(1, ...points.map((p) => p.total))
  const x = (i: number) => left + (points.length <= 1 ? 0 : i / (points.length - 1)) * (width - left - right)
  const y = (value: number) => top + (1 - value / max) * (height - top - bottom)
  const line = points.map((p, i) => `${x(i)},${y(p.total)}`).join(' ')
  const area = `${left},${height - bottom} ${line} ${x(points.length - 1)},${height - bottom}`
  const labels = points.length <= 7 ? points : points.filter((_, i) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 6) === 0)
  if (!points.length) return <div className="flex h-56 items-center justify-center text-sm text-slate-400">暂无足够的历史采样，服务运行后会自动形成趋势。</div>
  return <div className="overflow-x-auto"><svg viewBox={`0 0 ${width} ${height}`} className="h-56 min-w-[620px] w-full" role="img" aria-label="按日 Token 用量趋势">
    {[0, .5, 1].map((ratio) => <g key={ratio}><line x1={left} x2={width - right} y1={y(max * ratio)} y2={y(max * ratio)} stroke="currentColor" className="text-line" strokeDasharray="3 5" /><text x={left - 8} y={y(max * ratio) + 4} textAnchor="end" className="fill-slate-400 text-[10px]">{fmt(max * ratio)}</text></g>)}
    <polygon points={area} className="fill-accent/10" /><polyline points={line} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-accent" />
    {points.map((p, i) => <circle key={p.date} cx={x(i)} cy={y(p.total)} r="3.5" className="fill-accent"><title>{`${p.date}：${exact(p.total)} Token，${exact(p.requests)} 请求`}</title></circle>)}
    {labels.map((p) => { const i = points.indexOf(p); return <text key={p.date} x={x(i)} y={height - 10} textAnchor="middle" className="fill-slate-400 text-[10px]">{dateLabel(p.date)}</text> })}
  </svg></div>
}

function buildDaily(history: TokenHistoryPoint[], days: number): DailyPoint[] {
  const ordered = [...history].sort((a, b) => a.timestamp - b.timestamp)
  const byDate = new Map<string, DailyPoint>()
  for (let i = 1; i < ordered.length; i += 1) {
    const current = ordered[i], previous = ordered[i - 1]
    const delta = (key: keyof TokenTotals) => Math.max(0, (current[key] ?? 0) - (previous[key] ?? 0))
    const key = dateKey(current.timestamp)
    const point = byDate.get(key) ?? { date: key, total: 0, requests: 0, input: 0, output: 0 }
    point.total += delta('total'); point.requests += delta('requests'); point.input += delta('input'); point.output += delta('output'); byDate.set(key, point)
  }
  return [...byDate.values()].slice(-days)
}

function currentWeekLabel(week?: TokenStatsResponse['current_week']) { return week ? `${week.week_start} 至 ${week.week_end}` : '本自然周' }

export default function TokenStats() {
  const [days, setDays] = useState(30)
  const stats = useQuery({ queryKey: ['tokens.stats'], queryFn: api.tokenStats, refetchInterval: 15000 })
  const history = useQuery({ queryKey: ['tokens.history', 720], queryFn: () => api.tokenHistory(720), refetchInterval: 60000 })
  const data = stats.data
  const allTime = data?.all_time
  const currentWeek = data?.current_week
  const weeks = [...(data?.weeks ?? [])].reverse()
  const daily = useMemo(() => buildDaily(history.data?.history ?? [], days), [history.data, days])
  const latestDay = daily[daily.length - 1]

  return <PageShell title="用量统计" actions={<button className="btn-secondary" onClick={() => { stats.refetch(); history.refetch() }} disabled={stats.isFetching || history.isFetching}>{stats.isFetching || history.isFetching ? '刷新中…' : '刷新'}</button>}>
    <div className="mx-auto max-w-6xl p-6">
      {(stats.isError || history.isError) && <div className="card mb-4 p-4 text-red-600">读取统计失败：{String(stats.error ?? history.error)}</div>}
      {data && !data.available && <div className="card mb-4 p-4 text-amber-700">当前 GA 版本未提供用量追踪，累计数据暂不可更新。</div>}
      <section className="card overflow-hidden">
        <div className="border-b border-line/70 px-5 py-4"><div className="flex items-end justify-between gap-4"><div><h2 className="text-sm font-semibold text-[#2C2418]">总览</h2><p className="mt-1 text-xs text-slate-500">累计值用于看规模，不代表配额或上限。</p></div><span className="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-700">本地持久化</span></div></div>
        <div className="grid grid-cols-2 lg:grid-cols-4"><Metric label="累计 Token" value={allTime?.total ?? 0} hint="全部已记录周期" accent /><Metric label="本周 Token" value={currentWeek?.total ?? 0} hint={currentWeekLabel(currentWeek)} /><Metric label="累计请求" value={allTime?.requests ?? 0} hint="已完成的模型请求" /><Metric label="缓存命中率" value={allTime?.cache_hit_rate ?? 0} suffix="%" hint="缓存读取 / 输入侧" /></div>
      </section>
      <section className="card mt-4 p-5"><div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-sm font-semibold text-[#2C2418]">每日用量</h2><p className="mt-1 text-xs text-slate-500">由累计快照的相邻差值计算；服务重启或历史采样稀疏时可能出现断点。</p></div><div className="flex rounded-lg border border-line/70 p-0.5 text-xs"><button className={`rounded-md px-3 py-1.5 ${days === 7 ? 'bg-accent text-white' : 'text-slate-500'}`} onClick={() => setDays(7)}>7日</button><button className={`rounded-md px-3 py-1.5 ${days === 30 ? 'bg-accent text-white' : 'text-slate-500'}`} onClick={() => setDays(30)}>30日</button></div></div><DailyChart points={daily} />{latestDay && <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500"><span>最近采样日 <b className="font-mono text-[#2C2418]">{latestDay.date}</b></span><span>当日 {fmt(latestDay.total)} Token</span><span>{fmt(latestDay.requests)} 次请求</span></div>}</section>
      <div className="mt-4 grid gap-4 lg:grid-cols-2"><section className="card p-5"><div className="mb-4"><h2 className="text-sm font-semibold text-[#2C2418]">累计构成</h2><p className="mt-1 text-xs text-slate-500">绝对数量与占比同时展示，不使用无意义的进度条。</p></div><Composition totals={allTime} /></section><section className="card p-5"><div className="mb-4"><h2 className="text-sm font-semibold text-[#2C2418]">本周构成</h2><p className="mt-1 text-xs text-slate-500">{currentWeekLabel(currentWeek)}</p></div><Composition totals={currentWeek} /></section></div>
      <section className="card mt-4 overflow-hidden"><div className="flex items-center justify-between border-b border-line/70 px-5 py-4"><div><h2 className="text-sm font-semibold text-[#2C2418]">周期记录</h2><p className="mt-1 text-xs text-slate-500">历史累计按自然周归档</p></div><span className="text-xs text-slate-400">共 {weeks.length} 周</span></div>{!weeks.length ? <div className="p-10 text-center text-sm text-slate-500">尚无 Token 记录。</div> : <div className="overflow-x-auto"><table className="w-full table-fixed text-sm"><thead className="border-b border-line/70 bg-black/[.015] text-xs text-slate-500"><tr><th className="w-[29%] px-5 py-3 text-left font-medium">周期</th><th className="px-3 py-3 text-right font-medium">请求</th><th className="px-3 py-3 text-right font-medium">输入</th><th className="px-3 py-3 text-right font-medium">输出</th><th className="px-3 py-3 text-right font-medium">缓存读取</th><th className="px-3 py-3 text-right font-medium">总计</th><th className="w-[10%] px-5 py-3 text-right font-medium">命中率</th></tr></thead><tbody>{weeks.map((row) => <tr key={row.week_start} className="border-b border-line/50 last:border-0 hover:bg-black/[.02]"><td className="px-5 py-3 font-mono text-xs text-slate-600">{row.week_start} — {row.week_end}</td><td className="px-3 py-3 text-right">{fmt(row.requests)}</td><td className="px-3 py-3 text-right">{fmt(row.input)}</td><td className="px-3 py-3 text-right">{fmt(row.output)}</td><td className="px-3 py-3 text-right">{fmt(row.cache_read)}</td><td className="px-3 py-3 text-right font-mono font-medium text-accent" title={exact(row.total)}>{fmt(row.total)}</td><td className="px-5 py-3 text-right">{row.cache_hit_rate.toFixed(1)}%</td></tr>)}</tbody></table></div>}</section>
    </div>
  </PageShell>
}
