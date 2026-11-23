// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it, vi, beforeEach } from 'vitest'
import AntiChat from './AntiChat'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'
import { resetPageState } from '@/utils/pageState'

beforeEach(() => {
  localStorage.clear()
  resetPageState()
})

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      projects: async () => ({
        items: [
          { name: 'demo', display_name: 'Demo project', path: 'D:/demo' },
          { name: 'other', display_name: 'Other project', path: 'D:/other' },
        ]
      }),
    },
  }
})
vi.mock('@/runtime/runtimeConfig', () => ({ resolveApiUrl: (path: string) => path }))

it('starts Anti on demand from the page header without leaving the chat', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let started = false
  let active = 'default'
  let rejectSwitch = true
  const profiles = [{ id: 'default', name: '系统默认' }, { id: 'work', name: '工作' }]
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') {
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('verify-anti-auth')
      return reply(started ? { state: 'ready', agy_available: true, auth_state: 'authenticated' } : { state: 'stopped' })
    }
    if (path === '/api/anti/profiles') return reply({ active, profiles })
    if (path === '/api/anti/profiles/work') {
      expect(init?.method).toBe('PATCH')
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('manage-agy-profiles')
      expect(JSON.parse(init?.body as string)).toEqual({ name: '主力' })
      profiles[1].name = '主力'
      return reply(profiles[1])
    }
    if (path === '/api/anti/profiles/work/switch') {
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('manage-agy-profiles')
      if (rejectSwitch) return { ok: false, json: async () => ({ detail: '还有运行中的任务' }) }
      active = 'work'
      return reply({ active, profiles })
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
      return reply({
        state: 'authenticated', rows: [{
          model: 'Example Model', limit: 'Weekly Limit Remaining', remaining_pct: 42.5,
          resets_at: '2026-11-20T08:00:00Z',
        }]
      })
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
    await wait(() => expect(button('启用 Agy')?.disabled).toBe(false))
    expect(button('启用 Agy')?.classList.contains('bg-status-danger')).toBe(true)
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(0)
    const usageButton = button('检测反重力额度')!
    const usageRequests = () => fetchMock.mock.calls.filter(([path]) => path === '/api/anti/account-usage')
    expect(usageButton.getAttribute('aria-disabled')).toBe('true')
    await act(async () => usageButton.click())
    expect(usageRequests()).toHaveLength(0)
    await act(async () => button('启用 Agy')!.click())
    await wait(() => expect(button('Agy 启动中')?.disabled).toBe(true))
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(1)
    await act(async () => cache.refetchQueries({ queryKey: ['anti-daemon-status'] }))
    await wait(() => expect(button('Agy ACP 运行中')?.disabled).toBe(true))
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
    const accountButton = () => [...host.querySelectorAll('header button')]
      .find(button => button.getAttribute('aria-label')?.startsWith('Agy 账号')) as HTMLButtonElement | undefined
    await wait(() => expect(accountButton()?.getAttribute('aria-label')).toBe('Agy 账号：系统默认'))
    expect(accountButton()?.textContent?.trim()).toBe('')
    await act(async () => accountButton()!.click())
    const dialog = document.querySelector('[role="dialog"][aria-labelledby="agy-accounts-title"]')
    expect(dialog?.parentElement?.parentElement).toBe(document.body)
    const switchButton = dialog?.querySelector<HTMLButtonElement>('button[aria-label="切换到工作"]')
    expect(switchButton).toBeDefined()
    await act(async () => switchButton!.click())
    await wait(() => expect(dialog?.querySelector('[role="alert"]')?.textContent).toBe('还有运行中的任务'))
    expect(accountButton()?.getAttribute('aria-label')).toBe('Agy 账号：系统默认')
    rejectSwitch = false
    await act(async () => switchButton!.click())
    await wait(() => expect(accountButton()?.getAttribute('aria-label')).toBe('Agy 账号：工作'))
    const edit = dialog?.querySelector<HTMLButtonElement>('button[aria-label="修改备注：工作"]')
    expect(edit).toBeTruthy()
    await act(async () => edit!.click())
    const nameField = dialog?.querySelector<HTMLInputElement>('#agy-edit-name')
    expect(nameField?.value).toBe('工作')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameField, '  主力  ')
      nameField!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const save = [...dialog!.querySelectorAll('button')].find(button => button.textContent === '保存备注')!
    expect(save.disabled).toBe(false)
    await act(async () => save.click())
    await wait(() => expect(accountButton()?.getAttribute('aria-label')).toBe('Agy 账号：主力'))
    expect(dialog?.querySelector('#agy-edit-name')).toBeNull()
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
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({
      items: [
        { id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' },
        { id: 'gemini-4-hydrogen-low', display_name: 'Gemini 4 Hydrogen (Low)' },
        { id: 'alternate-medium', display_name: 'Alternate (Medium)' },
        { id: 'alternate-low', display_name: 'Alternate (Low)' },
        ...(catalogUpdated ? [{ id: 'gemini-4-neon-xhigh', display_name: 'Gemini 4 Neon (XHigh)' }] : []),
      ]
    })
    if (path === '/api/file-transfer/reply') return { ok: true, status: 204 }
    if (path === `${base}/one/runs`) {
      if (!body) return reply([...runs])
      const run = outcome === 'success'
        ? { ...body, id: 'run', status: 'success', answer: 'Done', artifact: 'D:/legacy/old-archive.md' }
        : {
          ...body, id: 'run', status: 'cli_error', error: 'AUTH_ERROR',
          error_detail: '请先使用官方 Antigravity CLI 登录，再重试。'
        }
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
    await wait(() => expect(cache.getQueryState(['anti-models', 'default'])?.status).toBe('success'))
    const header = host.querySelector('.ga-page-header')!
    expect(header.contains(control('模型'))).toBe(true)
    expect(header.contains(control('思考等级'))).toBe(true)
    expect(header.contains(control('中转箱'))).toBe(false)
    const transcript = host.querySelector('[data-anti-chat-scroll]')!
    expect(transcript.parentElement?.contains(control('中转箱'))).toBe(true)
    expect(transcript.contains(control('中转箱'))).toBe(false)
    expect(control('发送').previousElementSibling?.textContent).toBe('Plan')
    expect(control('发送').previousElementSibling?.querySelector('button')?.className).toContain('h-10')
    expect(control('发送').previousElementSibling?.className).toContain('mb-0.5')
    expect(control('发送').className).toContain('mb-0.5')
    expect(host.querySelector('[data-file-composer] label[aria-label="添加文件"]')).not.toBeNull()
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
        cache.setQueryData(['anti-models', 'default'], cache.getQueryData(['anti-models', 'default']), { updatedAt: Date.now() - 61_000 })
        focusManager.setFocused(true)
      })
      await wait(() => expect(cache.getQueryData(['anti-models', 'default'])).toMatchObject({
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
      mode: 'plan',
      permission_mode: 'approval-required',
      operation: expect.any(String),
    }])
    const toDocument = host.querySelector<HTMLButtonElement>('button[title="放入中转箱"]') ?? undefined
    const saved = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/api/file-transfer/reply'))
    expect(saved()).toEqual([])
    expect(host.textContent).not.toContain('共享产物')
    expect(host.textContent).not.toContain('old-archive.md')
    if (outcome === 'success') {
      expect(host.querySelector('button[title="复制结论"]')?.textContent).toBe('')
      expect(toDocument?.textContent).toBe('')
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

it('supports profile capture/delete, gateway stop/restart, quota pool reset, and SSE streaming', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let gatewayState = 'ready'
  let profilesList: Array<Record<string, unknown>> = [
    {
      id: 'default',
      name: '系统默认',
      has_credentials: true,
      auth_state: 'authenticated',
      usage: {
        checked_at: '2026-11-20T08:00:00Z',
        min_remaining_pct: 65,
        rows: [{ model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 65, resets_at: '2026-11-20T08:00:00Z' }],
      },
    },
    { id: 'work', name: '工作', has_credentials: false, auth_state: 'login_required' },
  ]
  let pools: Array<Record<string, unknown>> = [{
    model_group: 'gemini-4',
    display_name: 'Gemini 4',
    status: 'cooling_down',
    cooldown_remaining_seconds: 30,
    window_5h_pct: 64,
    window_7d_pct: 28,
  }]

  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(JSON.stringify(data)),
    })
    if (path === '/api/anti/status') {
      return reply({ state: gatewayState, agy_available: true, auth_state: 'authenticated' })
    }
    if (path === '/api/anti/stop') {
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('stop-anti')
      gatewayState = 'stopped'
      return reply({ state: 'stopped' })
    }
    if (path === '/api/anti/restart') {
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('restart-anti')
      gatewayState = 'ready'
      return reply({ state: 'ready', agy_available: true, auth_state: 'authenticated' })
    }
    if (path === '/api/anti/profiles') {
      return reply({ active: 'default', profiles: profilesList })
    }
    if (path === '/api/anti/profiles/capture') {
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('manage-agy-profiles')
      const body = JSON.parse(String(init?.body))
      const created = { id: 'cloned', name: body.name, has_credentials: true, auth_state: 'authenticated' }
      profilesList = [...profilesList, created]
      return reply(created)
    }
    if (path === '/api/anti/profiles/work' && init?.method === 'DELETE') {
      profilesList = profilesList.filter(p => p.id !== 'work')
      return reply(undefined, 204)
    }
    if (path === '/api/anti/quota') {
      return reply(pools)
    }
    if (path === '/api/anti/stats?window_hours=24') {
      return reply({
        window_hours: 24,
        total_runs: 5,
        success_runs: 4,
        failed_runs: 1,
        rate_limited_runs: 0,
        total_tokens: 12000,
        cache_hit_ratio: 0.4,
        estimated_cost_usd: 0.1,
      })
    }
    if (path === '/api/anti/logs?lines=80') {
      return reply({ lines: ['[INFO] AntiCLI ready'], log_path: 'C:/data/logs/anticli-daemon.log' })
    }
    if (path === '/api/anti/profiles/cloned/logout') {
      profilesList = profilesList.map(p => p.id === 'cloned' ? { id: 'cloned', name: '克隆号', has_credentials: false } : p)
      return reply({ id: 'cloned', name: '克隆号', has_credentials: false })
    }
    if (path === '/api/anti/breaker/reset') {
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('manage-anti-gateway')
      pools = [{ model_group: 'gemini-4', display_name: 'Gemini 4', status: 'normal', cooldown_remaining_seconds: 0, window_5h_pct: 64, window_7d_pct: 28 }]
      return reply(undefined, 204)
    }
    if (path === '/api/anti/sessions') return reply([])
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)) })

  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={['/anti']}>
        <QueryClientProvider client={cache}>
          <AntiChat />
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    await flush()

    // Gateway restart & stop buttons work directly from the header
    const restartBtn = host.querySelector('button[aria-label="重置 Agy 运行时"]') as HTMLButtonElement
    expect(restartBtn).toBeTruthy()
    await act(async () => { restartBtn.click() })
    await flush()

    // Quota button displays cached percentage immediately on hover & allows pool/breaker inspection
    const usageBtn = host.querySelector('button[aria-label="检测反重力额度"]') as HTMLButtonElement
    await act(async () => { usageBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    await flush()
    expect(document.body.textContent).toContain('65%')
    const checkPoolsBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '查看本地配额池 / 熔断') as HTMLButtonElement
    await act(async () => { checkPoolsBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('冷却 30s')
    expect(document.body.textContent).toContain('5h 窗口 64%')
    expect(document.body.textContent).toContain('7d 窗口 28%')
    expect(document.body.textContent).toContain('24h 5 次')
    const resetBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '重置熔断') as HTMLButtonElement
    await act(async () => { resetBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('正常')

    // Profile modal: capture current login, inspect logs, clear credentials, & delete inactive profile
    const accountsBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Agy 账号：')) as HTMLButtonElement
    await act(async () => { accountsBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('已验证登录')
    expect(document.body.textContent).toContain('最低剩余 65%')

    const logsBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'ACP 日志') as HTMLButtonElement
    await act(async () => { logsBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('[INFO] AntiCLI ready')

    const nameInput = document.body.querySelector('#agy-profile-name') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(nameInput, '克隆号')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const captureBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '从当前登录另存') as HTMLButtonElement
    await act(async () => { captureBtn.click() })
    await flush()
    expect(profilesList.some(p => p.name === '克隆号')).toBe(true)

    const logoutBtn = document.body.querySelector('button[aria-label="清除凭据：克隆号"]') as HTMLButtonElement
    await act(async () => { logoutBtn.click() })
    await flush()
    expect(profilesList.find(p => p.id === 'cloned')?.has_credentials).toBe(false)

    const delBtn = document.body.querySelector('button[aria-label="删除账号：工作"]') as HTMLButtonElement
    await act(async () => { delBtn.click() })
    const confirmDel = document.body.querySelector('button[aria-label="确认删除：工作"]') as HTMLButtonElement
    await act(async () => { confirmDel.click() })
    await flush()
    expect(profilesList.some(p => p.id === 'work')).toBe(false)

    // Close profile modal and stop gateway; offline cached quota remains visible on hover
    const closeModalBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '关闭') as HTMLButtonElement
    await act(async () => { closeModalBtn.click() })
    await flush()

    const stopBtn = host.querySelector('button[aria-label="停止 Agy 运行时"]') as HTMLButtonElement
    await act(async () => { stopBtn.click() })
    await flush()
    expect(host.textContent).toContain('启用 Agy')
    await act(async () => { usageBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    await flush()
    expect(document.body.textContent).toContain('离线缓存')
    expect(document.body.textContent).toContain('65%')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('streams live events via EventSource when streamUrl is provided', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let activeSource: {
    onopen: (() => void) | null
    onmessage: ((event: MessageEvent<string>) => void) | null
    close: ReturnType<typeof vi.fn>
  } | null = null
  class FakeEventSource {
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: (() => void) | null = null
    close = vi.fn()
    addEventListener = vi.fn()
    constructor(_url: string) {
      activeSource = this
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource)

  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } })
  const host = document.createElement('div')
  const root = createRoot(host)
  const loadEvents = vi.fn<(signal: AbortSignal) => Promise<AntiEvent[]>>().mockResolvedValue([])
  const onEventsChanged = vi.fn()

  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <AntiTaskProgress
          runKey="sse-run"
          active
          loadEvents={loadEvents}
          streamUrl="/api/anti/sessions/s1/runs/r1/events/stream"
          onEventsChanged={onEventsChanged}
        >
          {partial => <div data-testid="sse-answer">{partial}</div>}
        </AntiTaskProgress>
      </QueryClientProvider>,
    ))
    expect(activeSource).not.toBeNull()
    await act(async () => {
      activeSource?.onopen?.()
      activeSource?.onmessage?.(new MessageEvent('message', {
        data: JSON.stringify({ seq: 1, type: 'message.delta', text: '流式回复片段' }),
      }))
    })
    expect(host.querySelector('[data-testid="sse-answer"]')?.textContent).toBe('流式回复片段')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    vi.unstubAllGlobals()
  }
})

it('uploads and submits attachments in AgyChat composer even without text', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = vi.fn(() => 'blob:shot')
  URL.revokeObjectURL = vi.fn()
  const session = { id: 'att-s1', title: '', project: 'demo', workspace: 'D:/demo' }
  const runs: Record<string, unknown>[] = []
  const posted: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') return reply({ state: 'ready', agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs` && !init?.body) return reply([...runs])
    if (path === '/api/upload') {
      return reply({
        file_id: 'img-1',
        name: 'shot.png',
        path: 'C:/uploads/img-1.png',
        url: '/api/files/img-1.png',
        mime: 'image/png',
        size: 42,
      })
    }
    if (path === `/api/anti/sessions/${session.id}/runs` && init?.body) {
      const body = JSON.parse(String(init.body))
      posted.push(body)
      const run = { ...body, id: 'run-att', status: 'success', answer: '看到了截图' }
      runs.push(run)
      return reply(run)
    }
    throw new Error(`Unexpected request: ${path}`)
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)) })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await flush()

    const fileInput = host.querySelector<HTMLInputElement>('[data-file-composer] input[type="file"]')!
    expect(fileInput).toBeTruthy()
    const file = new File(['png-data'], 'shot.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    expect(host.querySelector('[data-file-composer] [data-attachment-kind="image"] img')).toBeTruthy()
    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
    expect(sendBtn.disabled).toBe(false)

    await act(async () => { sendBtn.click() })
    await flush()

    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      prompt: '',
      attachments: [{
        path: 'C:/uploads/img-1.png',
        name: 'shot.png',
        source: 'managed_upload',
        size: 42,
      }],
    })
    expect(host.textContent).toContain('看到了截图')
    expect(host.querySelector('[data-anti-chat-scroll] img[alt="shot.png"]')).toBeTruthy()
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    vi.unstubAllGlobals()
  }
})

it('shows external gateway lock and login_required / unavailable banners clearly', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let statusPayload: Record<string, unknown> = {
    state: 'ready',
    agy_available: true,
    auth_state: 'login_required',
    managed: false,
    port: 8787,
    version: '0.2.0',
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') return reply(statusPayload)
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([])
    throw new Error(`Unexpected request: ${path}`)
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)) })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await flush()

    expect(host.textContent).toContain('当前 Agy 账号尚未登录或凭据已过期')
    const stopBtn = host.querySelector<HTMLButtonElement>('button[aria-label="停止 Agy 运行时"]')!
    const restartBtn = host.querySelector<HTMLButtonElement>('button[aria-label="重置 Agy 运行时"]')!
    expect(stopBtn.disabled).toBe(true)
    expect(restartBtn.disabled).toBe(true)

    const loginBtn = [...host.querySelectorAll('button')].find(b => b.textContent === '去登录账号') as HTMLButtonElement
    await act(async () => { loginBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('外部运行中')
    const closeBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '关闭') as HTMLButtonElement
    await act(async () => { closeBtn.click() })
    await flush()

    statusPayload = { state: 'unavailable', detail: '本机端口 8787 健康检查超时' }
    await act(async () => { await cache.refetchQueries({ queryKey: ['anti-daemon-status'] }) })
    await flush()
    expect(host.textContent).toContain('本机端口 8787 健康检查超时')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('supports Edit mode switching, permission policy selection, and interactive ACP approval', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 'acp-s1', title: 'Edit flow', project: 'demo', workspace: 'D:/demo' }
  const approvalId = 'b'.repeat(32)
  const runs: Record<string, unknown>[] = []
  const approvalCalls: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') return reply({ state: 'ready', agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs` && !init?.body) return reply([...runs])
    if (path === `/api/anti/sessions/${session.id}/runs` && init?.body) {
      const body = JSON.parse(String(init.body))
      const run = {
        ...body,
        id: 'run-edit-1',
        status: 'running',
        approval: {
          id: approvalId,
          title: 'Run shell command',
          details: 'pytest tests/',
          prompt_type: 'approval',
          tool_kind: 'execute',
          allow_always: true,
          security_warning: 'Will run commands automatically in this session',
        },
      }
      runs.push(run)
      return reply(run)
    }
    if (path === `/api/anti/sessions/${session.id}/runs/run-edit-1` && !init?.body) {
      return reply(runs[0])
    }
    if (path === `/api/anti/sessions/${session.id}/runs/run-edit-1/events`) return reply([])
    if (path === `/api/anti/sessions/${session.id}/runs/run-edit-1/approval`) {
      const body = JSON.parse(String(init?.body))
      approvalCalls.push(body)
      expect(new Headers(init?.headers).get('X-GA-Hub-Action')).toBe('approve-agy')
      runs[0] = { ...runs[0], status: 'success', answer: '测试已全部通过', approval: null }
      return reply(runs[0])
    }
    throw new Error(`Unexpected request: ${path}`)
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)) })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await flush()

    const modeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="当前为规划模式，点击切换到编辑模式"]')!
    await act(async () => { modeBtn.click() })
    await flush()
    expect(modeBtn.textContent).toBe('Edit')

    const permSelect = host.querySelector<HTMLSelectElement>('select[aria-label="权限策略"]')!
    await act(async () => {
      permSelect.value = 'auto-accept-edits'
      permSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()

    const input = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Run tests')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
    await act(async () => { sendBtn.click() })
    await flush()

    expect(runs[0]).toMatchObject({ mode: 'accept-edits', permission_mode: 'auto-accept-edits' })
    expect(host.textContent).toContain('Run shell command')
    expect(host.textContent).toContain('Will run commands automatically in this session')

    const allowAlwaysBtn = [...host.querySelectorAll('button')].find(b => b.textContent === '本会话始终允许') as HTMLButtonElement
    await act(async () => { allowAlwaysBtn.click() })
    await flush()

    expect(approvalCalls).toEqual([{ approval_id: approvalId, decision: 'allow_always' }])
    expect(host.textContent).toContain('测试已全部通过')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('wires slash commands, ACP session reset, run usage footer, quota calibration, interaction questions, and code login', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = {
    id: 'full-s1',
    title: 'Full ACP',
    project: 'demo',
    workspace: 'D:/demo',
    has_conversation: true,
    acp_connected: true,
  }
  const qApprovalId = 'c'.repeat(32)
  const runs: Record<string, unknown>[] = [{
    id: 'run-hist',
    operation: 'op-hist',
    prompt: 'Earlier edit',
    status: 'success',
    answer: '已完成初始化修改',
    mode: 'accept-edits',
    permission_mode: 'auto-accept-edits',
    usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 60, thinking_tokens: 0 },
  }]
  const eventsCalled: string[] = []
  let calibratedPct: number | null = null
  let codeSubmitted = ''
  let resetCalls = 0
  const approvalCalls: Record<string, unknown>[] = []

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') return reply({ state: 'ready', agy_available: true, auth_state: 'authenticated', version: '1.5.14' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/commands') return reply({ items: [{ name: 'plan', description: '先生成方案', hint: '<goal>' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/reset`) {
      resetCalls += 1
      return reply({ ...session, acp_connected: false })
    }
    if (path === `/api/anti/sessions/${session.id}/runs` && !init?.body) return reply([...runs])
    if (path === `/api/anti/sessions/${session.id}/runs` && init?.body) {
      const body = JSON.parse(String(init.body))
      const next = {
        ...body,
        id: 'run-q',
        status: 'running',
        approval: {
          id: qApprovalId,
          title: 'Agy 提问',
          details: '请选择目标分支',
          prompt_type: 'question',
          tool_kind: 'other',
          allow_always: false,
          question: {
            question: '请选择目标分支',
            options: [{ id: 'main', label: 'main 分支' }, { id: 'dev', label: 'dev 分支' }],
          },
        },
      }
      runs.push(next)
      return reply(next)
    }
    if (path === `/api/anti/sessions/${session.id}/runs/run-q` && !init?.body) return reply(runs[1])
    if (path.endsWith('/events')) {
      eventsCalled.push(path)
      return reply([])
    }
    if (path === `/api/anti/sessions/${session.id}/runs/run-q/approval`) {
      const body = JSON.parse(String(init?.body))
      approvalCalls.push(body)
      runs[1] = { ...runs[1], status: 'success', answer: '已按 dev 分支处理', approval: null }
      return reply(runs[1])
    }
    if (path === '/api/anti/quota') {
      return reply([{
        model_group: 'gemini-4',
        display_name: 'Gemini 4',
        status: 'normal',
        cooldown_remaining_seconds: 0,
        window_5h_pct: 40,
        window_7d_pct: 20,
        calibrated_remaining_pct: calibratedPct,
        estimated_cost_7d_usd: 0.42,
      }])
    }
    if (path === '/api/anti/stats?window_hours=24') {
      return reply({
        window_hours: 24, total_runs: 2, success_runs: 2, failed_runs: 0,
        rate_limited_runs: 0, total_tokens: 150, cache_hit_ratio: 0.5, estimated_cost_usd: 0.12,
      })
    }
    if (path === '/api/anti/quota/calibrate') {
      const body = JSON.parse(String(init?.body))
      calibratedPct = body.remaining_pct
      return reply({
        model_group: 'gemini-4',
        display_name: 'Gemini 4',
        status: 'normal',
        cooldown_remaining_seconds: 0,
        calibrated_remaining_pct: calibratedPct,
      })
    }
    if (path === '/api/anti/profiles/default/login/start') {
      return reply({
        flow_id: 'flow-1',
        profile_id: 'default',
        phase: 'waiting_code',
        authorization_url: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
        error: null,
      })
    }
    if (path === '/api/anti/profiles/login/submit/flow-1') {
      codeSubmitted = JSON.parse(String(init?.body)).code
      return reply({ flow_id: 'flow-1', profile_id: 'default', phase: 'completed', authorization_url: null, error: null })
    }
    if (path === '/api/anti/profiles/login/status/flow-1') {
      return reply({ flow_id: 'flow-1', profile_id: 'default', phase: 'waiting_code', authorization_url: 'https://accounts.google.com/o/oauth2/auth?client_id=test', error: null })
    }
    throw new Error(`Unexpected request: ${path}`)
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await Promise.resolve(); await new Promise(r => setTimeout(r, 0)) })
  const wait = (check: () => void) => vi.waitFor(async () => {
    await flush()
    check()
  })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await wait(() => expect(host.textContent).toContain('Edit · 自动改文件'))

    // 1. History run badge & token usage footer
    expect(host.textContent).toContain('120 in · 30 out · 缓存 50%')

    // 2. Session ACP reset button
    const resetBtn = host.querySelector<HTMLButtonElement>('button[aria-label="重连 ACP 会话"]')!
    await act(async () => { resetBtn.click() })
    await flush()
    expect(resetCalls).toBe(1)

    // 3. Quota pool inline calibration
    const usageBtn = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    await act(async () => { usageBtn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    await flush()
    const checkPools = [...document.body.querySelectorAll('button')].find(b => b.textContent === '查看本地配额池 / 熔断') as HTMLButtonElement
    await act(async () => { checkPools.click() })
    await flush()
    const calBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="校准 Gemini 4"]')!
    await act(async () => { calBtn.click() })
    await flush()
    const pctInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Gemini 4 剩余百分比"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(pctInput, '88')
      pctInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const saveCalBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '保存') as HTMLButtonElement
    await act(async () => { saveCalBtn.click() })
    await flush()
    expect(calibratedPct).toBe(88)
    expect(document.body.textContent).toContain('已校准剩余 88%')

    // 4. Native slash command picker + interaction_* question card
    const slashBtn = host.querySelector<HTMLButtonElement>('button[aria-label="插入原生命令"]')!
    await act(async () => { slashBtn.click() })
    await flush()
    const planOption = [...host.querySelectorAll('[role="listbox"] button')].find(b => b.textContent?.includes('/plan')) as HTMLButtonElement
    await act(async () => { planOption.click() })
    await flush()
    const textarea = host.querySelector('textarea')!
    expect(textarea.value).toBe('/plan ')

    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
    await act(async () => { sendBtn.click() })
    await flush()
    expect(host.textContent).toContain('请选择目标分支')
    const devChoice = [...host.querySelectorAll('button')].find(b => b.textContent === 'dev 分支') as HTMLButtonElement
    await act(async () => { devChoice.click() })
    await flush()
    expect(approvalCalls).toEqual([{ approval_id: qApprovalId, decision: 'allow', option_id: 'dev' }])
    expect(host.textContent).toContain('已按 dev 分支处理')

    // 5. In-app Google code login flow in AntiAgyProfiles
    const accBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Agy 账号：')) as HTMLButtonElement
    await act(async () => { accBtn.click() })
    await flush()
    const codeLoginBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="授权码登录：系统默认"]')!
    await act(async () => { codeLoginBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('https://accounts.google.com/o/oauth2/auth?client_id=test')
    const codeInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Google 授权码"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(codeInput, 'auth-code-xyz')
      codeInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submitCodeBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '提交授权码') as HTMLButtonElement
    await act(async () => { submitCodeBtn.click() })
    await flush()
    expect(codeSubmitted).toBe('auth-code-xyz')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('shows cooldown badge on profiles and offers account switch CTA when submit hits 429', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-429', title: 'Cooldown test', project: 'demo', workspace: 'D:/demo' }
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({
      active: 'default',
      profiles: [
        { id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated', cooldown_seconds: 45 },
        { id: 'backup', name: '备用账号', has_credentials: true, auth_state: 'authenticated' },
      ],
    })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === '/api/anti/sessions/s-429/runs' && !init?.body) return reply([])
    if (path === '/api/anti/sessions/s-429/runs' && init?.method === 'POST') {
      return reply({ detail: '当前账号处于风控冷却期（剩余 45 秒）' }, 429)
    }
    if (path.startsWith('/api/file-transfer')) return reply([])
    return reply({})
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await flush()
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'hello')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
    await act(async () => { sendBtn.click() })
    await flush()
    expect(host.textContent).toContain('切换可用账号')
    const switchCta = [...host.querySelectorAll('button')].find(b => b.textContent === '切换可用账号') as HTMLButtonElement
    await act(async () => { switchCta.click() })
    await flush()
    expect(document.body.textContent).toContain('风控冷却 45s')
    expect(document.body.textContent).toContain('备用账号')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})
