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
})
