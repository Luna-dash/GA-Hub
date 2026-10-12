// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import TokenStats from './TokenStats'
import type { TokenStatsResponse, TokenTotals } from '@/api/types'
import { queryKeys } from '@/queries/queryKeys'

const mocks = vi.hoisted(() => ({ tokenStats: vi.fn() }))
vi.mock('@/api/client', () => ({ api: mocks }))
vi.mock('@/components/PageShell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }))
vi.mock('@/utils/pageState', async () => {
  const { useState } = await import('react')
  return { usePageState: (_key: string, initial: unknown) => useState(initial) }
})
const zero: TokenTotals = { requests: 0, input: 0, output: 0, cache_create: 0, cache_read: 0, total: 0, cache_hit_rate: 0 }
const today = { ...zero, date: '2026-10-12', requests: 2, input: 100, output: 50, cache_create: 50, cache_read: 300, total: 500, cache_hit_rate: 66.7 }
const previous = { ...zero, date: '2026-10-11', requests: 1, input: 100, output: 50, total: 150 }
const fixture: TokenStatsResponse = {
  available: true, timestamp: new Date(2026, 9, 12, 12).getTime() / 1000,
  totals: today, all_time: { ...today, total: 1000 },
  current_week: { ...today, week_start: '2026-10-12', week_end: '2026-10-18' },
  weeks: [{ ...today, week_start: '2026-10-12', week_end: '2026-10-18' }],
  days: [previous, today],
  threads: [{ ...today, thread: 'test', title: '测试会话', elapsed_seconds: 0 }],
}
let host: HTMLDivElement, root: Root, client: QueryClient
async function render() {
  await act(async () => {
    root.render(<QueryClientProvider client={client}><TokenStats /></QueryClientProvider>)
  })
  for (let i = 0; i < 20 && !host.querySelector('.token-metrics, [role="alert"], .token-empty'); i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  }
  // Query notifications are scheduled separately from the resolved promise.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(node => node.textContent === label)
  expect(button).toBeDefined()
  await act(async () => { button!.click() })
}
describe('TokenStats dashboard', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mocks.tokenStats.mockReset().mockResolvedValue(fixture)
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })
  afterEach(async () => { await act(async () => root.unmount()); client.clear(); host.remove() })
  it('defaults to seven days and synchronizes metrics, composition, and natural week', async () => {
    await render()
    expect(host.querySelectorAll('.token-bar')).toHaveLength(7)
    expect(host.querySelector('.token-metric-value')?.textContent).toBe('650')
    expect(host.querySelectorAll('.token-metric-value')[3].textContent).toBe('54.5%')
    expect(host.querySelector('.token-composition-list')?.textContent).toContain('缓存写入')
    expect(host.querySelector('.token-session-value')?.textContent).toContain('50.0%')
    await click('本周')
    expect(host.querySelectorAll('.token-bar')).toHaveLength(1)
    expect(host.querySelector('.token-metric-value')?.textContent).toBe('500')
    expect(host.querySelectorAll('.token-metric-value')[3].textContent).toBe('66.7%')
    expect(host.querySelector('.token-composition-list')?.textContent).toContain('60.0%')
    expect(host.textContent).toContain('今日 · 未结束')
    expect(host.textContent).toContain('不随上方区间筛选')
    expect(host.innerHTML).not.toMatch(/NaN|Infinity/)
    await click('近 30 日')
    expect(host.querySelectorAll('.token-bar')).toHaveLength(30)
    await act(async () => { host.querySelector<SVGElement>('.token-bar-hit')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    expect(host.querySelector('.token-day-detail')?.textContent).toContain('2026-09-13')
  })
  it('keeps contextual markers without repeated helper copy', async () => {
    mocks.tokenStats.mockResolvedValue(fixture)
    await render()
    expect(host.querySelectorAll('.token-metric .token-note')).toHaveLength(0)
    expect(host.querySelector('.token-composition-foot')).toBeNull()
    expect(host.querySelector('.token-chart-foot')).toBeNull()
    expect(host.querySelector('.token-trend .token-section-header .token-note')).toBeNull()
    expect(host.querySelector('.token-weekly .token-section-header .token-note')).toBeNull()
    expect(host.textContent).toContain('今日 · 未结束')
    expect(host.textContent).toContain('不随上方区间筛选')
    expect(host.querySelectorAll('.token-metric')[3].getAttribute('title')).toContain('读取 ÷')
  })
  it('links day selection to composition and can return to interval totals', async () => {
    mocks.tokenStats.mockResolvedValue(fixture)
    await render()
    const composition = () => host.querySelector('.token-composition')!
    const select = async (date: string, event: Event) => {
      const bar = Array.from(host.querySelectorAll('.token-bar-hit')).find(node => node.getAttribute('aria-label')?.startsWith(date))!
      await act(async () => { bar.dispatchEvent(event) })
      expect(bar.getAttribute('aria-pressed')).toBe('true')
      expect(composition().getAttribute('aria-label')).toBe(`${date} Token 构成`)
    }
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('650')
    await select('2026-10-11', new MouseEvent('click', { bubbles: true }))
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('150')
    expect(composition().querySelector('.token-composition-list')?.textContent).toContain('66.7%')
    expect(composition().querySelector('.token-donut')?.getAttribute('aria-label')).toContain('缓存读取 0')
    expect(host.querySelector('.token-metric-value')?.textContent).toBe('650')
    expect(host.querySelector('.token-day-detail')?.textContent).toContain('2026-10-11')
    await select('2026-10-12', new FocusEvent('focusin', { bubbles: true }))
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('500')
    expect(composition().querySelector('.token-composition-list')?.textContent).toContain('60.0%')
    await click('区间汇总')
    expect(composition().getAttribute('aria-label')).toBe('所选区间 Token 构成')
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('650')
    expect(host.querySelector('[aria-pressed="true"].token-bar-hit')).toBeNull()
    await select('2026-10-10', new KeyboardEvent('keydown', { key: ' ', bubbles: true }))
    expect(composition().querySelector('.token-donut')?.getAttribute('aria-label')).toBe('暂无用量')
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('0')
    expect(composition().innerHTML).not.toMatch(/NaN|Infinity/)
    await select('2026-10-11', new MouseEvent('mouseover', { bubbles: true }))
    await click('本周')
    expect(composition().getAttribute('aria-label')).toBe('所选区间 Token 构成')
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('500')
    await select('2026-10-12', new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const refreshed = { ...fixture, days: [previous, { ...today, cache_read: 400, total: 600 }] }
    await act(async () => {
      client.setQueryData(queryKeys.tokenStats, refreshed)
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    expect(composition().getAttribute('aria-label')).toBe('2026-10-12 Token 构成')
    expect(composition().querySelector('.token-donut-center strong')?.textContent).toBe('600')
  })
  it('renders zero usage without invalid chart or percentages', async () => {
    mocks.tokenStats.mockResolvedValue({ ...fixture, days: [], threads: [], weeks: [] })
    await render()
    expect(host.textContent).toContain('所选区间暂无用量')
    expect(host.querySelector('.token-metric-value')?.textContent).toBe('0')
    expect(host.innerHTML).not.toMatch(/NaN|Infinity/)
  })
  it('shows unavailable and failed states instead of a blank page', async () => {
    mocks.tokenStats.mockResolvedValue({ ...fixture, available: false })
    await render()
    expect(host.textContent).toContain('统计尚未就绪')
    mocks.tokenStats.mockRejectedValue(new Error('offline'))
    await act(async () => { await client.resetQueries() })
    for (let i = 0; i < 20 && !host.querySelector('[role="alert"]'); i++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
    }
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('加载失败')
  })
})
