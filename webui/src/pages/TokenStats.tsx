import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import type { TokenTotals } from '@/api/types'

const exactNf = new Intl.NumberFormat('zh-CN')
const compactNf = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })
const exact = (n: number) => exactNf.format(n || 0)
const fmt = (n: number) => Math.abs(n || 0) < 1_000 ? exact(n) : compactNf.format(n || 0).toLowerCase()

function Metric({ label, value, hint, accent = false, suffix = '' }: { label: string; value: number; hint: string; accent?: boolean; suffix?: string }) {
  return <div className="min-w-0 border-r border-line/70 last:border-r-0 px-5 py-4">
    <div className="text-xs text-slate-500">{label}</div>
    <div className={`mt-2 truncate font-mono text-2xl font-semibold ${accent ? 'text-accent' : 'text-[#2C2418]'}`} title={`${exact(value)}${suffix}`}>{suffix ? value.toFixed(1) : fmt(value)}{suffix}</div>
    <div className="mt-1 text-[11px] text-slate-400">{hint}</div>
  </div>
}

function Breakdown({ totals }: { totals?: TokenTotals }) {
  const rows = [
    ['输入 Token', totals?.input ?? 0],
    ['输出 Token', totals?.output ?? 0],
    ['缓存创建', totals?.cache_create ?? 0],
    ['缓存读取', totals?.cache_read ?? 0],
  ] as const
  const maximum = Math.max(1, ...rows.map(([, value]) => value))
  return <div className="grid gap-4 sm:grid-cols-2">
    {rows.map(([label, value]) => <div key={label}>
      <div className="mb-1.5 flex items-center justify-between gap-4 text-xs"><span className="text-slate-500">{label}</span><span className="font-mono text-[#2C2418]" title={exact(value)}>{fmt(value)}</span></div>
      <div className="h-1.5 overflow-hidden rounded-full bg-black/[.06]"><div className="h-full rounded-full bg-accent/75" style={{ width: `${Math.max(value ? 3 : 0, value / maximum * 100)}%` }} /></div>
    </div>)}
  </div>
}

export default function TokenStats() {
  const stats = useQuery({ queryKey: ['tokens.stats'], queryFn: api.tokenStats, refetchInterval: 15000 })
  const data = stats.data
  const allTime = data?.all_time
  const currentWeek = data?.current_week
  const weeks = [...(data?.weeks ?? [])].reverse()

  return <PageShell title="用量统计" actions={<button className="btn-secondary" onClick={() => stats.refetch()} disabled={stats.isFetching}>{stats.isFetching ? '刷新中…' : '刷新'}</button>}>
    <div className="mx-auto max-w-6xl p-6">
      {stats.isError && <div className="card mb-4 p-4 text-red-600">读取统计失败：{String(stats.error)}</div>}
      {data && !data.available && <div className="card mb-4 p-4 text-amber-700">当前 GA 版本未提供用量追踪，累计数据暂不可更新。</div>}

      <section className="card overflow-hidden">
        <div className="border-b border-line/70 px-5 py-4">
          <div className="flex items-end justify-between gap-4">
            <div><h2 className="text-sm font-semibold text-[#2C2418]">累计用量</h2><p className="mt-1 text-xs text-slate-500">数据持续保存在本地，刷新页面或重启服务不会归零。</p></div>
            <span className="shrink-0 rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-700">已固化</span>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4">
          <Metric label="累计 Token" value={allTime?.total ?? 0} hint="全部已记录周期" accent />
          <Metric label="本周 Token" value={currentWeek?.total ?? 0} hint={`${currentWeek?.week_start ?? '—'} 至 ${currentWeek?.week_end ?? '—'}`} />
          <Metric label="累计请求" value={allTime?.requests ?? 0} hint="已完成的模型请求" />
          <Metric label="缓存命中率" value={allTime?.cache_hit_rate ?? 0} suffix="%" hint="缓存读取 / 输入侧" />
        </div>
      </section>

      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_1.45fr]">
        <section className="card p-5">
          <div className="mb-5"><h2 className="text-sm font-semibold text-[#2C2418]">累计构成</h2><p className="mt-1 text-xs text-slate-500">各类 Token 的长期累计值</p></div>
          <Breakdown totals={allTime} />
        </section>
        <section className="card p-5">
          <div className="mb-5 flex items-start justify-between gap-4"><div><h2 className="text-sm font-semibold text-[#2C2418]">本周用量</h2><p className="mt-1 text-xs text-slate-500">自然周按周一至周日统计</p></div><div className="text-right"><div className="font-mono text-lg font-semibold text-accent" title={exact(currentWeek?.total ?? 0)}>{fmt(currentWeek?.total ?? 0)}</div><div className="text-[11px] text-slate-400">Token</div></div></div>
          <Breakdown totals={currentWeek} />
        </section>
      </div>

      <section className="card mt-4 overflow-hidden">
        <div className="flex items-center justify-between border-b border-line/70 px-5 py-4"><div><h2 className="text-sm font-semibold text-[#2C2418]">周期记录</h2><p className="mt-1 text-xs text-slate-500">历史累计按自然周归档</p></div><span className="text-xs text-slate-400">共 {weeks.length} 周</span></div>
        {!weeks.length ? <div className="p-10 text-center text-sm text-slate-500">尚无 Token 记录。</div> : <div className="overflow-x-auto"><table className="w-full table-fixed text-sm">
          <thead className="border-b border-line/70 bg-black/[.015] text-xs text-slate-500"><tr><th className="w-[29%] px-5 py-3 text-left font-medium">周期</th><th className="px-3 py-3 text-right font-medium">请求</th><th className="px-3 py-3 text-right font-medium">输入</th><th className="px-3 py-3 text-right font-medium">输出</th><th className="px-3 py-3 text-right font-medium">缓存读取</th><th className="px-3 py-3 text-right font-medium">总计</th><th className="w-[10%] px-5 py-3 text-right font-medium">命中率</th></tr></thead>
          <tbody>{weeks.map((row) => <tr key={row.week_start} className="border-b border-line/50 last:border-0 hover:bg-black/[.02]"><td className="px-5 py-3 font-mono text-xs text-slate-600">{row.week_start} — {row.week_end}</td><td className="px-3 py-3 text-right">{fmt(row.requests)}</td><td className="px-3 py-3 text-right">{fmt(row.input)}</td><td className="px-3 py-3 text-right">{fmt(row.output)}</td><td className="px-3 py-3 text-right">{fmt(row.cache_read)}</td><td className="px-3 py-3 text-right font-mono font-medium text-accent" title={exact(row.total)}>{fmt(row.total)}</td><td className="px-5 py-3 text-right">{row.cache_hit_rate.toFixed(1)}%</td></tr>)}</tbody>
        </table></div>}
      </section>
    </div>
  </PageShell>
}
