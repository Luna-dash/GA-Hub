// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from './Settings'
import { api, fontApi, novaApi, storageApi, updateApi } from '@/api/client'
import { dialog } from '@/stores/dialogStore'
import { useToastStore } from '@/stores/toastStore'

vi.mock('@/api/client', () => ({
  api: { setupStatus: vi.fn(), setupValidate: vi.fn(), setupSave: vi.fn(), chatRetryConfig: vi.fn(), saveChatRetryConfig: vi.fn() },
  fontApi: {
    settings: vi.fn(),
    download: vi.fn(),
    activate: vi.fn(),
    updatePreferences: vi.fn(),
    deletePack: vi.fn(),
    manifest: vi.fn(),
    importFile: vi.fn(),
  },
  novaApi: { status: vi.fn(), action: vi.fn() },
  storageApi: { summary: vi.fn(), agyGcPolicy: vi.fn(), updateAgyGcPolicy: vi.fn(), cleanup: vi.fn() },
  updateApi: { status: vi.fn(), release: vi.fn(), download: vi.fn(), prepare: vi.fn(), apply: vi.fn(), cancel: vi.fn() },
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
  for (const item of useToastStore.getState().items) {
    useToastStore.getState().dismiss(item.id)
  }
  localStorage.clear()
  vi.mocked(api.setupStatus).mockResolvedValue({ configured: true, ga_root: 'D:/GA', admin_data: 'D:/data' } as any)
  vi.mocked(api.chatRetryConfig).mockResolvedValue({ enabled: true, max_attempts: 2 } as any)
  vi.mocked(updateApi.status).mockResolvedValue({ plan: { state: 'idle' }, supported: true, sources: ['github_release', 'trusted_local_archive'], data_epoch: 2 })
  vi.mocked(storageApi.summary).mockResolvedValue({ total_bytes: 0, categories: [] } as never)
  vi.mocked(storageApi.agyGcPolicy).mockRejectedValue(new Error('policy unavailable'))
  vi.mocked(novaApi.status).mockResolvedValue({ device: 'device-test', paired: false, running: false, connected: false, paused: false })
  vi.mocked(fontApi.settings).mockResolvedValue({
    active_pack: 'system',
    bold_style: 'restrained',
    packs: [{
      id: 'harmonyos-sans-sc',
      name: 'HarmonyOS Sans SC + Inter / JetBrains Mono',
      summary: 'test pack',
      license: 'HarmonyOS Sans License',
      mode: 'enhanced',
      approx_bytes: 13000000,
      installed: false,
      installed_bytes: 0,
      active: false,
      removable: true,
    }],
    download: null,
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove() })

describe('Settings functional tabs', () => {
  it('uses ten separated vertical tabs with one visible associated panel', async () => {
    await mount()
    expect(host.querySelector('h1')?.textContent).toBe('设置')
    expect(host.querySelector('[role="tablist"]')?.getAttribute('aria-orientation')).toBe('vertical')
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(10)
    for (const [id, text] of [
      ['general', '选择目录与执行环境'], ['display', '会话显示'], ['fonts', '字体方案'],
      ['navigation', '导航栏'], ['chat', '实时聊天自动重试'], ['remote', 'Nova'],
      ['updates', '桌面程序更新'], ['storage', '本地缓存与运行数据'], ['sync', 'mykey 同步'], ['notifications', '桌面通知'],
    ]) {
      await click(id)
      expect(host.querySelectorAll('[role="tabpanel"]:not([hidden])')).toHaveLength(1)
      expect(panel().id).toBe(tab(id).getAttribute('aria-controls'))
      expect(panel().textContent).toContain(text)
      if (id === 'remote') expect(panel().textContent).not.toContain('桌面程序更新')
      if (id === 'updates') expect(panel().textContent).not.toContain('Nova')
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

  it('allows clearing existing python_path and ga_root without snapping back to saved setup', async () => {
    vi.mocked(api.setupStatus).mockResolvedValue({
      configured: true,
      ga_root: 'D:/GA',
      python_path: 'C:/Python311/python.exe',
      admin_data: 'D:/data',
    } as any)
    await mount()
    const inputs = panel().querySelectorAll<HTMLInputElement>('input')
    expect(inputs[0].value).toBe('D:/GA')
    expect(inputs[1].value).toBe('C:/Python311/python.exe')

    await change(inputs[1], '')
    expect(inputs[1].value).toBe('')
    await change(inputs[0], '')
    expect(inputs[0].value).toBe('')
  })

  it('disables all numeric retry inputs when automatic retry is turned off', async () => {
    await mount()
    await click('chat')
    const toggle = panel().querySelector<HTMLInputElement>('input[type="checkbox"]')!
    const numbers = Array.from(panel().querySelectorAll<HTMLInputElement>('input[type="number"]'))
    expect(numbers).toHaveLength(7)
    expect(numbers.every((input) => !input.disabled)).toBe(true)

    await act(async () => toggle.click())
    expect(numbers.every((input) => input.disabled)).toBe(true)

    await act(async () => toggle.click())
    expect(numbers.every((input) => !input.disabled)).toBe(true)
  })

  it('switches UI theme presets, toggles A/B/off paper textures, and resets to default in display tab', async () => {
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.paperTexture
    await mount()
    await click('display')

    const p = panel()
    expect(p.querySelectorAll('[data-theme-option]')).toHaveLength(6)
    expect(p.querySelectorAll('[data-texture-option]')).toHaveLength(3)

    const brownBtn = p.querySelector<HTMLButtonElement>('[data-theme-option="crisp-brown-solid"]')!
    const darkBtn = p.querySelector<HTMLButtonElement>('[data-theme-option="dark-forest"]')!
    const cottonBtn = p.querySelector<HTMLButtonElement>('[data-texture-option="cotton"]')!
    const noneBtn = p.querySelector<HTMLButtonElement>('[data-texture-option="none"]')!

    await act(async () => { brownBtn.click() })
    expect(document.documentElement.dataset.theme).toBe('crisp-brown-solid')
    expect(brownBtn.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('gahub.uiTheme.v1')).toBe('crisp-brown-solid')

    await act(async () => { cottonBtn.click() })
    expect(document.documentElement.dataset.paperTexture).toBe('cotton')
    expect(cottonBtn.getAttribute('aria-pressed')).toBe('true')
    expect(localStorage.getItem('gahub.uiPaperTexture.v1')).toBe('cotton')

    await act(async () => { noneBtn.click() })
    expect(document.documentElement.dataset.paperTexture).toBe('none')
    expect(localStorage.getItem('gahub.uiPaperTexture.v1')).toBe('none')

    await act(async () => { darkBtn.click() })
    expect(document.documentElement.dataset.theme).toBe('dark-forest')
    expect(p.textContent).toContain('深色主题下自动关闭浅色纸纹')

    const resetBtn = Array.from(p.querySelectorAll<HTMLButtonElement>('button'))
      .find(btn => btn.textContent?.includes('恢复默认'))!
    await act(async () => { resetBtn.click() })
    expect(document.documentElement.dataset.theme).toBe('crisp-green-soft')
    expect(document.documentElement.dataset.paperTexture).toBe('fiber')
    expect(localStorage.getItem('gahub.uiTheme.v1')).toBe('crisp-green-soft')
    expect(localStorage.getItem('gahub.uiPaperTexture.v1')).toBe('fiber')
  })

  it('requires danger confirmation before removing an installed font pack', async () => {
    const installedSettings = {
      active_pack: 'system',
      bold_style: 'restrained',
      packs: [{
        id: 'harmonyos-sans-sc',
        name: 'HarmonyOS Sans SC',
        summary: 'test pack',
        license: 'HarmonyOS Sans License',
        mode: 'enhanced',
        approx_bytes: 13_000_000,
        installed: true,
        installed_bytes: 13_000_000,
        active: false,
        removable: true,
      }],
      download: null,
    } as const
    vi.mocked(fontApi.settings).mockResolvedValue(installedSettings as never)
    vi.mocked(fontApi.deletePack).mockResolvedValue({
      ...installedSettings,
      packs: [{ ...installedSettings.packs[0], installed: false, installed_bytes: 0 }],
    } as never)
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    try {
      await mount()
      await click('fonts')

      const removeBtn = Array.from(panel().querySelectorAll<HTMLButtonElement>('button'))
        .find((b) => b.textContent?.includes('移除'))!
      await act(async () => { removeBtn.click(); await Promise.resolve() })
      expect(confirmSpy).toHaveBeenCalledWith(
        '移除字体包「HarmonyOS Sans SC」？',
        expect.any(String),
        expect.objectContaining({ confirmText: '移除', tone: 'danger' }),
      )
      expect(fontApi.deletePack).not.toHaveBeenCalled()

      await act(async () => { removeBtn.click(); await Promise.resolve() })
      expect(fontApi.deletePack).toHaveBeenCalledWith('harmonyos-sans-sc')
    } finally {
      confirmSpy.mockRestore()
    }
  })

  it('renders QueryLoadState with retry when ChatRetryPanel fails to load and toasts on save', async () => {
    vi.mocked(api.chatRetryConfig).mockRejectedValueOnce({ body: { detail: '重试配置不可读' } })
    await mount()
    await click('chat')
    expect(panel().querySelector('[role="alert"]')?.textContent).toContain('重试配置加载失败：重试配置不可读')

    vi.mocked(api.chatRetryConfig).mockResolvedValueOnce({ enabled: true, max_attempts: 2 } as any)
    vi.mocked(api.saveChatRetryConfig).mockResolvedValueOnce({ enabled: true, max_attempts: 2 } as any)
    const retryBtn = Array.from(panel().querySelectorAll('button')).find(b => b.textContent === '重试')!
    await act(async () => { retryBtn.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(panel().textContent).toContain('实时会话')

    const saveBtn = Array.from(panel().querySelectorAll('button')).find(b => b.textContent === '保存')!
    await act(async () => { saveBtn.click(); await Promise.resolve() })
    expect(useToastStore.getState().items.some(t => t.kind === 'success' && t.message === '已保存重试配置')).toBe(true)
  })
})
