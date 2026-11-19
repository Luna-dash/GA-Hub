// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it, vi } from 'vitest'
import AntiChat from './AntiChat'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'

vi.mock('@/api/client', () => ({ api: { projects: async () => ({ items: [
  { name: 'demo', display_name: 'Demo project', path: 'D:/demo' },
  { name: 'other', display_name: 'Other project', path: 'D:/other' },
] }) } }))
vi.mock('@/runtime/runtimeConfig', () => ({ resolveApiUrl: (path: string) => path }))

it('starts Anti on demand from the page header without leaving the chat', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let started = false
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') {
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('verify-anti-auth')
      return reply(started ? { state: 'ready', agy_available: true, auth_state: 'authenticated' } : { state: 'stopped' })
    }
    if (path === '/api/anti/start') {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('start-anti')
      started = true
      return reply({ state: 'starting' })
    }
    if (path === '/api/anti/account-usage') {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('check-anti-usage')
      return reply({ state: 'authenticated', rows: [{
        model: 'Example Model', limit: 'Weekly Limit Remaining', remaining_pct: 42.5,
        resets_at: '2026-11-20T08:00:00Z',
      }] })
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
    expect(button('启动 Anti')?.classList.contains('bg-status-danger')).toBe(true)
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(0)
    const usageButton = button('检测反重力额度')!
    const usageRequests = () => fetchMock.mock.calls.filter(([path]) => path === '/api/anti/account-usage')
    expect(usageButton.getAttribute('aria-disabled')).toBe('true')
    await act(async () => usageButton.click())
    expect(usageRequests()).toHaveLength(0)
    await act(async () => button('启动 Anti')!.click())
    await wait(() => expect(button('Anti 启动中')?.disabled).toBe(true))
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(1)
    await act(async () => cache.refetchQueries({ queryKey: ['anti-daemon-status'] }))
    await wait(() => expect(button('Anti 网关运行中')?.disabled).toBe(true))
    expect(host.querySelector('[role=img][aria-label="agy 已验证登录"]')).not.toBeNull()
    expect(usageRequests()).toHaveLength(0)
    expect(usageButton.closest('header')).not.toBeNull()
    expect(host.querySelector('[role=group][aria-label="Anti 状态"]')?.contains(usageButton)).toBe(false)
    const tooltip = () => document.body.querySelector('[role=tooltip]')
    await act(async () => usageButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(tooltip()?.textContent).toContain('点击检测官方剩余额度。')
    expect(tooltip()?.closest('header')).toBeNull()
    expect(usageRequests()).toHaveLength(0)
    await act(async () => usageButton.click())
    await wait(() => expect(tooltip()?.textContent).toContain('42.5%'))
    expect(usageRequests()).toHaveLength(1)
    expect(tooltip()?.textContent).toContain('Example Model')
    expect(tooltip()?.textContent).toContain('每周额度')
    expect(tooltip()?.querySelector('time')?.dateTime).toBe('2026-11-20T08:00:00Z')
    await act(async () => usageButton.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(tooltip()).toBeNull()
    await act(async () => usageButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(tooltip()?.textContent).toContain('42.5%')
    expect(usageRequests()).toHaveLength(1)
    expect(host.querySelector('output')?.dataset.page).toBe('/anti')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it.each(['success', 'auth error'] as const)('creates a project session, sends with model and effort (%s), then renames and deletes it', async outcome => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const base = '/api/anti/sessions'
  const session = { id: 'one', title: '', project: 'demo', workspace: 'D:/demo' }
  const runs: Record<string, unknown>[] = []
  const posted: Record<string, unknown>[] = []
  let created = false
  let catalogUpdated = false
  const other = { id: 'two', title: 'Other session', project: 'other', workspace: 'D:/other' }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body && JSON.parse(String(init.body))
    if (body) posted.push(body)
    const reply = (data: unknown) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === base) {
      if (!body) return reply(created ? [session, other] : [other])
      created = true
      return reply(session)
    }
    if (path === `${base}/two/runs`) return reply([])
    if (path === `${base}/one` && init?.method === 'PATCH') { session.title = body.title; return reply(session) }
    if (path === `${base}/one` && init?.method === 'DELETE') { created = false; return { ok: true, status: 204 } }
    if (path === '/api/anti/models') return reply({ items: [
      { id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' },
      { id: 'gemini-4-hydrogen-low', display_name: 'Gemini 4 Hydrogen (Low)' },
      { id: 'alternate-medium', display_name: 'Alternate (Medium)' },
      { id: 'alternate-low', display_name: 'Alternate (Low)' },
      ...(catalogUpdated ? [{ id: 'gemini-4-neon-xhigh', display_name: 'Gemini 4 Neon (XHigh)' }] : []),
    ] })
    if (path === '/api/file-transfer/reply') return { ok: true, status: 204 }
    if (path === `${base}/one/runs`) {
      if (!body) return reply([...runs])
      const run = outcome === 'success'
        ? { ...body, id: 'run', status: 'success', answer: 'Done', artifact: 'D:/legacy/old-archive.md' }
        : { ...body, id: 'run', status: 'cli_error', error: 'AUTH_ERROR',
            error_detail: '请先使用官方 Antigravity CLI 登录，再重试。' }
      runs.push(run)
      session.title = body.prompt
      return reply(run)
    }
    throw new Error(`Unexpected request: ${path}`)
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const wait = (check: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    check()
  })
  const control = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
  async function choose(label: string, name: string) {
    await act(async () => control(label).click())
    const item = document.querySelector<HTMLElement>(`[role="option"][title="${name}"]`)
    expect(item?.querySelector(':scope > .model-select-label')?.textContent).toContain(name)
    await act(async () => item!.click())
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await wait(() => expect(host.textContent).toContain('Other project'))
    expect(control('项目目录')).toBeNull()
    await act(async () => control('新建会话').click())
    const dialog = document.querySelector('[role="dialog"]')!
    const create = dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!
    expect(control('项目目录').textContent).toContain('Other project')
    await choose('项目目录', 'Demo project')
    await act(async () => create.click())
    await wait(() => {
      expect(host.querySelector('.ga-page-header')?.textContent).not.toContain(session.workspace)
      expect(control('模型').querySelector(':scope > .model-select-label')?.textContent).toBe('Gemini 4 Hydrogen')
      expect(control('思考等级').querySelector(':scope > .model-select-label')?.textContent).toBe('high')
    })
    await wait(() => expect(cache.getQueryState(['anti-models'])?.status).toBe('success'))
    const header = host.querySelector('.ga-page-header')!
    expect(header.contains(control('模型'))).toBe(true)
    expect(header.contains(control('思考等级'))).toBe(true)
    expect(header.contains(control('文件传递箱'))).toBe(false)
    const transcript = host.querySelector('[data-anti-chat-scroll]')!
    expect(transcript.parentElement?.contains(control('文件传递箱'))).toBe(true)
    expect(transcript.contains(control('文件传递箱'))).toBe(false)
    expect(control('发送').previousElementSibling?.textContent).toBe('Plan')
    expect(transcript.classList.contains('pr-[76px]')).toBe(true)
    expect(transcript.classList.contains('overflow-y-auto')).toBe(true)
    expect(transcript.contains(host.querySelector('[data-file-composer]'))).toBe(false)
    expect(host.querySelector('[data-file-composer] textarea')?.getAttribute('aria-label')).toBe('发给 Anti')
    await choose('模型', 'Alternate')
    expect(control('思考等级').textContent).toContain('low')
    await choose('思考等级', 'medium')
    if (outcome === 'success') {
      await act(async () => {
        focusManager.setFocused(false)
        catalogUpdated = true
        cache.setQueryData(['anti-models'], cache.getQueryData(['anti-models']), { updatedAt: Date.now() - 61_000 })
        focusManager.setFocused(true)
      })
      await wait(() => expect(cache.getQueryData(['anti-models'])).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ id: 'gemini-4-neon-xhigh' })]),
      }))
      expect(control('模型').textContent).toContain('Alternate')
      expect(control('思考等级').textContent).toContain('medium')
      await choose('模型', 'Gemini 4 Neon')
      expect(control('思考等级').textContent).toContain('xhigh')
    }
    const input = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Read the project')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await wait(() => expect(control('发送').disabled).toBe(false))
    await act(async () => control('发送').click())
    await wait(() => {
      if (outcome === 'success') expect(host.textContent).toContain('Done')
      else {
        expect(host.textContent).toContain('AUTH_ERROR')
        expect(host.textContent).toContain('请先使用官方 Antigravity CLI 登录，再重试。')
      }
    })
    expect(posted).toEqual([{ project: 'demo' }, {
      prompt: 'Read the project',
      model: outcome === 'success' ? 'gemini-4-neon-xhigh' : 'alternate-medium',
      effort: outcome === 'success' ? 'xhigh' : 'medium',
      operation: expect.any(String),
    }])
    const toDocument = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '转成文档')
    const saved = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/file-transfer/reply'))
    expect(saved()).toEqual([])
    expect(host.textContent).not.toContain('共享产物')
    expect(host.textContent).not.toContain('old-archive.md')
    if (outcome === 'success') {
      expect(host.querySelector('button[title="复制结论"]')).not.toBeNull()
      await act(async () => toDocument!.click())
      expect(saved()).toHaveLength(1)
      expect(JSON.parse(saved()[0][1]!.body as string)).toEqual({
        text: 'Done', engine: 'anti', session_id: 'one', project: 'demo',
      })
    } else expect(toDocument).toBeUndefined()
    const row = () => host.querySelector('[title="Read the project"]')
    await wait(() => expect(row()).not.toBeNull())
    expect(host.textContent).toContain('Demo project')
    expect(host.textContent).toContain('Other project')
    await act(async () => row()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    const title = host.querySelector<HTMLInputElement>('input[aria-label="重命名 Read the project"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(title, 'Renamed')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    await wait(() => expect(host.textContent).toContain('Renamed'))
    const del = Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find(button => button.getAttribute('aria-label')?.includes('删除 Renamed'))!
    await act(async () => del.click())
    expect(host.textContent).toContain('删除会话？')
    const confirm = host.querySelector<HTMLButtonElement>('[role="alertdialog"] button')!
    expect(confirm.textContent).toBe('确认')
    await act(async () => confirm.click())
    await wait(() => {
      expect(host.querySelector('[aria-current="page"]')?.textContent).toContain(other.title)
      expect(host.textContent).not.toContain('Renamed')
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    focusManager.setFocused(undefined)
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('reloads the final trace even when the first live request is still pending', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const events: AntiEvent[] = [
    { seq: 1, type: 'step.update', step: { index: 1, kind: 'tool_call', tool: 'view_file', state: 'ACTIVE' } },
    { seq: 2, type: 'step.update', step: { index: 1, kind: 'tool_call', state: 'DONE', duration_seconds: 1 } },
    { seq: 3, type: 'step.update', step: { index: 2, kind: 'planner_response', text_delta: '先读取文件' } },
    { seq: 4, type: 'message.delta', text: '正文' },
  ]
  const loadEvents = vi.fn<(signal: AbortSignal) => Promise<AntiEvent[]>>()
    .mockImplementationOnce(signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    .mockResolvedValue(events)
  const onEventsChanged = vi.fn()
  const render = (active: boolean, runKey: string) => act(async () => root.render(
    <QueryClientProvider client={cache}>
      <AntiTaskProgress key={runKey} runKey={runKey} active={active} loadEvents={loadEvents} onEventsChanged={onEventsChanged}>
        {partial => <div data-testid="answer">{partial}</div>}
      </AntiTaskProgress>
    </QueryClientProvider>,
  ))
  try {
    await render(true, 'live')
    expect(loadEvents).toHaveBeenCalledTimes(1)
    const liveSignal = loadEvents.mock.calls[0][0]
    await render(false, 'live')
    expect(loadEvents).toHaveBeenCalledTimes(2)
    expect(liveSignal.aborted).toBe(true)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const steps = host.querySelectorAll('ol li')
    expect(steps).toHaveLength(2)
    expect(steps[0].textContent).toContain('读取文件')
    expect(steps[0].textContent).toContain('已完成')
    expect(steps[1].textContent).toContain('先读取文件')
    expect(host.querySelector('[data-testid="answer"]')?.textContent).toBe('正文')
    await render(false, 'historical')
    expect(loadEvents).toHaveBeenCalledTimes(2)
    const details = host.querySelector('details')!
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    expect(loadEvents).toHaveBeenCalledTimes(3)
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    vi.unstubAllGlobals()
  }
})
