// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { api } from '@/api/client'
import { toast, useToastStore } from '@/stores/toastStore'

vi.mock('@/api/client', () => ({
  api: {
    setupStatus: vi.fn(),
  },
}))
vi.mock('@/pages/Settings', () => ({
  default: ({ initialMode }: { initialMode?: string }) => <div data-setup-mode={initialMode}>Setup</div>,
}))
vi.mock('@/components/DialogHost', () => ({ DialogHost: () => null }))
vi.mock('@/components/CommandPalette', () => ({ CommandPalette: () => null }))
vi.mock('@/components/SidebarNav', () => ({ SidebarNav: () => null }))
vi.mock('@/runtime/RuntimeEffects', () => ({ RuntimeEffects: () => null }))
vi.mock('@/components/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: { children: ReactNode }) => <>{children}</> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('App setup mode notifications', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    useToastStore.setState({ items: [] })
    vi.mocked(api.setupStatus).mockResolvedValue({
      configured: false,
      ga_root: null,
      admin_data: '/tmp/admin',
    } as Awaited<ReturnType<typeof api.setupStatus>>)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    client.clear()
    useToastStore.setState({ items: [] })
  })

  it('mounts ToastHost during initial setup so setup errors surface visibly', async () => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    ))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })

    expect(host.querySelector('[data-setup-mode="setup"]')).not.toBeNull()

    act(() => {
      toast.error('路径校验请求失败：network error')
    })

    const status = host.querySelector('[role="status"]')
    expect(status?.textContent).toContain('路径校验请求失败：network error')
  })
})
