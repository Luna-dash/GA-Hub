import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation } from '@tanstack/react-query'
import { Gauge, LoaderCircle } from 'lucide-react'
import clsx from 'clsx'
import type { components } from '@/api/generated/schema'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Usage = components['schemas']['AntiAccountUsage']

async function checkUsage(): Promise<Usage> {
  const response = await fetch(resolveApiUrl('/api/anti/account-usage'), {
    method: 'POST',
    headers: { 'X-GA-Hub-Action': 'check-anti-usage' },
  })
  if (!response.ok) {
    if (response.status === 404 || response.status === 405) {
      throw new Error('当前 GA-Hub 后端版本不支持额度检测，请更新后端后重试。')
    }
    if (response.status === 403) throw new Error('当前页面无权发起额度检测，请从 GA-Hub 页面重试。')
    const report = await response.json().catch(() => null)
    throw new Error(typeof report?.detail === 'string' ? report.detail : '检测失败，请重试。')
  }
  return response.json()
}

const resetFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function limitLabel(limit: string) {
  if (limit === 'Weekly Limit Remaining') return '每周额度'
  if (limit === 'Five Hour Limit Remaining') return '5 小时额度'
  if (limit.endsWith(' Weekly Limit')) return '每周额度'
  return limit
}

export function AntiAccountUsageButton({ running, onChecked }: { running: boolean; onChecked: () => void }) {
  const usage = useMutation({ mutationFn: checkUsage, onSettled: onChecked })
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const tooltipId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [tapped, setTapped] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number }>()
  const open = (hovered || focused || tapped) && !dismissed
  useLayoutEffect(() => {
    if (!open) return
    const update = () => {
      const anchor = button.current?.getBoundingClientRect()
      if (!anchor) return
      const width = Math.min(272, window.innerWidth - 16)
      setPosition({ top: anchor.bottom, left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
        maxHeight: Math.max(0, window.innerHeight - anchor.bottom - 16) })
    }
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !button.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        setTapped(false)
      }
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', outside)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', outside)
    }
  }, [open])
  const rows = running ? usage.data?.rows : undefined
  const message = !running ? '请先启动 Anti 网关。'
    : usage.isPending ? '正在检测官方额度…'
    : usage.isError ? usage.error.message
    : usage.data?.state === 'login_required' ? '请先登录 agy，再重新检测。'
    : usage.data ? '未能读取官方额度，请重试。'
    : '点击检测官方剩余额度。'
  const Icon = usage.isPending ? LoaderCircle : Gauge

  return (
    <div
      className="relative inline-flex"
      onMouseEnter={() => { setHovered(true); setDismissed(false) }}
      onMouseLeave={() => { setHovered(false); setTapped(false) }}
    >
      <button
        ref={button}
        type="button"
        aria-label="检测反重力额度"
        aria-describedby={open ? tooltipId : undefined}
        aria-disabled={!running || usage.isPending}
        className={clsx('inline-flex size-8 items-center justify-center rounded-lg border focus-visible:outline focus-visible:outline-2',
          rows?.length ? 'border-line bg-bg-card text-ink' : 'border-line bg-bg-card text-ink-muted',
          running && !usage.isPending ? 'hover:bg-bg-soft' : 'cursor-default opacity-65')}
        onFocus={event => { setFocused(event.currentTarget.matches(':focus-visible')); setDismissed(false) }}
        onBlur={() => setFocused(false)}
        onKeyDown={event => { if (event.key === 'Escape') { setTapped(false); setDismissed(true) } }}
        onClick={() => {
          if (!hovered && !focused) setTapped(true)
          setDismissed(false)
          if (running && !usage.isPending) usage.mutate()
        }}
      >
        <Icon size={16} aria-hidden="true" className={clsx(usage.isPending && 'motion-safe:animate-spin')} />
      </button>
      {open && position && createPortal(
        <div ref={panel} className="fixed z-[60] w-[min(17rem,calc(100vw-16px))] pt-2" style={{ top: position.top, left: position.left }}>
          <div id={tooltipId} role="tooltip" className="overflow-y-auto overscroll-contain rounded-xl border border-line bg-bg-card p-3 text-xs text-ink shadow-lg" style={{ maxHeight: position.maxHeight }}>
            <div className="font-semibold">反重力剩余额度</div>
            {rows?.length ? (
              <ul className="mt-1 divide-y divide-line">
                {rows.map(row => (
                  <li key={`${row.model}-${row.limit}`} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 py-1.5">
                    <span className="min-w-0 break-words font-medium">{row.model}</span>
                    <span className="text-right font-semibold tabular-nums">{row.remaining_pct}%</span>
                    <span className="text-ink-muted">{limitLabel(row.limit)}</span>
                    <time dateTime={row.resets_at} className="text-right text-ink-muted tabular-nums">{resetFormat.format(new Date(row.resets_at))} 重置</time>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-1 text-ink-muted">{message}</p>}
          </div>
        </div>, document.body,
      )}
      <span role="status" className="sr-only">{rows?.length ? `已检测到 ${rows.length} 项额度` : message}</span>
    </div>
  )
}
