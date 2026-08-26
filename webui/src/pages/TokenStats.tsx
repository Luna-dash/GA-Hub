import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import type { TokenDayStats, TokenStatsResponse, TokenThreadStats, TokenTotals } from '@/api/types'
import { compactTokens, sessionTitle, topSessions, usageRangeDays, visibleWeeks, type DailyUsageRange } from '@/utils/tokenStatsUi'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'

const exactNf = new Intl.NumberFormat('zh-CN')
const fmt = compactTokens
const exact = (value: number) => exactNf.format(value)
const pct = (value: number, total: number) => total > 0 ? (value / total) * 100 : 0

function SummaryCard({ label, value, hint, tone }: { label: string; value: number; hint: string; tone: string }) {
  return <div className="rounded-xl border border-border bg-surface px-4 py-4 shadow-sm">
    <div className="flex items-center gap-2 text-xs text-slate-500"><span className={`h-2 w-2 rounded-full ${tone}`} />{label}</div>
    <div className="mt-2 font-mono text-2xl font-semibold tracking-tight text-slate-800" title={exact(value)}>{fmt(value)}</div>
    <div className="mt-1 text-[11px] text-slate-400">{hint}</div>
  </div>
}

const parts = [
  { key: 'input' as const, label: '输入', color: 'bg-[#16a34a]', text: 'text-[#15803d]' },
  { key: 'output' as const, label: '输出', color: 'bg-[#f97316]', text: 'text-[#c2410c]' },
  { key: 'cache_read' as const, label: '缓存读取', color: 'bg-[#8b5cf6]', text: 'text-[#7c3aed]' },
]

function Composition({ title, data }: { title: string; data: TokenTotals }) {
  const total = data.input + data.output + data.cache_read
  return <section className="rounded-xl border border-border bg-surface p-4 shadow-sm">
    <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold text-slate-700">{title}</h2><span className="font-mono text-xs text-slate-400" title={exact(total)}>共 {fmt(total)}</span></div>
    <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-slate-100">
      {parts.map(part => <div key={part.key} className={part.color} style={{ width: `${pct(data[part.key], total)}%` }} />)}
    </div>
    <div className="mt-4 grid grid-cols-3 gap-3">
      {parts.map(part => <div key={part.key} className="min-w-0"><div className="text-[11px] text-slate-400">{part.label}</div><div className={`mt-1 truncate font-mono text-sm font-semibold ${part.text}`} title={exact(data[part.key])}>{fmt(data[part.key])}</div><div className="mt-0.5 text-[10px] text-slate-400">{pct(data[part.key], total).toFixed(1)}%</div></div>)}
    </div>
  </section>
}

function UsageTrend({ rows, range, setRange, currentWeek, timestamp }: { rows: TokenDayStats[]; range: DailyUsageRange; setRange: (range: DailyUsageRange) => void; currentWeek: TokenStatsResponse['current_week']; timestamp: number }) {
  const width = 760
  const height = 190
  const left = 58
  const right = 12
  const top = 10
  const bottom = 28
  const shown = usageRangeDays(rows, range, currentWeek, timestamp)
  const rangeTotal = shown.reduce((sum, row) => sum + row.total, 0)
  const max = Math.max(1, ...shown.map(row => row.total))
  const plotWidth = width - left - right
  const plotHeight = height - top - bottom
  const points = shown.map((row, index) => ({ ...row, x: left + index * (plotWidth / (shown.length - 1)), y: top + (1 - row.total / max) * plotHeight }))
  const line = points.map(point => `${point.x},${point.y}`).join(' ')
  const baseline = top + plotHeight
  const area = `${points[0].x},${baseline} ${line} ${points.at(-1)!.x},${baseline}`
  const ticks = [0, 1 / 3, 2 / 3, 1]
  const dateTicks = range === 'week' ? [0, 3, 6] : [0, 7, 14, 21, 29]
  return <section className="rounded-xl border border-border bg-surface p-4 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold text-slate-700">每日用量</h2><p className="mt-0.5 text-[11px] text-slate-400">按自然日持久化统计 · 区间合计 {fmt(rangeTotal)} Token</p></div>
      <div className="flex rounded-lg bg-slate-100 p-0.5">{([{ value: 'week', label: '本周' }, { value: '30d', label: '近 30 日' }] as const).map(option => <button key={option.value} type="button" onClick={() => setRange(option.value)} className={`rounded-md px-3 py-1 text-xs transition ${range === option.value ? 'bg-white font-medium text-slate-700 shadow-sm' : 'text-slate-400 hover:text-slate-600'}`}>{option.label}</button>)}</div>
    </div>
    <div className="mt-4 h-48 w-full overflow-hidden">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="每日 Token 用量趋势（含数字坐标轴）">
        <defs><linearGradient id="usage-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#80978d" stopOpacity="0.28" /><stop offset="100%" stopColor="#80978d" stopOpacity="0.02" /></linearGradient></defs>
        {ticks.map(ratio => {
          const y = top + (1 - ratio) * plotHeight
          return <g key={ratio}><line x1={left} x2={width - right} y1={y} y2={y} stroke="#e4e7e6" strokeDasharray={ratio ? '3 5' : undefined} /><text x={left - 8} y={y + 4} textAnchor="end" fontSize="10" fill="#94a3b8">{fmt(max * ratio)}</text></g>
        })}
        <polygon points={area} fill="url(#usage-fill)" />
        <polyline points={line} fill="none" stroke="#718a80" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
        {points.map(point => <circle key={point.date} cx={point.x} cy={point.y} r="3" fill="#718a80"><title>{point.date} · {exact(point.total)} Token · {exact(point.requests)} 次请求</title></circle>)}
        {dateTicks.map(index => <text key={shown[index].date} x={points[index].x} y={height - 7} textAnchor={index === 0 ? 'start' : index === shown.length - 1 ? 'end' : 'middle'} fontSize="10" fill="#94a3b8">{shown[index].date.slice(5)}</text>)}
      </svg>
    </div>
  </section>
}

function WeeklyTable({ data }: { data: TokenStatsResponse }) {
  const [expanded, setExpanded] = usePageState('tokenStats.weeklyTableExpanded', false)
  const rows = visibleWeeks(data.weeks, expanded)
  return <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3"><div><h2 className="text-sm font-semibold text-slate-700">周期统计</h2><p className="mt-0.5 text-[11px] text-slate-400">共 {data.weeks.length} 周</p></div>{data.weeks.length > 6 && <button type="button" onClick={() => setExpanded(value => !value)} className="rounded-lg px-2.5 py-1.5 text-xs text-accent hover:bg-accent/5">{expanded ? '收起' : `查看全部 ${data.weeks.length} 周`}</button>}</div>
    <div className={`overflow-auto ${expanded ? 'max-h-[30rem]' : ''}`}><table className="min-w-[720px] w-full text-left text-xs"><thead className="sticky top-0 bg-slate-50 text-slate-400"><tr><th className="px-4 py-2.5 font-medium">周期</th><th className="px-3 py-2.5 text-right font-medium">请求</th><th className="px-3 py-2.5 text-right font-medium">输入</th><th className="px-3 py-2.5 text-right font-medium">输出</th><th className="px-3 py-2.5 text-right font-medium">缓存读取</th><th className="px-4 py-2.5 text-right font-medium">合计</th></tr></thead><tbody>{rows.map((row) => {
      const isCurrent = row.week_start === data.current_week.week_start
      return <tr key={row.week_start} className={`border-t border-border/70 ${isCurrent ? 'bg-accent/[0.035]' : ''}`}><td className="px-4 py-3 font-mono text-slate-600">{row.week_start} — {row.week_end}{isCurrent && <span className="ml-2 rounded bg-accent/10 px-1.5 py-0.5 font-sans text-[10px] text-accent">本周</span>}</td><td className="px-3 py-3 text-right text-slate-500">{exact(row.requests)}</td><td className="px-3 py-3 text-right text-slate-500">{fmt(row.input)}</td><td className="px-3 py-3 text-right text-slate-500">{fmt(row.output)}</td><td className="px-3 py-3 text-right text-slate-500">{fmt(row.cache_read)}</td><td className="px-4 py-3 text-right font-mono font-semibold text-slate-700" title={exact(row.total)}>{fmt(row.total)}</td></tr>
    })}</tbody></table></div>
  </section>
}

function SessionUsage({ rows }: { rows: TokenThreadStats[] }) {
  const leading = topSessions(rows)
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  return <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
    <div className="border-b border-border px-4 py-3"><h2 className="text-sm font-semibold text-slate-700">高用量会话</h2><p className="mt-0.5 text-[11px] text-slate-400">按 Token 总量排名 · Top {Math.min(rows.length, 6)}</p></div>
    {leading.length ? <div className="grid gap-3 p-4 lg:grid-cols-2">{leading.map((row) => {
      const metrics = [
        ['请求', exact(row.requests)],
        ['输入', fmt(row.input)],
        ['输出', fmt(row.output)],
        ['缓存', fmt(row.cache_read)],
        ['合计', fmt(row.total)],
        ['占比', `${pct(row.total, total).toFixed(1)}%`],
      ]
      return <article key={row.thread} className="min-w-0 rounded-lg border border-border/80 bg-slate-50/50 p-3">
        <div className="truncate text-xs font-medium text-slate-650" title={sessionTitle(row)}>{sessionTitle(row)}</div>
        <div className="mt-3 grid grid-cols-3 gap-x-2 gap-y-3 sm:grid-cols-6">{metrics.map(([label, value]) => <div key={label} className="min-w-0"><div className="text-[10px] text-slate-400">{label}</div><div className={`mt-0.5 truncate font-mono text-xs ${label === '合计' ? 'font-semibold text-slate-700' : 'text-slate-550'}`} title={label === '合计' ? exact(row.total) : value}>{value}</div></div>)}</div>
      </article>
    })}</div> : <div className="px-4 py-10 text-center text-sm text-slate-400">暂无会话数据</div>}
  </section>
}

export default function TokenStats() {
  const [range, setRange] = usePageState<DailyUsageRange>('tokenStats.range', 'week')
  const stats = useQuery({
    queryKey: queryKeys.tokenStats,
    queryFn: api.tokenStats,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  return <PageShell title="用量统计">
    {stats.isLoading && <div className="rounded-xl border border-border bg-surface p-10 text-center text-sm text-slate-400">正在加载用量数据…</div>}
    {stats.isError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-600">用量数据读取失败，请稍后重试。</div>}
    {stats.data && <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="累计请求" value={stats.data.all_time.requests} hint={`${exact(stats.data.all_time.requests)} 次`} tone="bg-[#718a80]" />
        <SummaryCard label="输入 Token" value={stats.data.all_time.input} hint={`本周 ${fmt(stats.data.current_week.input)}`} tone="bg-[#16a34a]" />
        <SummaryCard label="输出 Token" value={stats.data.all_time.output} hint={`本周 ${fmt(stats.data.current_week.output)}`} tone="bg-[#f97316]" />
        <SummaryCard label="缓存读取" value={stats.data.all_time.cache_read} hint={`命中率 ${stats.data.all_time.cache_hit_rate.toFixed(1)}%`} tone="bg-[#8b5cf6]" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2"><Composition title="累计构成" data={stats.data.all_time} /><Composition title="本周构成" data={stats.data.current_week} /></div>
      <UsageTrend rows={stats.data.days} range={range} setRange={setRange} currentWeek={stats.data.current_week} timestamp={stats.data.timestamp} />
      <WeeklyTable data={stats.data} />
      <SessionUsage rows={stats.data.threads} />
    </div>}
  </PageShell>
}
