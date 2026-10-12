// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MyKey from './MyKey'
import { resetPageState } from '@/utils/pageState'
import { queryKeys } from '@/queries/queryKeys'
import { dialog } from '@/stores/dialogStore'
import type { MyKeyData } from '@/api/types'
import { MYKEY_SHOW_UPLOAD_KEY, setMyKeyShowUpload } from '@/utils/mykeySyncUi'

const apiMock = vi.hoisted(() => ({
  mykey: vi.fn(),
  openMyKeyFile: vi.fn(),
  mutateMyKey: vi.fn(),
  mykeyBackups: vi.fn(),
  restoreMyKeyBackup: vi.fn(),
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
    resetPageState()
    apiMock.mutateMyKey.mockReset().mockResolvedValue({ ok: true })
    localStorage.removeItem(MYKEY_SHOW_UPLOAD_KEY)
    apiMock.mykey.mockReset().mockResolvedValue({
      exists: true,
      path: '/tmp/mykey.py',
      raw: '',
      structured: { sessions: [], mixins: [], globals: {} },
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
    vi.restoreAllMocks()
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

  it('uses paper-themed cards and preserves paired expansion and masked keys', async () => {
    apiMock.mykey.mockResolvedValue({
      exists: true, path: '/preview/mykey.py', raw: '',
      structured: {
        sessions: [
          { var: 'native_claude_config', type: 'native_claude', fields: { name: 'Claude demo', model: 'claude-demo', apikey: '********' } },
          { var: 'native_oai_config', type: 'native_oai', fields: { name: 'OpenAI demo', model: 'gpt-demo', apikey: '********' } },
        ],
        mixins: [{ var: 'mixin_config', type: 'mixin', fields: { name: 'Route demo', llm_nos: ['0', '1'] } }], globals: {},
      },
    })
    render()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    const cards = Array.from(host.querySelectorAll('.mykey-card'))
    expect(cards).toHaveLength(3)
    expect(host.querySelector('.mykey-card--claude')).not.toBeNull()
    expect(host.querySelector('.mykey-card--openai')).not.toBeNull()
    expect(host.querySelector('.mykey-card--mixin')).not.toBeNull()
    const toggles = cards.map((card) => card.querySelector<HTMLButtonElement>('.mykey-card__toggle')!)
    expect(toggles.every((toggle) => toggle.getAttribute('aria-expanded') === 'false')).toBe(true)
    const index = cards.findIndex((card) => card.classList.contains('mykey-card--claude'))
    const rowMates = cards.map((_, i) => i).filter((i) => Math.floor(i / 2) === Math.floor(index / 2))
    const outsideIndex = cards.findIndex((_, i) => Math.floor(i / 2) !== Math.floor(index / 2))
    expect(index).toBeGreaterThanOrEqual(0)
    expect(outsideIndex).toBeGreaterThanOrEqual(0)
    act(() => toggles[index].click())
    expect(toggles[index].getAttribute('aria-expanded')).toBe('true')
    for (const mate of rowMates) expect(toggles[mate].getAttribute('aria-expanded')).toBe('true')
    expect(toggles[outsideIndex].getAttribute('aria-expanded')).toBe('false')
    expect(cards[index].querySelector('.mykey-card__details')!.textContent).toContain('********')
    expect(cards[index].textContent).toContain('测 ping')
    act(() => toggles[index].click())
    expect(cards[0].querySelector('.mykey-card__details')).toBeNull()
    expect(cards[1].querySelector('.mykey-card__details')).toBeNull()
  })

  it('shares channel icons, labels and order between create buttons and cards without changing source order', async () => {
    const sessions = [
      { var: 'oai_a', type: 'native_oai', fields: { name: 'OpenAI A' } },
      { var: 'claude_text', type: 'claude', fields: { name: 'Claude text' } },
      { var: 'claude_native', type: 'native_claude', fields: { name: 'Claude native' } },
      { var: 'oai_b', type: 'oai', fields: { name: 'OpenAI B' } },
    ]
    apiMock.mykey.mockResolvedValue({
      exists: true, path: '/preview/mykey.py', raw: '',
      structured: { sessions, mixins: [{ var: 'route', type: 'mixin', fields: { llm_nos: [] } }], globals: {} },
    })
    render()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('.mykey-channel-add'))
    expect(buttons.map((button) => button.dataset.channelType)).toEqual(['mixin', 'native_oai', 'native_claude'])
    const cards = Array.from(host.querySelectorAll<HTMLElement>('.mykey-card'))
    expect(cards.map((card) => card.dataset.channelType)).toEqual(['mixin', 'native_oai', 'oai', 'claude', 'native_claude'])
    for (const button of buttons) {
      const card = cards.find((entry) => entry.dataset.channelType === button.dataset.channelType)!
      expect(button.querySelector('svg')!.outerHTML).toBe(card.querySelector('.mykey-card__badge svg')!.outerHTML)
      expect(button.textContent).toBe('+' + card.querySelector('.mykey-card__badge')!.textContent)
      const tone = Array.from(button.classList).find((name) => name.startsWith('mykey-channel--'))!
      expect(card.classList.contains(tone)).toBe(true)
    }
    expect(cards[3].classList.contains('mykey-card--claude')).toBe(true)
    expect(sessions.map((entry) => entry.var)).toEqual(['oai_a', 'claude_text', 'claude_native', 'oai_b'])
    act(() => buttons[0].click())
    expect(document.body.textContent).toContain('新增链路')
    expect(document.body.textContent).toContain('Mixin 路由')
  })

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
  const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
  function click(text: string) {
    const button = Array.from(host.querySelectorAll('button')).find(b => b.textContent === text)
    expect(button).toBeTruthy()
    act(() => button!.click())
  }
  function input(element: HTMLInputElement, value: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  function fixture(proxy = 'old'): MyKeyData {
    return { exists: true, path: '/synthetic/config.py', mtime: 0, raw: `proxy = '${proxy}'`, structured: {
      sessions: [{ var: 'oai_config_a', type: 'oai', lineno: 2, fields: { name: 'A', apikey: '********' } }],
      mixins: [], globals: { proxy },
    } }
  }
  async function mountFixture(data = fixture()) {
    apiMock.mykey.mockResolvedValue(data)
    render()
    await settle()
  }

  it('renames through the unified mutation and invalidates data and backup caches', async () => {
    await mountFixture()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    act(() => host.querySelector<HTMLButtonElement>('.mykey-card__toggle')!.click())
    click('编辑')
    input(host.querySelector<HTMLInputElement>('[role="dialog"] input')!, 'oai_config_b')
    click('保存并热更新')
    await settle()
    expect(apiMock.mutateMyKey).toHaveBeenCalledWith(expect.objectContaining({
      action: 'rename', var: 'oai_config_a', new_var: 'oai_config_b', type: 'oai',
    }))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.mykey.data })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.mykey.backups })
  })

  it('proposes a noncolliding copy name and keeps the editor open on server conflicts', async () => {
    const data = fixture()
    data.structured.sessions.push({ var: 'oai_config_a_copy', type: 'oai', lineno: 3, fields: { name: 'copy' } })
    await mountFixture(data)
    act(() => host.querySelector<HTMLButtonElement>('.mykey-card__toggle')!.click())
    click('复制')
    expect(host.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('oai_config_a_copy_2')
    apiMock.mutateMyKey.mockRejectedValueOnce({ body: { detail: { message: '变量已存在' } } })
    click('保存并热更新')
    await settle()
    expect(apiMock.mutateMyKey).toHaveBeenCalledWith(expect.objectContaining({
      action: 'duplicate', var: 'oai_config_a', new_var: 'oai_config_a_copy_2',
    }))
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('变量已存在')
    expect(host.querySelector<HTMLInputElement>('[role="dialog"] input')!.value).toBe('oai_config_a_copy_2')
  })

  it('follows clean proxy refreshes but retains dirty drafts on conflicts', async () => {
    await mountFixture()
    const proxy = host.querySelector<HTMLInputElement>('input[placeholder*="127.0.0.1"]')!
    act(() => client.setQueryData(queryKeys.mykey.data, fixture('external')))
    await settle()
    expect(proxy.value).toBe('external')
    input(proxy, 'draft')
    act(() => client.setQueryData(queryKeys.mykey.data, fixture('newer')))
    await settle()
    expect(proxy.value).toBe('draft')
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('草稿已保留')
    expect(Array.from(host.querySelectorAll('button')).find(b => b.textContent === '保存 proxy')!.disabled).toBe(true)
    click('使用最新值')
    expect(proxy.value).toBe('newer')
  })

  it('saves proxy with optimistic raw precondition and does not revert after refresh', async () => {
    await mountFixture()
    const proxy = host.querySelector<HTMLInputElement>('input[placeholder*="127.0.0.1"]')!
    input(proxy, 'draft')
    apiMock.mykey.mockResolvedValue(fixture('draft'))
    click('保存 proxy')
    await settle()
    expect(apiMock.mutateMyKey).toHaveBeenCalledWith({ action: 'proxy', fields: { proxy: 'draft' }, expected_raw: "proxy = 'old'" })
    expect(proxy.value).toBe('draft')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('refreshes backup history after restoring and reopening the drawer', async () => {
    const oldBackup = { name: 'old.bak', mtime: 1, size: 100 }
    const newBackup = { name: 'new.bak', mtime: 2, size: 100 }
    apiMock.mykeyBackups.mockReset().mockResolvedValue({ backups: [oldBackup] })
    apiMock.restoreMyKeyBackup.mockReset().mockImplementation(async () => {
      apiMock.mykeyBackups.mockResolvedValue({ backups: [newBackup, oldBackup] })
      return { ok: true }
    })
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true)
    await mountFixture()
    click('原始')
    await settle()
    click('备份历史')
    await settle()
    expect(host.textContent).toContain('old.bak')
    click('↩ 回滚')
    await settle()
    expect(apiMock.restoreMyKeyBackup).toHaveBeenCalledWith('old.bak')
    click('备份历史')
    await settle()
    expect(host.textContent).toContain('new.bak')
    expect(apiMock.mykeyBackups.mock.calls.length).toBeGreaterThan(1)
  })

  it('projects cards in source-line order within each channel', async () => {
    const data = fixture()
    data.structured.sessions = [
      { var: 'oai_config_c', type: 'oai', lineno: 10, fields: { name: 'third' } },
      { var: 'oai_config_a', type: 'oai', lineno: 2, fields: { name: 'first' } },
      { var: 'oai_config_b', type: 'oai', lineno: 5, fields: { name: 'second' } },
    ]
    await mountFixture(data)
    const cards = Array.from(host.querySelectorAll('.mykey-card')).map(card => card.textContent)
    expect(cards[0]).toContain('first')
    expect(cards[1]).toContain('second')
    expect(cards[2]).toContain('third')
  })

})
