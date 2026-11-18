// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import AntiChat from './AntiChat'

vi.mock('@/api/client', () => ({ api: { projects: async () => ({ items: [
  { name: 'demo', display_name: 'Demo project', path: 'D:/demo' },
] }) } }))
vi.mock('@/runtime/runtimeConfig', () => ({ resolveApiUrl: (path: string) => path }))

it('starts Anti on demand from the page header without leaving the chat', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let started = false
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, json: async () => data })
    if (path === '/api/anti/status') {
      return reply(started ? { state: 'ready', agy_available: true } : { state: 'stopped' })
    }
    if (path === '/api/anti/start') {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('start-anti')
      started = true
      return reply({ state: 'starting' })
    }
    if (path === '/api/anti/sessions') return reply([])
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function CurrentPage() {
    return <output data-page={useLocation().pathname} />
  }
  const button = (label: string) => host.querySelector<HTMLButtonElement>(`header button[aria-label="${label}"]`)
  const wait = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    check()
  })
  try {
    await act(async () => root.render(<QueryClientProvider client={cache}>
      <MemoryRouter initialEntries={['/anti']}><AntiChat /><CurrentPage /></MemoryRouter>
    </QueryClientProvider>))
    await wait(() => expect(button('启动 Anti')?.disabled).toBe(false))
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(0)
    await act(async () => button('启动 Anti')!.click())
    await wait(() => expect(button('Anti 启动中')?.disabled).toBe(true))
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(1)
    await act(async () => cache.refetchQueries({ queryKey: ['anti-daemon-status'] }))
    await wait(() => expect(button('Anti 已就绪')?.disabled).toBe(true))
    expect(host.querySelector('output')?.dataset.page).toBe('/anti')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('binds a project and submits the selected Anti model and effort', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const base = '/api/anti/sessions'
  const session = { id: 'one', title: 'Anti', project: 'demo', workspace: 'D:/demo' }
  const runs: Record<string, unknown>[] = []
  const posted: Record<string, unknown>[] = []
  let created = false
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body && JSON.parse(String(init.body))
    if (body) posted.push(body)
    const reply = (data: unknown) => ({ ok: true, json: async () => data })
    if (path === base) {
      if (!body) return reply(created ? [session] : [])
      created = true
      return reply(session)
    }
    if (path === '/api/anti/models') return reply({ items: [
      { id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' },
      { id: 'gemini-4-hydrogen-low', display_name: 'Gemini 4 Hydrogen (Low)' },
      { id: 'alternate-medium', display_name: 'Alternate (Medium)' },
      { id: 'alternate-low', display_name: 'Alternate (Low)' },
    ] })
    if (path === `${base}/one/runs`) {
      if (!body) return reply([...runs])
      const run = { ...body, id: 'run', status: 'success', answer: 'Done' }
      runs.push(run)
      return reply(run)
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const wait = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    check()
  })
  const control = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  async function choose(label: string, name: string) {
    await act(async () => control(label).click())
    const item = document.querySelector<HTMLElement>(`[role="option"][title="${name}"]`)
    expect(item?.querySelector(':scope > .model-select-label')?.textContent).toContain(name)
    await act(async () => item!.click())
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await wait(() => expect(control('项目目录').disabled).toBe(false))
    expect(control('项目目录').querySelector(':scope > .model-select-label')?.textContent).toBe('选择项目目录')
    await choose('项目目录', 'Demo project')
    const create = Array.from(host.querySelectorAll('button')).find(button => button.textContent?.includes('新建 Anti 会话'))!
    await act(async () => create.click())
    await wait(() => {
      expect(host.querySelector('header')?.textContent).toContain(session.workspace)
      expect(control('模型').querySelector(':scope > .model-select-label')?.textContent).toBe('Gemini 4 Hydrogen')
      expect(control('思考等级').querySelector(':scope > .model-select-label')?.textContent).toBe('思考：高')
    })
    await wait(() => expect(cache.getQueryState(['anti-models'])?.status).toBe('success'))
    await choose('模型', 'Alternate')
    expect(control('思考等级').textContent).toContain('思考：低')
    await choose('思考等级', '中')
    const input = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Read the project')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(() => expect(control('发送').disabled).toBe(false))
    await act(async () => control('发送').click())
    await wait(() => expect(host.textContent).toContain('Done'))
    expect(posted).toEqual([{ project: 'demo' }, {
      prompt: 'Read the project', model: 'alternate-medium', effort: 'medium', operation: expect.any(String),
    }])
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})
