import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '@/api/client'
import type { ServicePanelItem } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import {
  activeServices,
  attentionServices,
  dashboardVerdict,
  serviceActivityLabel,
  usefulMetrics,
} from '@/utils/dashboardUi'
import { queryKeys } from '@/queries/queryKeys'

const exactNf = new Intl.NumberFormat('zh-CN')
const compactNf = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function exact(value: number) { return exactNf.format(value) }
function fmt(value: number) { return value >= 1000 ? compactNf.format(value) : exact(value) }

const verdictTone = {
  good: 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300',
  busy: 'border-sky-500/25 bg-sky-500/5 text-sky-300',
  attention: 'border-amber-500/30 bg-amber-500/5 text-amber-300',
  unknown: 'border-slate-500/30 bg-slate-500/5 text-slate-300',
}

export default function Dashboard() {
  const panel = useQuery({
    queryKey: queryKeys.servicePanel,
    queryFn: api.servicePanel,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
  const tokens = useQuery({
    queryKey: queryKeys.tokenStats,
    queryFn: api.tokenStats,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  const services = panel.data?.services ?? []
  const attention = attentionServices(services)
  const active = activeServices(services)
  const verdict = dashboardVerdict(services)
  const totals = tokens.data?.totals
  const updatedAt = Math.max(panel.dataUpdatedAt, tokens.dataUpdatedAt)
  const refreshing = panel.isFetching || tokens.isFetching

  return (
    <PageShell
      title="状态面板"
      actions={updatedAt ? (
        <div className="flex items-center gap-2 text-[11px] text-slate-500 tabular-nums">
          <span className={`h-1.5 w-1.5 rounded-full ${refreshing ? 'bg-sky-400 animate-pulse' : 'bg-emerald-400'}`} />
          {refreshing ? '正在更新' : `${clock.format(updatedAt)} 更新`}
        </div>
      ) : undefined}
    >
      <div className="p-5 space-y-6">
        {panel.isError ? <ErrorBox text="服务状态读取失败，暂时无法判断系统是否可用。" /> : (
          <section className={`rounded-xl border px-5 py-4 ${verdictTone[verdict.tone]}`}>
            <div className="flex items-start gap-3">
              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${verdict.tone === 'attention' ? 'bg-amber-400 animate-pulse' : verdict.tone === 'busy' ? 'bg-sky-400 animate-pulse' : verdict.tone === 'good' ? 'bg-emerald-400' : 'bg-slate-400'}`} />
              <div><h2 className="font-medium text-base">{panel.isLoading ? '正在判断系统状态…' : verdict.title}</h2><p className="mt-1 text-xs opacity-75">{panel.isLoading ? '等待各模块返回运行状态' : verdict.detail}</p></div>
            </div>
          </section>
        )}

        {attention.length > 0 && (
          <section>
            <SectionTitle title="需要处理" hint="只在预期运行的模块停止，或状态无法读取时出现" />
            <div className="space-y-2">{attention.map((service) => <ActionRow key={service.id} service={service} />)}</div>
          </section>
        )}

        <section>
          <SectionTitle title="当前活动" hint="此刻正在执行、监听或调度的模块" />
          {active.length > 0 ? (
            <div className="flex flex-wrap gap-2">{active.map((service) => (
              <ServiceSurface key={service.id} service={service} className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-400 animate-pulse mr-2 align-middle" /><span className="text-sm text-slate-200">{service.name}</span><span className="ml-2 text-xs text-slate-500">{service.summary}</span>
              </ServiceSurface>
            ))}</div>
          ) : <p className="rounded-lg border border-border/70 bg-bg-panel/40 px-3 py-3 text-xs text-slate-500">当前没有后台活动；这不影响待命模块接收任务。</p>}
        </section>

        <section>
          <SectionTitle title="全部模块" hint="完整入口；未运行表示当前无活动，不等于故障" />
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
            {services.map((service) => <ServiceRow key={service.id} service={service} />)}
          </div>
          {!panel.isLoading && services.length === 0 && !panel.isError && <p className="text-xs text-slate-500">尚未返回模块信息。</p>}
        </section>

        {tokens.data?.available && totals && (
          <section>
            <SectionTitle title="Token 用量" hint="统计范围内的累计值，不代表当前并发请求" link="/tokens" />
            <div className="rounded-xl border border-border bg-bg-panel px-4 py-3 flex flex-wrap gap-x-7 gap-y-3">
              <TokenFact label="请求累计" value={totals.requests} />
              <TokenFact label="输入" value={totals.input} />
              <TokenFact label="输出" value={totals.output} />
              <TokenFact label="缓存读取" value={totals.cache_read} />
              {totals.cache_hit_rate > 0 && <TokenFact label="缓存命中" value={totals.cache_hit_rate} suffix="%" />}
            </div>
          </section>
        )}
        {tokens.isError && <ErrorBox text="Token 统计读取失败，不影响服务状态判断。" />}
      </div>
    </PageShell>
  )
}

function SectionTitle({ title, hint, link }: { title: string; hint: string; link?: string }) {
  return <div className="flex items-end justify-between gap-3 mb-3"><div><h2 className="text-sm font-medium text-slate-200">{title}</h2><p className="text-[11px] text-slate-500 mt-0.5">{hint}</p></div>{link && <Link to={link} className="text-xs text-accent hover:text-accent-hover shrink-0">查看详情 →</Link>}</div>
}

function ActionRow({ service }: { service: ServicePanelItem }) {
  const statusOnly = service.href === '/dashboard'
  return <ServiceSurface service={service} className="flex items-center justify-between gap-4 rounded-lg border border-amber-500/25 bg-amber-500/5 px-4 py-3"><div className="min-w-0"><div className="text-sm text-amber-200">{service.name}</div><p className="text-xs text-amber-300/70 truncate">{service.error || service.summary}</p></div>{!statusOnly && <span className="text-xs text-amber-300 shrink-0">前往查看 →</span>}</ServiceSurface>
}

function ServiceRow({ service }: { service: ServicePanelItem }) {
  const metrics = usefulMetrics(service)
  const needsAttention = service.health !== 'healthy'
  const dot = needsAttention ? 'bg-amber-400' : service.activity === 'active' ? 'bg-sky-400' : service.activity === 'standby' ? 'bg-emerald-400' : 'bg-slate-600'
  return (
    <ServiceSurface service={service} className={`rounded-lg border bg-bg-panel px-3 py-3 min-w-0 ${needsAttention ? 'border-amber-500/25' : 'border-border'}`}>
      <div className="flex items-center justify-between gap-3"><span className="flex items-center min-w-0"><span className={`h-2 w-2 rounded-full shrink-0 mr-2 ${dot}`} /><b className="text-sm font-medium text-slate-200 truncate">{service.name}</b></span><span className={`text-[11px] shrink-0 ${needsAttention ? 'text-amber-300' : 'text-slate-500'}`}>{serviceActivityLabel(service)}</span></div>
      <p className="mt-1 text-xs text-slate-500 truncate" title={service.error || service.summary}>{service.error || service.summary}</p>
      {metrics.length > 0 && <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">{metrics.map(([key, value]) => <span key={key} className="text-[10px] text-slate-600">{key} <b className="font-mono font-normal text-slate-400">{value === true ? '是' : String(value)}</b></span>)}</div>}
    </ServiceSurface>
  )
}

function ServiceSurface({ service, className, children }: { service: ServicePanelItem; className: string; children: ReactNode }) {
  if (service.href === '/dashboard') return <div className={className}>{children}</div>
  return <Link to={service.href} className={`${className} hover:bg-bg-hover transition-colors`}>{children}</Link>
}

function TokenFact({ label, value, suffix = '' }: { label: string; value: number; suffix?: string }) {
  return <div className="min-w-20"><div className="text-[11px] text-slate-500">{label}</div><div title={`${exact(value)}${suffix}`} className="font-mono text-sm text-slate-200 mt-0.5">{fmt(value)}{suffix}</div></div>
}

function ErrorBox({ text }: { text: string }) { return <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{text}</div> }
