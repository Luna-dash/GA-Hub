// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Dashboard from './Dashboard'

const apiMock = vi.hoisted(() => ({
  servicePanel: vi.fn(),
  tokenStats: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))
vi.mock('@/components/PageShell', () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Dashboard status-only services', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    apiMock.servicePanel.mockReset().mockResolvedValue({
      timestamp: 1,
      services: [{
        id: 'feishu',
        name: '飞书 Bot',
        state: 'running',
        summary: 'Bot 进程运行中',
        href: '/dashboard',
        metrics: { PID: 1234, 模式: '内建' },
        error: null,
        activity: 'active',
        health: 'healthy',
        expected_running: false,
      }],
    })
    apiMock.tokenStats.mockReset().mockResolvedValue({ available: false })
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    host.remove()
  })

  it('shows Feishu runtime details without rendering a page link', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter><Dashboard /></MemoryRouter>
        </QueryClientProvider>,
      )
      await Promise.resolve()
    })

    for (let attempt = 0; attempt < 20 && !host.textContent?.includes('PID'); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })
    }

    expect(host.textContent).toContain('飞书 Bot')
    expect(host.textContent).toContain('Bot 进程运行中')
    expect(host.textContent).toContain('PID')
    expect(host.querySelector('a[href="/dashboard"]')).toBeNull()
  })
})
