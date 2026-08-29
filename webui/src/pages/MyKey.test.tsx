// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MyKey from './MyKey'
import { MYKEY_SHOW_UPLOAD_KEY, setMyKeyShowUpload } from '@/utils/mykeySyncUi'

const apiMock = vi.hoisted(() => ({
  mykey: vi.fn(),
  openMyKeyFile: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))
vi.mock('@/components/PageShell', () => ({
  PageShell: ({ children, actions }: { children: ReactNode; actions?: ReactNode }) => (
    <div>
      <div data-testid="actions">{actions}</div>
      {children}
    </div>
  ),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MyKey upload button visibility', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    localStorage.removeItem(MYKEY_SHOW_UPLOAD_KEY)
    apiMock.mykey.mockReset().mockResolvedValue({
      exists: true,
      path: '/tmp/mykey.py',
      raw: '',
      structured: { sessions: [], globals: {} },
    })
    apiMock.openMyKeyFile.mockReset()
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
    localStorage.removeItem(MYKEY_SHOW_UPLOAD_KEY)
  })

  const render = () => {
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MyKey />
        </QueryClientProvider>,
      )
    })
  }

  it('hides the upload button by default while keeping download', async () => {
    render()
    await act(async () => {})
    const actions = host.querySelector('[data-testid="actions"]')!.textContent || ''
    expect(actions).toContain('下载mykey')
    expect(actions).not.toContain('上传mykey')
  })

  it('shows the upload button after the settings flag is enabled', async () => {
    act(() => setMyKeyShowUpload(true))
    render()
    await act(async () => {})
    const actions = host.querySelector('[data-testid="actions"]')!.textContent || ''
    expect(actions).toContain('上传mykey')
    expect(actions).toContain('下载mykey')
  })

  it('reacts to the settings event while mounted', async () => {
    render()
    await act(async () => {})
    expect(host.querySelector('[data-testid="actions"]')!.textContent).not.toContain('上传mykey')
    act(() => setMyKeyShowUpload(true))
    expect(host.querySelector('[data-testid="actions"]')!.textContent).toContain('上传mykey')
    act(() => setMyKeyShowUpload(false))
    expect(host.querySelector('[data-testid="actions"]')!.textContent).not.toContain('上传mykey')
  })
})
