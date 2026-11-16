// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings'
import { api, novaApi, updateApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  api: { setupStatus: vi.fn(), setupValidate: vi.fn(), setupSave: vi.fn(), chatRetryConfig: vi.fn(), saveChatRetryConfig: vi.fn() },
  novaApi: { status: vi.fn(), action: vi.fn() },
  updateApi: { status: vi.fn(), prepare: vi.fn(), cancel: vi.fn() },
}))
vi.mock('@/utils/notify', () => {
  const state = { optedIn: false, backendName: 'test', setOptIn: vi.fn(), refresh: vi.fn() }
  return { notify: vi.fn(), useNotifyStore: (select: (s: typeof state) => unknown) => select(state) }
})

let host: HTMLDivElement
let root: Root
let client: QueryClient
const panel = () => host.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
const tab = (id: string) => host.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)!
async function click(id: string) { await act(async () => tab(id).click()) }
async function change(el: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function mount(initialMode: 'settings' | 'setup' = 'settings') {
  await act(async () => root.render(<QueryClientProvider client={client}><Settings initialMode={initialMode} /></QueryClientProvider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
  localStorage.clear()
  vi.mocked(api.setupStatus).mockResolvedValue({ configured: true, ga_root: 'D:/GA', admin_data: 'D:/data' } as any)
  vi.mocked(api.chatRetryConfig).mockResolvedValue({ enabled: true, max_attempts: 2 } as any)
  vi.mocked(updateApi.status).mockResolvedValue({ plan: { state: 'idle' }, supported: true, sources: ['trusted-local-archive'], data_epoch: 1 })
  vi.mocked(novaApi.status).mockResolvedValue({ device: 'device-test', paired: false, running: false })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove() })

describe('Settings functional tabs', () => {
  it('uses six vertical tabs with one visible associated panel', async () => {
    await mount()
    expect(host.querySelector('h1')?.textContent).toBe('设置')
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical')
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(6)
    for (const [id, text] of [
      ['general', '选择目录与执行环境'], ['appearance', '会话显示'], ['chat', '实时聊天自动重试'],
      ['remote', 'Nova'], ['sync', 'mykey 同步'], ['notifications', '桌面通知'],
    ]) {
      await click(id)
      expect(host.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1)
      expect(panel().id).toBe(tab(id).getAttribute('aria-controls'))
      expect(panel().textContent).toContain(text)
      expect(tab(id).getAttribute('aria-selected')).toBe('true')
      expect(tab(id).tabIndex).toBe(0)
    }
    expect(host.textContent).not.toContain('本机检测到的候选位置')
    expect(api.setupSave).not.toHaveBeenCalled()
    expect(api.saveChatRetryConfig).not.toHaveBeenCalled()
    expect(novaApi.action).not.toHaveBeenCalled()
  })

  it('supports arrow keys, Home and End with selection and focus', async () => {
    await mount()
    for (const [from, key, to] of [['general', 'ArrowUp', 'notifications'], ['notifications', 'ArrowDown', 'general'], ['general', 'End', 'notifications'], ['notifications', 'Home', 'general']]) {
      await act(async () => tab(from).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
      expect(tab(to).getAttribute('aria-selected')).toBe('true')
      expect(document.activeElement).toBe(tab(to))
    }
  })

  it('retains unsaved path, retry and remote-account drafts across tabs', async () => {
    await mount()
    const path = panel().querySelector<HTMLInputElement>('input')!
    await change(path, 'D:/draft')
    await click('chat')
    const retry = panel().querySelector<HTMLInputElement>('input[type="number"]')!
    await change(retry, '4')
    await click('remote')
    const username = panel().querySelector<HTMLInputElement>('input')!
    await change(username, 'draft-account')
    await click('general'); expect(path.value).toBe('D:/draft')
    await click('chat'); expect(retry.value).toBe('4')
    await click('remote'); expect(username.value).toBe('draft-account')
  })

  it('keeps first-run setup focused on directory configuration', async () => {
    await mount('setup')
    expect(host.querySelector('h1')?.textContent).toBe('初始设置')
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(host.textContent).toContain('选择目录与执行环境')
    expect(host.textContent).not.toContain('mykey 同步')
    expect(novaApi.status).not.toHaveBeenCalled()
    expect(api.chatRetryConfig).not.toHaveBeenCalled()
  })
})
