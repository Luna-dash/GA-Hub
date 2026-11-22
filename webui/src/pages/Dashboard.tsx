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
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, RefreshIcon } from '@/components/ActionIcons'

const exactNf = new Intl.NumberFormat('zh-CN')
const compactNf = new Intl.NumberFormat('en', { notation: 'compact', compactDisplay: 'short', maximumSignificantDigits: 3 })
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

function exact(value: number) { return exactNf.format(value) }
function fmt(value: number) { return value >= 1000 ? compactNf.format(value) : exact(value) }

const verdictTone = {
  good: 'border-status-success-line bg-status-success-soft/80 text-status-success',
  busy: 'border-status-info-line bg-status-info-soft/80 text-status-info',
  attention: 'border-status-warning-line bg-status-warning-soft/85 text-status-warning',
  unknown: 'border-line bg-bg-card text-ink',
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
  const VerdictIcon = verdict.tone === 'attention' ? AlertTriangle : verdict.tone === 'busy' ? Activity : CheckCircle2

  return (
    <PageShell
      title="状态面板"
      actions={updatedAt ? (
        <div className="inline-flex items-center gap-2 rounded-full border border-line/75 bg-bg-soft/75 px-2.5 py-1 text-[11px] text-ink-faint tabular-nums">
          <span className={`h-1.5 w-1.5 rounded-full ${refreshing ? 'bg-status-info animate-pulse' : 'bg-status-success'}`} />
          {refreshing ? '正在更新' : `${clock.format(updatedAt)} 更新`}
        </div>
      ) : undefined}
    >
      <div className="p-5 sm:p-6 space-y-5 max-w-6xl mx-auto">
        {panel.isError ? <ErrorBox text="服务状态读取失败，暂时无法判断系统是否可用。" onRetry={() => { void panel.refetch() }} /> : (
          <section className={`ga-paper-card px-5 py-4 ${verdictTone[verdict.tone]}`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-current/20 bg-bg-card/65 ${verdict.tone === 'busy' ? 'animate-pulse' : ''}`}>
                  <VerdictIcon className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2 className="font-semibold text-base leading-snug">{panel.isLoading ? '正在判断系统状态…' : verdict.title}</h2>
                  <p className="mt-0.5 text-xs opacity-80">{panel.isLoading ? '等待各模块返回运行状态' : verdict.detail}</p>
                </div>
              </div>
              {!panel.isLoading && (
                <div className="flex items-center gap-3 text-xs tabular-nums shrink-0 rounded-lg border border-current/15 bg-bg-card/55 px-3 py-1.5">
                  <span>模块 <b>{services.length}</b></span>
                  <span className="opacity-35">·</span>
                  <span>活动 <b>{active.length}</b></span>
                  {attention.length > 0 && <>
                    <span className="opacity-35">·</span>
                    <span>待处理 <b>{attention.length}</b></span>
                  </>}
                </div>
              )}
            </div>
          </section>
        )}

        {attention.length > 0 && (
          <section>
            <SectionTitle title="需要处理" hint="异常或已停止的模块" />
            <div className="space-y-2">{attention.map((service) => <ActionRow key={service.id} service={service} />)}</div>
          </section>
        )}

        <section>
          <SectionTitle title="当前活动" hint="正在运行的模块" />
          {active.length > 0 ? (
            <div className="flex flex-wrap gap-2">{active.map((service) => (
              <ServiceSurface key={service.id} service={service} className="ga-paper-card inline-flex items-center border-status-info-line/85 px-3 py-2">
                <span className="inline-block h-2 w-2 rounded-full bg-status-info animate-pulse mr-2" /><span className="text-sm font-medium text-ink">{service.name}</span><span className="ml-2 text-xs text-ink-faint">{service.summary}</span>
              </ServiceSurface>
            ))}</div>
          ) : <p className="rounded-xl border border-dashed border-line/80 bg-bg-card/45 px-3.5 py-2.5 text-xs text-ink-faint">当前没有后台任务运行。</p>}
        </section>

        <section>
          <SectionTitle title="全部模块" hint="所有功能模块" />
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {services.map((service) => <ServiceRow key={service.id} service={service} />)}
          </div>
          {!panel.isLoading && services.length === 0 && !panel.isError && <p className="text-xs text-ink-faint">尚未返回模块信息。</p>}
        </section>

        {tokens.data?.available && totals && (
          <section>
            <SectionTitle title="Token 用量" hint="统计周期内累计" link="/tokens" />
            <div className="ga-paper-card px-4 py-3 grid grid-cols-2 sm:grid-cols-5 gap-3 divide-y sm:divide-y-0 sm:divide-x divide-line/35">
              <TokenFact label="请求累计" value={totals.requests} />
              <TokenFact label="输入" value={totals.input} indented />
              <TokenFact label="输出" value={totals.output} indented />
              <TokenFact label="缓存读取" value={totals.cache_read} indented />
              {totals.cache_hit_rate > 0 && <TokenFact label="缓存命中" value={totals.cache_hit_rate} suffix="%" indented />}
            </div>
          </section>
        )}
        {tokens.isError && <ErrorBox text="Token 统计读取失败，不影响服务状态判断。" onRetry={() => { void tokens.refetch() }} />}
      </div>
    </PageShell>
  )
}

function SectionTitle({ title, hint, link }: { title: string; hint: string; link?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <span className="text-[11px] text-ink-faint truncate">{hint}</span>
      </div>
      {link && (
        <Link to={link} className="ga-btn-link shrink-0">
          <span>查看详情</span>
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      )}
    </div>
  )
}

function ActionRow({ service }: { service: ServicePanelItem }) {
  const statusOnly = service.href === '/dashboard'
  return <ServiceSurface service={service} className="ga-paper-card flex items-center justify-between gap-4 border-status-warning-line bg-status-warning-soft/85 px-4 py-3"><div className="min-w-0"><div className="text-sm font-medium text-status-warning">{service.name}</div><p className="text-xs text-status-warning/90 truncate">{service.error || service.summary}</p></div>{!statusOnly && <span className="inline-flex items-center gap-1 text-xs font-medium text-status-warning shrink-0" title="前往处理"><ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></span>}</ServiceSurface>
}

function ServiceRow({ service }: { service: ServicePanelItem }) {
  const metrics = usefulMetrics(service)
  const needsAttention = service.health !== 'healthy'
  const dot = needsAttention ? 'bg-status-warning' : service.activity === 'active' ? 'bg-status-info' : service.activity === 'standby' ? 'bg-status-success' : 'bg-ink-faint'
  return (
    <ServiceSurface service={service} className={`ga-paper-card px-3.5 py-3 min-w-0 flex flex-col justify-between gap-2.5 ${needsAttention ? 'border-status-warning-line border-l-[3px] border-l-status-warning' : ''}`}>
      <div>
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center min-w-0">
            <span className={`h-2 w-2 rounded-full shrink-0 mr-2 ${dot}`} />
            <b className="text-sm font-medium text-ink truncate">{service.name}</b>
          </span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium shrink-0 border ${
            needsAttention
              ? 'border-status-warning-line bg-status-warning-soft text-status-warning'
              : service.activity === 'active'
                ? 'border-status-info-line bg-status-info-soft text-status-info'
                : 'border-line/50 bg-bg-soft text-ink-faint'
          }`}>
            {serviceActivityLabel(service)}
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-faint truncate" title={service.error || service.summary}>{service.error || service.summary}</p>
      </div>
      {metrics.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {metrics.map(([key, value]) => (
            <span key={key} className="inline-flex items-center gap-1 rounded-md bg-bg-soft/80 px-2 py-0.5 text-[11px] text-ink-faint">
              <span>{key}</span>
              <b className="font-mono font-normal text-ink-muted">{value === true ? '是' : String(value)}</b>
            </span>
          ))}
        </div>
      )}
    </ServiceSurface>
  )
}

function ServiceSurface({ service, className, children }: { service: ServicePanelItem; className: string; children: ReactNode }) {
  if (service.href === '/dashboard') return <div className={className}>{children}</div>
  const displayClass = /\b(flex|inline-flex|grid|inline-block|block)\b/.test(className) ? '' : 'block '
  return <Link to={service.href} className={`${displayClass}${className} hover:bg-bg-soft/85 transition-colors`}>{children}</Link>
}

function TokenFact({ label, value, suffix = '', indented = false }: { label: string; value: number; suffix?: string; indented?: boolean }) {
  return (
    <div className={`min-w-0 pt-2 sm:pt-0 ${indented ? 'sm:pl-4' : ''}`}>
      <div className="text-[11px] text-ink-faint">{label}</div>
      <div title={`${exact(value)}${suffix}`} className="font-mono tabular-nums text-base font-semibold text-ink mt-0.5">{fmt(value)}{suffix}</div>
    </div>
  )
}

function ErrorBox({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 rounded-xl border border-status-danger-line bg-status-danger-soft px-3.5 py-2.5 text-xs text-status-danger">
      <span>{text}</span>
      {onRetry && <button type="button" onClick={onRetry} className="ga-btn-sm shrink-0"><RefreshIcon size={12} /><span>重试</span></button>}
    </div>
  )
}
