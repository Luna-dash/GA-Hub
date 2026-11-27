// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntiAccountUsageButton } from './AntiAccountUsageButton'

const antiApiMock = vi.hoisted(() => ({
  accountUsage: vi.fn(),
  quotaPoolSummary: vi.fn(),
  accountStats: vi.fn(),
  refreshQuotaPool: vi.fn(),
  resetQuotaPool: vi.fn(),
  calibrateQuotaPool: vi.fn(),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, antiApi: antiApiMock }
})

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AntiAccountUsageButton clickable cue', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    antiApiMock.quotaPoolSummary.mockResolvedValue({ pools: [] })
    antiApiMock.accountStats.mockResolvedValue({ by_model: [], total_cost_usd: 0 })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
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
})
