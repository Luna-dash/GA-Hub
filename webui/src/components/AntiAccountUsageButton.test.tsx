// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/api/client'
import { useToastStore } from '@/stores/toastStore'
import { AntiAccountUsageButton } from './AntiAccountUsageButton'

const antiApiMock = vi.hoisted(() => ({
  accountUsage: vi.fn(),
  quota: vi.fn(),
  stats: vi.fn(),
  resetBreaker: vi.fn(),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, antiApi: antiApiMock }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AntiAccountUsageButton', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    antiApiMock.quota.mockResolvedValue([])
    antiApiMock.stats.mockResolvedValue({
      total_runs: 0,
      success_runs: 0,
      total_tokens: 0,
      cache_hit_ratio: 0,
      estimated_cost_usd: 0,
      by_model: [],
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    client.clear()
    host.remove()
  })

  it('keeps an interactive cursor and full contrast when Agy is not running and opens the popover on click', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiAccountUsageButton
            running={false}
            profileId="main"
            profileName="主账号"
            cachedUsage={null}
            onChecked={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    expect(trigger.disabled).toBe(false)
    expect(trigger.className).not.toContain('cursor-default')
    expect(trigger.className).not.toContain('opacity-65')

    await act(async () => { trigger.click() })
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()
  })

  it('renders pools/stats errors with inline retry, formats resetBreaker error, and toasts usage failure when closed', async () => {
    let rejectUsage!: (err: unknown) => void
    antiApiMock.accountUsage.mockImplementation(() => new Promise((_, reject) => { rejectUsage = reject }))
    antiApiMock.quota.mockRejectedValueOnce(new HttpError(500, { detail: '配额服务忙' }))
    antiApiMock.stats.mockRejectedValueOnce(new HttpError(500, { detail: '统计服务忙' }))

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiAccountUsageButton
            running
            profileId="main"
            profileName="主账号"
            cachedUsage={null}
            onChecked={() => {}}
          />
        </QueryClientProvider>,
      )
    })

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    await act(async () => { trigger.click() })

    await vi.waitFor(() => {
      const dialog = document.body.querySelector('[role="dialog"]')!
      expect(dialog.textContent).toContain('配额冷却状态读取失败：配额服务忙')
      expect(dialog.textContent).toContain('今日用量读取失败：统计服务忙')
    })

    // Close popover while usage mutation is still pending, then reject -> toast.error fires
    await act(async () => { trigger.click() })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => {
      rejectUsage(new HttpError(502, { detail: '上游额度接口错误' }))
    })
    await vi.waitFor(() => {
      expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('上游额度接口错误'))).toBe(true)
    })

    // Reopen and verify pools retry works and resetBreaker formats error via extractErrorMessage
    antiApiMock.quota.mockResolvedValue([{ display_name: 'Claude', status: 'cooling_down', cooldown_remaining_seconds: 30 }])
    antiApiMock.stats.mockResolvedValue({
      total_runs: 1,
      success_runs: 1,
      total_tokens: 100,
      cache_hit_ratio: 0.5,
      estimated_cost_usd: 0,
      by_model: [],
    })
    antiApiMock.resetBreaker.mockRejectedValueOnce(new HttpError(409, { detail: { message: '冷却中暂不可解锁' } }))

    await act(async () => { trigger.click() })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('提前解锁')
    })
    const unlockBtn = Array.from(document.body.querySelectorAll('[role="dialog"] button')).find(b => b.textContent === '提前解锁') as HTMLButtonElement
    await act(async () => { unlockBtn.click() })
    await vi.waitFor(() => {
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('冷却中暂不可解锁')
    })
  })
})
