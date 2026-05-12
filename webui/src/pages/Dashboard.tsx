import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api } from '@/api/client'
import { PageShell } from '@/components/PageShell'
import { Sparkline, bucketTimestamps } from '@/components/Sparkline'
import { useAgentStore } from '@/stores/agentStore'
import { relTime } from '@/utils/foldTurns'

const WINDOW_SEC = 60 * 60        // last hour
const BUCKETS = 30                // 2-minute resolution

export function Dashboard() {
  const recent = useAgentStore((s) => s.recent)
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: api.status,
    refetchInterval: 10000,
  })

  const a = status?.agent
  const w = status?.wechat
  const idleSec = a ? Math.max(0, Math.floor(Date.now() / 1000) - (a.last_reply_time || 0)) : 0

  // Derive sparkline series from `recent[]`. The buffer is capped at 200, so
  // for very chatty hours older buckets will undercount — that's OK for a
  // trend strip; current activity is what matters.
  const trends = useMemo(() => {
    const ts = (pred: (t: string) => boolean) =>
      recent.filter((e) => pred(e.topic)).map((e) => e.ts)
    return {
      agent: bucketTimestamps(ts((t) => /^agent:(submit|done|turn)/.test(t)), WINDOW_SEC, BUCKETS),
      wxIn:  bucketTimestamps(ts((t) => t === 'wechat:message_in'),           WINDOW_SEC, BUCKETS),
      wxOut: bucketTimestamps(ts((t) => t === 'wechat:message_out'),          WINDOW_SEC, BUCKETS),
      auto:  bucketTimestamps(ts((t) => t.startsWith('autonomous:')),         WINDOW_SEC, BUCKETS),
    }
  }, [recent])

  return (
    <PageShell title="仪表盘" description="实时观察 GenericAgent 与微信机器人的运行状态">
      <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <Card title="Agent 状态" tone={a?.is_running ? 'amber' : 'green'}
              footer={<TrendStrip label="活动" values={trends.agent} />}>
          <Stat label="运行" value={a?.is_running ? '运行中' : '空闲'} />
          <Stat label="LLM" value={a?.llm_name ?? '—'} />
          <Stat label="模型" value={a?.llm_model ?? '—'} />
          <Stat label="队列" value={String(a?.queued_tasks ?? 0)} />
          <Stat label="历史行" value={String(a?.history_lines ?? 0)} />
          <Stat label="空闲" value={a?.last_reply_time ? `${idleSec}s` : '—'} />
        </Card>

        <Card title="微信机器人" tone={w?.logged_in ? 'green' : 'red'}
              footer={
                <div className="space-y-1">
                  <TrendStrip label="收" values={trends.wxIn} />
                  <TrendStrip label="发" values={trends.wxOut} strokeClass="text-emerald-400" />
                </div>
              }>
          <Stat label="登录" value={w?.logged_in ? '在线' : '未登录'} />
          <Stat label="bot_id" value={w?.bot_id || '—'} mono />
          <Stat label="轮询" value={w?.polling ? '运行中' : '已停止'} />
          <Stat label="联系人" value={String(w?.contacts ?? 0)} />
          <Stat label="日志" value={String(w?.log_count ?? 0)} />
          <Stat label="白名单" value={(w?.allowlist || ['*']).join(', ')} />
          <div className="pt-2">
            <Link to="/wechat" className="text-accent text-sm hover:underline">→ 前往管理</Link>
          </div>
        </Card>

        <Card title="自主进化" tone="blue"
              footer={<TrendStrip label="触发" values={trends.auto} strokeClass="text-amber-400" />}>
          <div className="text-sm text-slate-400">
            <p>调度器运行中。可在 <Link to="/autonomous" className="text-accent hover:underline">自主进化</Link> 页配置：</p>
            <ul className="list-disc list-inside mt-2 space-y-0.5">
              <li>空闲触发 (idle_minutes)</li>
              <li>定时 (cron 表达式)</li>
              <li>周期 (interval_minutes)</li>
              <li>立即手动触发</li>
            </ul>
          </div>
        </Card>

        <Card title="最近事件" className="md:col-span-2 xl:col-span-3">
          <div className="space-y-1 text-sm font-mono max-h-72 overflow-y-auto">
            {recent.length === 0 && <div className="text-slate-500">尚无事件…</div>}
            {recent.slice(0, 60).map((e, i) => (
              <div key={i} className="flex items-baseline gap-3">
                <span className="text-slate-500 shrink-0">{relTime(Math.floor(e.ts))}</span>
                <span className="text-accent shrink-0 w-44 truncate">{e.topic}</span>
                <span className="text-slate-300 truncate">{JSON.stringify(e.payload)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </PageShell>
  )
}

function Card({ title, tone, footer, children, className = '' }: any) {
  const toneCls: Record<string, string> = {
    green: 'border-emerald-700/60',
    amber: 'border-amber-600/60',
    red: 'border-rose-700/60',
    blue: 'border-accent/60',
  }
  return (
    <div className={`rounded-xl border ${toneCls[tone] || 'border-line'} bg-bg-card p-4 ${className}`}>
      <div className="text-sm font-semibold text-slate-200 mb-3">{title}</div>
      <div className="space-y-1.5">{children}</div>
      {footer && <div className="mt-3 pt-3 border-t border-line/60">{footer}</div>}
    </div>
  )
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`text-slate-200 truncate ml-3 max-w-[60%] ${mono ? 'font-mono text-xs' : ''}`} title={value}>{value}</span>
    </div>
  )
}

function TrendStrip({ label, values, strokeClass }: {
  label: string
  values: number[]
  strokeClass?: string
}) {
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-slate-500 shrink-0">{label}</span>
      <Sparkline values={values} width={140} height={22} strokeClass={strokeClass} />
      <span className="text-slate-400 tabular-nums shrink-0 w-20 text-right">
        {total} <span className="text-slate-600">/ 1h</span>
      </span>
    </div>
  )
}
