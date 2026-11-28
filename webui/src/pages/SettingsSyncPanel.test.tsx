// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings'
import { queryKeys } from '@/queries/queryKeys'
import { MYKEY_SHOW_UPLOAD_KEY } from '@/utils/mykeySyncUi'

const apiMock = vi.hoisted(() => ({
  setupStatus: vi.fn(),
  setupValidate: vi.fn(),
  setupSave: vi.fn(),
  chatRetryConfig: vi.fn(),
  saveChatRetryConfig: vi.fn(),
  myKeySyncConfig: vi.fn(),
  saveMyKeySyncConfig: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))
vi.mock('@/utils/notify', () => ({
  notify: vi.fn(async () => true),
  useNotifyStore: (sel: (s: { optedIn: boolean; backendName: string; setOptIn: () => void; refresh: () => void }) => unknown) =>
    sel({ optedIn: false, backendName: 'mock', setOptIn: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/components/PageShell', () => ({
  PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/components/NovaSettingsPanel', () => ({ NovaSettingsPanel: () => <div /> }))
vi.mock('@/components/StorageSettingsPanel', () => ({ StorageSettingsPanel: () => <div /> }))
vi.mock('@/components/UpdateSettingsPanel', () => ({ UpdateSettingsPanel: () => <div /> }))
vi.mock('@/components/FontAppearancePanel', () => ({ FontAppearancePanel: () => <div /> }))
vi.mock('@/components/ThemeAppearancePanel', () => ({ ThemeAppearancePanel: () => <div /> }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Settings sync domain panel', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    localStorage.removeItem(MYKEY_SHOW_UPLOAD_KEY)
    apiMock.setupStatus.mockResolvedValue({ configured: true, ga_root: 'D:/ga', python_path: 'python' })
    apiMock.chatRetryConfig.mockResolvedValue({ enabled: true, max_attempts: 2 })
    apiMock.myKeySyncConfig.mockResolvedValue({ sync_url: '', effective_url: '', env_override: false })
    apiMock.saveMyKeySyncConfig.mockImplementation(async (url: string) => ({
      sync_url: url ? `https://${url.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '',
      effective_url: url ? `https://${url.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '',
      env_override: false,
    }))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    client.clear()
    vi.restoreAllMocks()
  })

  const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 40)) }) }

  it('loads, saves, and clears the local sync domain from Settings', async () => {
    client.setQueryData(queryKeys.setup, { configured: true, ga_root: 'D:/ga', python_path: 'python' })
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Settings />
        </QueryClientProvider>,
      )
      await settle()
    })

    const syncTab = host.querySelector('#settings-tab-sync') as HTMLButtonElement
    expect(syncTab).toBeTruthy()
    await act(async () => { syncTab.click(); await settle() })

    const panel = host.querySelector('#settings-panel-sync')!
    expect(panel.textContent).toContain('未配置')

    const input = panel.querySelector('input[aria-label="同步服务域名"]') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(input, 'sync.example.com')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    const form = panel.querySelector('form')!
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await settle()
    })

    expect(apiMock.saveMyKeySyncConfig).toHaveBeenCalledWith('sync.example.com')
    expect(panel.textContent).toContain('已配置')

    const clearBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === '清空')!
    await act(async () => { clearBtn.click(); await settle() })
    expect(apiMock.saveMyKeySyncConfig).toHaveBeenLastCalledWith('')
    expect(panel.textContent).toContain('未配置')
  })
})
