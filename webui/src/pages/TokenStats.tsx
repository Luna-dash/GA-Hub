import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import type { TokenDayStats, TokenStatsResponse, TokenThreadStats, TokenTotals } from '@/api/types'
import { compactTokens, sessionTitle, sumUsage, topSessions, usageAxis, usageRangeDays, visibleWeeks, type DailyUsageRange } from '@/utils/tokenStatsUi'
import { queryKeys } from '@/queries/queryKeys'
import { usePageState } from '@/utils/pageState'
import '@/styles/token-stats.css'

const exact = (value: number) => value.toLocaleString('zh-CN')
const percent = (value: number) => `${value.toFixed(1)}%`
const ranges: { value: DailyUsageRange; label: string }[] = [
  { value: '7d', label: '近 7 日' }, { value: '30d', label: '近 30 日' }, { value: 'week', label: '本周' },
]
const parts = [
  { key: 'input', label: '输入', color: '#748574' },
  { key: 'output', label: '输出', color: '#aa8959' },
  { key: 'cache_read', label: '缓存读取', color: '#758d9a' },
  { key: 'cache_create', label: '缓存写入', color: '#918196' },
] as const

function Metric({ label, value, title }: { label: string; value: string; title?: string }) {
  return <article className="token-card token-metric" title={title}>
    <div className="token-eyebrow">{label}</div>
    <div className="token-metric-value">{value}</div>
  </article>
}

function Composition({ data, date, onReset }: { data: TokenTotals; date?: string; onReset: () => void }) {
  const componentTotal = parts.reduce((sum, part) => sum + data[part.key], 0)
  let cursor = 0
  const stops = parts.map(part => {
    const start = cursor
    cursor += componentTotal > 0 ? data[part.key] / componentTotal * 100 : 0
    return `${part.color} ${start}% ${cursor}%`
  })
  return <section className="token-card token-composition" aria-label={`${date ?? '所选区间'} Token 构成`}>
    <header className="token-section-header"><div className="token-composition-heading"><h2>Token 构成</h2><span className="token-note">{date ?? '区间汇总'}</span></div>{date && <button className="token-text-button" onClick={onReset}>区间汇总</button>}</header>
    <div className="token-donut" role="img" aria-label={componentTotal ? parts.map(p => `${p.label} ${exact(data[p.key])}`).join('，') : '暂无用量'} style={{ background: componentTotal ? `conic-gradient(${stops.join(',')})` : 'var(--c-bg-soft)' }}>
      <div className="token-donut-center"><strong>{compactTokens(data.total)}</strong><span>总 Tokens</span></div>
    </div>
    <div className="token-composition-list">{parts.map(part => <div key={part.key}>
      <span className="token-part-label"><i style={{ backgroundColor: part.color }} />{part.label}</span>
      <strong title={exact(data[part.key])}>{compactTokens(data[part.key])}</strong>
      <span className="token-note">{percent(componentTotal ? data[part.key] / componentTotal * 100 : 0)}</span>
    </div>)}</div>
  </section>
}

function UsageTrend({ rows, today, activeDate, onSelect }: { rows: TokenDayStats[]; today: string; activeDate: string | null; onSelect: (date: string) => void }) {
  const active = rows.find(row => row.date === activeDate) ?? rows[rows.length - 1]
  const width = 760, height = 228, left = 57, right = 16, top = 18, bottom = 36
  const plotHeight = height - top - bottom
  const ticks = usageAxis(Math.max(0, ...rows.map(row => row.total)))
  const ceiling = ticks[ticks.length - 1]
  const step = (width - left - right) / Math.max(rows.length, 1)
  const barWidth = Math.min(48, step * .58)
  const y = (value: number) => top + plotHeight * (1 - value / ceiling)
  const hasUsage = rows.some(row => row.total > 0)
  return <section className="token-card token-trend" aria-label="每日用量趋势">
    <header className="token-section-header"><h2>每日用量趋势</h2><span className="token-chart-key"><i />总 Tokens</span></header>
    <div className="token-chart-scroll">
      <svg className={rows.length > 7 ? 'token-chart token-chart-long' : 'token-chart'} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="每日 Token 用量柱状图">
        {ticks.map(tick => <g key={tick}><line x1={left} y1={y(tick)} x2={width - right} y2={y(tick)} className="token-grid-line" /><text x={left - 10} y={y(tick) + 4} textAnchor="end" className="token-axis-label">{compactTokens(tick)}</text></g>)}
        {rows.map((row, index) => {
          const center = left + step * (index + .5)
          const isToday = row.date === today
          const selected = row.date === activeDate
          const description = `${row.date}${isToday ? ' 今日，未结束' : ''}：${exact(row.total)} Tokens，${exact(row.requests)} 次请求`
          return <g key={row.date}>
            <rect x={center - barWidth / 2} y={row.total ? y(row.total) : y(0) - 2} width={barWidth} height={row.total ? plotHeight * row.total / ceiling : 2} rx="3" className={`token-bar${isToday ? ' token-bar-today' : ''}${selected ? ' token-bar-active' : ''}${row.total === 0 ? ' token-bar-zero' : ''}`} />
            <rect x={center - step / 2 + 1} y={top} width={Math.max(step - 2, 1)} height={plotHeight + 5} fill="transparent" tabIndex={0} role="button" aria-label={description} aria-pressed={selected} onMouseEnter={() => onSelect(row.date)} onFocus={() => onSelect(row.date)} onClick={() => onSelect(row.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row.date) } }} className="token-bar-hit"><title>{description}\n{parts.map(p => `${p.label}：${exact(row[p.key])}`).join('\n')}</title></rect>
            {(rows.length <= 7 || index % 5 === 0 || index === rows.length - 1) && <text x={center} y={height - 12} textAnchor="middle" className={`token-axis-label${isToday ? ' token-axis-today' : ''}`}>{isToday ? '今日' : row.date.slice(5).replace('-', '/')}</text>}
          </g>
        })}
      </svg>
    </div>
    {active && <div className="token-day-detail" aria-live="polite">
      <div className="token-day-summary"><span>{active.date}{active.date === today && <small>今日 · 未结束</small>}</span><strong>{exact(active.total)} <span>Tokens</span></strong><span className="token-note">{exact(active.requests)} 次请求</span></div>
      <div className="token-day-parts">{parts.map(part => <span key={part.key}><i style={{ background: part.color }} />{part.label} <b>{exact(active[part.key])}</b></span>)}</div>
    </div>}
    {!hasUsage && <p className="token-note token-chart-foot">所选区间暂无用量</p>}
  </section>
}

function WeeklyTable({ data }: { data: TokenStatsResponse }) {
  const [expanded, setExpanded] = useState(false)
  const rows = visibleWeeks(data.weeks, expanded)
  return <section className="token-card token-weekly">
    <header className="token-section-header"><h2>自然周统计</h2>{data.weeks.length > 6 && <button className="token-text-button" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `全部 ${data.weeks.length} 周`}</button>}</header>
    <div className="token-table-scroll"><table className="token-table"><thead><tr><th>周期</th><th>请求</th><th>输入</th><th>输出</th><th>缓存写入</th><th>缓存读取</th><th>总 Tokens</th><th>缓存命中率</th></tr></thead>
      <tbody>{rows.length ? rows.map(row => <tr key={row.week_start} className={row.week_start === data.current_week.week_start ? 'token-week-current' : ''}>
        <td><span>{row.week_start} — {row.week_end}</span>{row.week_start === data.current_week.week_start && <small className="token-badge">进行中</small>}</td>
        <td>{exact(row.requests)}</td>{(['input', 'output', 'cache_create', 'cache_read', 'total'] as const).map(key => <td key={key} title={exact(row[key])}>{compactTokens(row[key])}</td>)}<td>{percent(row.cache_hit_rate)}</td>
      </tr>) : <tr><td colSpan={8} className="token-empty">暂无周统计</td></tr>}</tbody>
    </table></div>
  </section>
}

function SessionUsage({ rows, allTime }: { rows: TokenThreadStats[]; allTime: number }) {
  const leading = topSessions(rows)
  const maximum = Math.max(1, ...leading.map(row => row.total))
  return <section className="token-card token-sessions">
    <header className="token-section-header"><div><h2>累计高用量会话</h2><p className="token-note">不随上方区间筛选</p></div><span className="token-note">Top {leading.length}</span></header>
    {leading.length ? <div className="token-session-list">{leading.map((row, index) => <article className="token-session-row" key={row.thread}>
      <span className="token-session-rank">{String(index + 1).padStart(2, '0')}</span>
      <div className="token-session-main"><h3 title={`${sessionTitle(row)} · ${row.thread}`}>{sessionTitle(row)}</h3><div className="token-session-track"><div style={{ width: `${row.total / maximum * 100}%` }} /></div><p className="token-note">{exact(row.requests)} 次请求 · 缓存命中 {percent(row.cache_hit_rate)}</p></div>
      <div className="token-session-value"><strong title={exact(row.total)}>{compactTokens(row.total)}</strong><span className="token-note">占累计 {percent(allTime > 0 ? row.total / allTime * 100 : 0)}</span></div>
    </article>)}</div> : <div className="token-empty">暂无会话数据</div>}
  </section>
}

export default function TokenStats() {
  // New key makes the redesigned page default to rolling 7d even if the old
  // page persisted its default natural-week selection in sessionStorage.
  const [range, setRange] = usePageState<DailyUsageRange>('tokenStats.range.v2', '7d')
  const [activeDate, setActiveDate] = useState<string | null>(null)
  const stats = useQuery({ queryKey: queryKeys.tokenStats, queryFn: api.tokenStats, refetchInterval: 5000 })
  const data = stats.data
  const shown = data ? usageRangeDays(data.days, range, data.current_week, data.timestamp) : []
  const totals = sumUsage(shown)
  const selectedDay = shown.find(row => row.date === activeDate)
  const today = shown[shown.length - 1]?.date ?? ''
  return <PageShell title="用量统计">
    <div className="token-stats">
      {stats.isLoading && <div className="token-card token-empty" role="status">正在读取用量统计…</div>}
      {stats.isError && <div className="token-card token-error" role="alert"><span>用量统计加载失败，请稍后重试。</span><button className="token-text-button" onClick={() => void stats.refetch()}>重新加载</button></div>}
      {data?.available === false && <div className="token-card token-empty">Token 统计尚未就绪，发生请求后会在这里显示。</div>}
      {data?.available && <>
        <div className="token-toolbar"><div><span className="token-eyebrow">用量概览</span><p className="token-note">{shown[0]?.date} — {today} · 更新于 {new Date(data.timestamp * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p></div><div className="token-range-control" role="group" aria-label="统计区间">{ranges.map(item => <button key={item.value} aria-pressed={range === item.value} onClick={() => { setRange(item.value); setActiveDate(null) }}>{item.label}</button>)}</div></div>
        <div className="token-metrics">
          <Metric label="总 Tokens" value={compactTokens(totals.total)} title={`${exact(totals.total)} · 含缓存读写`} />
          <Metric label="请求次数" value={exact(totals.requests)} />
          <Metric label="日均用量" value={compactTokens(totals.total / Math.max(shown.length, 1))} title={`按 ${shown.length} 个日历日计算 · 含今日`} />
          <Metric label="缓存命中率" value={percent(totals.cache_hit_rate)} title="读取 ÷（输入 + 缓存读写）" />
        </div>
        <div className="token-cumulative"><span>累计概览</span><strong title={exact(data.all_time.total)}>{compactTokens(data.all_time.total)} Tokens</strong><span>{exact(data.all_time.requests)} 次请求</span><span>缓存命中 {percent(data.all_time.cache_hit_rate)}</span></div>
        <div className="token-chart-layout"><UsageTrend rows={shown} today={today} activeDate={selectedDay?.date ?? null} onSelect={setActiveDate} /><Composition data={selectedDay ?? totals} date={selectedDay?.date} onReset={() => setActiveDate(null)} /></div>
        <WeeklyTable data={data} />
        <SessionUsage rows={data.threads} allTime={data.all_time.total} />
      </>}
    </div>
  </PageShell>
}
