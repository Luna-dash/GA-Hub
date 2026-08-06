import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'

const exactNf = new Intl.NumberFormat('zh-CN')
const compactNf = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })
const exact = (value: number) => exactNf.format(value || 0)
const fmt = (value: number) => Math.abs(value || 0) < 1_000 ? exact(value) : compactNf.format(value || 0).toLowerCase()
const stateMeta = {
  running: { label: '运行中', dot: 'bg-emerald-400', text: 'text-emerald-300', border: 'border-emerald-500/25' },
  ready: { label: '就绪', dot: 'bg-sky-400', text: 'text-sky-300', border: 'border-sky-500/25' },
  stopped: { label: '未运行', dot: 'bg-slate-500', text: 'text-slate-400', border: 'border-line' },
  error: { label: '异常', dot: 'bg-rose-400', text: 'text-rose-300', border: 'border-rose-500/30' },
} as const

export default function Dashboard() {
  const panel = useQuery({ queryKey: ['service-panel'], queryFn: api.servicePanel, refetchInterval: 8000 })
  const tokens = useQuery({ queryKey: ['token-stats'], queryFn: api.tokenStats, refetchInterval: 15000 })
  const services = panel.data?.services ?? []
  const healthy = services.filter((item) => item.state === 'running' || item.state === 'ready').length
  const totals = tokens.data?.totals

  return (
    <PageShell title="状态面板">
      <div className="p-5 space-y-6">
        <section className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Summary label="服务正常" value={`${healthy} / ${services.length || '—'}`} tone="text-emerald-300" />
          <Summary label="运行中" value={String(services.filter((item) => item.state === 'running').length)} />
          <Summary label="Token 总量" value={totals ? fmt(totals.total) : '—'} title={totals ? exact(totals.total) : undefined} tone="text-accent" />
          <Summary label="活跃线程" value={tokens.data?.available ? String(tokens.data.threads.length) : '—'} />
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-200">服务状态</h2>
            <span className="text-xs text-slate-500">每 8 秒刷新</span>
          </div>
          {panel.isError && <ErrorBox text="服务状态读取失败" />}
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
            {services.map((service) => <ServiceCard key={service.id} service={service} />)}
          </div>
        </section>

        <section className="rounded-xl border border-line bg-bg-card overflow-hidden">
          <div className="px-5 py-4 border-b border-line flex items-center justify-between">
            <div><h2 className="text-sm font-semibold text-slate-200">Token 统计</h2><p className="text-xs text-slate-500 mt-1">当前进程累计用量</p></div>
            <Link to="/tokens" className="text-xs text-accent hover:underline">查看完整统计 →</Link>
          </div>
          {tokens.isError ? <div className="p-5"><ErrorBox text="Token 统计读取失败" /></div> : !tokens.data?.available ? (
            <div className="p-5 text-sm text-slate-500">当前 Agent 尚未提供 Token 统计。</div>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-line">
              <TokenMetric label="输入" value={totals?.input ?? 0} />
              <TokenMetric label="输出" value={totals?.output ?? 0} />
              <TokenMetric label="缓存写入" value={totals?.cache_create ?? 0} />
              <TokenMetric label="缓存读取" value={totals?.cache_read ?? 0} />
            </div>
          )}
        </section>
      </div>
    </PageShell>
  )
}

function ServiceCard({ service }: { service: import('@/api/types').ServicePanelItem }) {
  const meta = stateMeta[service.state]
  return (
    <Link to={service.href} className={`rounded-xl border ${meta.border} bg-bg-card p-4 hover:bg-white/[0.035] transition block`}>
      <div className="flex items-start justify-between gap-3">
        <div><div className="text-sm font-semibold text-slate-200">{service.name}</div><div className="text-xs text-slate-500 mt-1">{service.summary}</div></div>
        <span className={`flex items-center gap-1.5 text-xs shrink-0 ${meta.text}`}><span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />{meta.label}</span>
      </div>
      <div className="mt-4 pt-3 border-t border-line/60 flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(service.metrics).map(([label, value]) => <span key={label} className="text-xs text-slate-500">{label} <b className="font-normal text-slate-300">{String(value)}</b></span>)}
        {service.error && <span className="text-xs text-rose-400 truncate" title={service.error}>{service.error}</span>}
      </div>
    </Link>
  )
}

function Summary({ label, value, title, tone = 'text-slate-100' }: { label: string; value: string; title?: string; tone?: string }) {
  return <div className="rounded-xl border border-line bg-bg-card px-4 py-3"><div className="text-xs text-slate-500">{label}</div><div title={title} className={`text-xl font-semibold tabular-nums mt-1 ${tone}`}>{value}</div></div>
}
function TokenMetric({ label, value }: { label: string; value: number }) {
  return <div className="px-5 py-4"><div className="text-xs text-slate-500">{label}</div><div title={exact(value)} className="font-mono text-base text-slate-200 mt-1">{fmt(value)}</div></div>
}
function ErrorBox({ text }: { text: string }) { return <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{text}</div> }
