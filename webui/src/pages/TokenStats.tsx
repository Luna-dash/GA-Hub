import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'

const exactNf = new Intl.NumberFormat('zh-CN')
const compactNf = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })
const exact = (n: number) => exactNf.format(n || 0)
const fmt = (n: number) => Math.abs(n || 0) < 1_000 ? exact(n) : compactNf.format(n || 0).toLowerCase()
const age = (seconds: number) => seconds < 60 ? `${Math.round(seconds)} 秒` : seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`

export default function TokenStats() {
  const stats = useQuery({ queryKey: ['tokens.stats'], queryFn: api.tokenStats, refetchInterval: 5000 })
  const history = useQuery({ queryKey: ['tokens.history', 24], queryFn: () => api.tokenHistory(24), refetchInterval: 60000 })
  const data = stats.data
  const totals = data?.current_week
  const weeks = data?.weeks ?? []
  const points = history.data?.history ?? []
  const maxTotal = Math.max(1, ...points.map((p) => p.total))

  return (
    <PageShell title="Token 统计" description="Token 用量持久化累计，并按自然周（周一至周日）展示；线程明细为本次运行。"
      actions={<button className="btn-secondary" onClick={() => { stats.refetch(); history.refetch() }}>刷新</button>}>
      <div className="max-w-6xl mx-auto p-6 space-y-6">
        {stats.isError && <div className="card p-4 text-red-300">读取统计失败：{String(stats.error)}</div>}
        {data && !data.available && <div className="card p-4 text-amber-300">当前 GA 版本未提供 cost_tracker，统计暂不可用。</div>}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            ['总 Token', totals?.total], ['请求数', totals?.requests],
            ['输入 Token', totals?.input], ['输出 Token', totals?.output],
            ['缓存创建', totals?.cache_create], ['缓存读取', totals?.cache_read],
          ].map(([label, value]) => <div key={String(label)} className="card p-4">
            <div className="text-xs text-slate-400 mb-2">{label}</div>
            <div className="text-2xl font-mono text-slate-100" title={exact(Number(value ?? 0))}>{fmt(Number(value ?? 0))}</div>
          </div>)}
          <div className="card p-4 col-span-2 lg:col-span-1">
            <div className="text-xs text-slate-400 mb-2">缓存命中率</div>
            <div className="text-2xl font-mono text-accent">{(totals?.cache_hit_rate ?? 0).toFixed(1)}%</div>
          </div>
        </div>

        <section className="card p-5">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-sm font-semibold text-slate-200">24 小时趋势</h2>
            <span className="text-xs text-slate-500">{points.length} 个采样点</span>
          </div>
          {points.length < 2 ? <div className="h-32 flex items-center justify-center text-sm text-slate-500">数据积累中，至少需要两个采样点</div> :
            <div className="h-36 flex items-end gap-px border-b border-white/10" title="柱高表示累计总 Token">
              {points.map((p, i) => <div key={`${p.timestamp}-${i}`} className="flex-1 min-w-px bg-accent/70 hover:bg-accent rounded-t-sm"
                style={{ height: `${Math.max(2, p.total / maxTotal * 100)}%` }}
                title={`${new Date(p.timestamp * 1000).toLocaleString()} · ${exact(p.total)} Token`} />)}
            </div>}
        </section>

        <section className="card overflow-hidden">
          <div className="p-5 border-b border-white/10 flex justify-between">
            <h2 className="text-sm font-semibold text-slate-200">自然周累计</h2>
            <span className="text-xs text-slate-500">周一至周日 · 跨重启保留</span>
          </div>
          {!weeks.length ? <div className="p-8 text-center text-sm text-slate-500">本周尚无 Token 记录。</div> :
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-xs text-slate-500 border-b border-white/10"><tr>{['周期', '请求', '输入', '输出', '缓存读取', '总计', '命中率'].map((h) => <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>{[...weeks].reverse().map((row) => <tr key={row.week_start} className="border-b border-white/5 last:border-0 hover:bg-white/[.03]">
              <td className="px-4 py-3 font-mono text-xs text-slate-300">{row.week_start} — {row.week_end}</td><td className="px-4 py-3">{fmt(row.requests)}</td><td className="px-4 py-3">{fmt(row.input)}</td><td className="px-4 py-3">{fmt(row.output)}</td><td className="px-4 py-3">{fmt(row.cache_read)}</td><td className="px-4 py-3 font-mono text-accent">{fmt(row.total)}</td><td className="px-4 py-3">{row.cache_hit_rate.toFixed(1)}%</td>
            </tr>)}</tbody>
          </table></div>}
        </section>

        <section className="card overflow-hidden">
          <div className="p-5 border-b border-white/10 flex justify-between"><h2 className="text-sm font-semibold text-slate-200">线程明细</h2><span className="text-xs text-slate-500">每 5 秒刷新</span></div>
          {!data?.threads.length ? <div className="p-8 text-center text-sm text-slate-500">尚无 Token 记录；下一次 LLM 调用后会显示。</div> :
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-xs text-slate-500 border-b border-white/10"><tr>{['线程', '请求', '输入', '输出', '缓存读取', '总计', '运行时间'].map((h) => <th key={h} className="px-4 py-3 text-left font-medium">{h}</th>)}</tr></thead>
            <tbody>{data.threads.map((row) => <tr key={row.thread} className="border-b border-white/5 last:border-0 hover:bg-white/[.03]">
              <td className="px-4 py-3 font-mono text-xs text-slate-300">{row.thread}</td><td className="px-4 py-3">{fmt(row.requests)}</td><td className="px-4 py-3">{fmt(row.input)}</td><td className="px-4 py-3">{fmt(row.output)}</td><td className="px-4 py-3">{fmt(row.cache_read)} <span className="text-xs text-slate-500">({row.cache_hit_rate.toFixed(1)}%)</span></td><td className="px-4 py-3 font-mono text-accent">{fmt(row.total)}</td><td className="px-4 py-3 text-slate-400">{age(row.elapsed_seconds)}</td>
            </tr>)}</tbody>
          </table></div>}
        </section>
      </div>
    </PageShell>
  )
}
