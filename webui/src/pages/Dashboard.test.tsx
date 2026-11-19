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

  it('renders an online Nova connector alongside other services', async () => {
    const nova = {
      id: 'nova', name: 'Nova 连通器', href: '/dashboard', state: 'running',
      summary: '已连接 Nova 云端', metrics: {}, error: null,
      activity: 'active', health: 'healthy', expected_running: true,
    }
    apiMock.servicePanel.mockResolvedValue({ services: [nova], timestamp: 1 })
    await act(async () => {
      root.render(<QueryClientProvider client={client}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>)
    })
    for (let attempt = 0; attempt < 20 && !host.textContent?.includes(nova.summary); attempt += 1) {
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    }
    expect(host.textContent).toContain(nova.name)
    expect(host.textContent).toContain(nova.summary)
    expect(host.textContent).not.toContain('需要处理')
  })

  it('renders AntiCLI gateway status linking to /anti without degrading healthy state when stopped', async () => {
    const anti = {
      id: 'anti', name: 'AntiCLI 网关', href: '/anti', state: 'stopped',
      summary: '按需启动，当前未运行', metrics: {}, error: null,
      activity: 'inactive', health: 'healthy', expected_running: false,
    }
    apiMock.servicePanel.mockResolvedValue({ services: [anti], timestamp: 1 })
    await act(async () => {
      root.render(<QueryClientProvider client={client}><MemoryRouter><Dashboard /></MemoryRouter></QueryClientProvider>)
    })
    for (let attempt = 0; attempt < 20 && !host.textContent?.includes(anti.name); attempt += 1) {
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    }
    expect(host.textContent).toContain('AntiCLI 网关')
    expect(host.textContent).toContain('按需启动，当前未运行')
    expect(host.querySelector('a[href="/anti"]')).not.toBeNull()
    expect(host.textContent).not.toContain('需要处理')
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

  it('offers retry actions when service panel or token stats fail to load', async () => {
    apiMock.servicePanel.mockRejectedValueOnce(new Error('panel down')).mockResolvedValue({ services: [], timestamp: 2 })
    apiMock.tokenStats.mockRejectedValueOnce(new Error('tokens down')).mockResolvedValue({ available: false })
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter><Dashboard /></MemoryRouter>
        </QueryClientProvider>,
      )
    })
    for (let attempt = 0; attempt < 20 && !host.textContent?.includes('服务状态读取失败'); attempt += 1) {
      await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    }
    const retryButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.textContent === '重试')
    expect(retryButtons).toHaveLength(2)

    await act(async () => { retryButtons[0].click(); await new Promise((resolve) => window.setTimeout(resolve, 15)) })
    expect(apiMock.servicePanel).toHaveBeenCalledTimes(2)
  })
})
