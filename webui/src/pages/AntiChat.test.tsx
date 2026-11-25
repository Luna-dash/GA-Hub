// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it, vi, beforeEach } from 'vitest'
import AntiChat from './AntiChat'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'
import {
  AntiAccountUsageButton,
  AUTO_USAGE_REFRESH_INTERVAL_MS,
  resetAntiUsageAutoRefreshForTests,
} from '@/components/AntiAccountUsageButton'
import { resetPageState } from '@/utils/pageState'

beforeEach(() => {
  localStorage.clear()
  resetPageState()
  resetAntiUsageAutoRefreshForTests()
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
vi.mock('@/runtime/runtimeConfig', () => ({
  resolveApiUrl: (path: string) => path,
  getRuntimeConfig: () => ({ apiOrigin: '' }),
}))

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
    if (path === '/api/anti/quota') return reply([])
    if (path === '/api/anti/stats?today=true') {
      return reply({
        window_hours: 24, total_runs: 0, success_runs: 0, failed_runs: 0,
        rate_limited_runs: 0, total_tokens: 0, cache_hit_ratio: 0, estimated_cost_usd: 0,
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
    const quotaDialog = () => document.body.querySelector('[role=dialog][aria-label="反重力剩余额度"]')
    await act(async () => usageButton.click())
    expect(quotaDialog()?.textContent).toContain('请先启用 Agy 运行时。')
    expect(usageRequests()).toHaveLength(0)
    await act(async () => usageButton.click())
    await act(async () => button('启用 Agy')!.click())
    await wait(() => expect(button('Agy 启动中')?.disabled).toBe(true))
    expect(fetchMock.mock.calls.filter(([path]) => path === '/api/anti/start')).toHaveLength(1)
    await act(async () => cache.refetchQueries({ queryKey: ['anti-daemon-status'] }))
    await wait(() => expect(button('Agy ACP 运行中')?.disabled).toBe(true))
    expect(host.querySelector('[role=img][aria-label="agy 已验证登录"]')).not.toBeNull()
    expect(usageRequests()).toHaveLength(0)
    expect(usageButton.closest('header')).not.toBeNull()
    expect(host.querySelector('[role=group][aria-label="Anti 状态"]')?.contains(usageButton)).toBe(false)
    await act(async () => usageButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(quotaDialog()).toBeNull()
    expect(usageRequests()).toHaveLength(0)
    usageButton.focus()
    await act(async () => usageButton.click())
    await wait(() => expect(quotaDialog()?.textContent).toContain('42.5%'))
    expect(usageButton.getAttribute('aria-expanded')).toBe('true')
    expect(quotaDialog()?.closest('header')).toBeNull()
    expect(usageRequests()).toHaveLength(1)
    expect(quotaDialog()?.textContent).toContain('Example Model')
    expect(quotaDialog()?.textContent).toContain('每周额度')
    expect(quotaDialog()?.querySelector('time')?.dateTime).toBe('2026-11-20T08:00:00Z')
    expect(document.activeElement).toBe(quotaDialog())
    await act(async () => quotaDialog()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(quotaDialog()).toBeNull()
    expect(document.activeElement).toBe(usageButton)
    expect(usageRequests()).toHaveLength(1)
    expect(host.querySelector('output')?.dataset.page).toBe('/anti')
    const accountButton = () => [...host.querySelectorAll('header button')]
      .find(button => button.getAttribute('aria-label')?.startsWith('Agy 账号')) as HTMLButtonElement | undefined
    await wait(() => expect(accountButton()?.getAttribute('aria-label')).toBe('Agy 账号：系统默认'))
    expect(accountButton()?.textContent?.trim()).toBe('系统默认')
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
    const editRow = edit!.closest('li')!
    await act(async () => edit!.click())
    const nameField = dialog?.querySelector<HTMLInputElement>('#agy-edit-name')
    expect(nameField?.value).toBe('工作')
    expect(editRow.querySelector('#agy-edit-name')).toBe(nameField)
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
      expect(control('模型').querySelector('[data-anti-effort-badge]')?.textContent).toBe('High')
    })
    await wait(() => expect(cache.getQueryState(['anti-models', 'default'])?.status).toBe('success'))
    const header = host.querySelector('.ga-page-header')!
    expect(header.contains(control('模型'))).toBe(true)
    expect(control('模型').querySelector('svg[data-channel]')).toBeNull()
    expect(control('思考等级')).toBeNull()
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
    expect(host.querySelector('[data-file-composer] textarea')?.getAttribute('aria-label')).toBe('发给 Agy')
    expect(transcript.getAttribute('tabindex')).toBe('-1')
    async function chooseEffort(level: string) {
      await act(async () => control('模型').click())
      const radio = document.querySelector<HTMLButtonElement>(`[role="radiogroup"][aria-label="思考等级"] [role="radio"][data-anti-effort-option="${level}"]`)
      expect(radio).not.toBeNull()
      await act(async () => radio!.click())
    }
    await choose('模型', 'Alternate')
    expect(control('模型').querySelector('[data-anti-effort-badge]')?.textContent).toBe('Low')
    await chooseEffort('medium')
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
      expect(control('模型').querySelector('[data-anti-effort-badge]')?.textContent).toBe('Med')
      await choose('模型', 'Gemini 4 Neon')
      expect(control('模型').querySelector('[data-anti-effort-badge]')?.textContent).toBe('XHigh')
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
        rows: [
          { model: 'Gemini 4', limit: 'Five Hour Limit Remaining', remaining_pct: 80, resets_at: '2026-11-20T08:00:00Z' },
          { model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 65, resets_at: '2026-11-20T08:00:00Z' },
        ],
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
    if (path === '/api/anti/account-usage') return reply(profilesList[0].usage)
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
    if (path === '/api/anti/stats?today=true') {
      return reply({
        window_hours: 24,
        total_runs: 5,
        success_runs: 4,
        failed_runs: 1,
        rate_limited_runs: 0,
        total_tokens: 12000,
        model_calls: 19,
        tokens_per_sec: 72.4,
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

    // Quota button displays cached percentage, auto-loads usage stats, and surfaces 429 cooldown unlock only when cooling down
    const usageBtn = host.querySelector('button[aria-label="检测反重力额度"]') as HTMLButtonElement
    await act(async () => { usageBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.textContent).toContain('65%')
      expect(document.body.textContent).toContain('触发 429 冷却')
      expect(document.body.textContent).toContain('Gemini 4 30s')
      expect(document.body.textContent).toContain('今日 5 轮 · 19 次调用（成功 4）')
      expect(document.body.textContent).toContain('12k tok · 72.4 tok/s · 缓存 40%')
    })
    expect(document.body.textContent).not.toContain('查看本地配额池')
    expect(document.body.textContent).not.toContain('5h 窗口 64%')
    const unlockBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '提前解锁') as HTMLButtonElement
    await act(async () => { unlockBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-anti-cooldown-alert]')).toBeNull()
      expect(document.body.textContent).toContain('今日 5 轮 · 19 次调用（成功 4）')
    })

    await act(async () => { usageBtn.click() })

    // Profile modal: defaults to 账号管理 tab, captures login, inspects logs, clears credentials, & deletes inactive profile
    const accountsBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Agy 账号：')) as HTMLButtonElement
    await act(async () => { accountsBtn.click() })
    await flush()
    expect(document.body.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('账号管理')
    expect(document.body.textContent).toContain('已验证登录')
    expect(document.body.textContent).toContain('5h 剩余 80%')

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

    // Close profile modal and stop gateway; offline cached quota remains available when opened
    const closeModalBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '关闭') as HTMLButtonElement
    await act(async () => { closeModalBtn.click() })
    await flush()

    const stopBtn = host.querySelector('button[aria-label="停止 Agy 运行时"]') as HTMLButtonElement
    await act(async () => { stopBtn.click() })
    await flush()
    expect(host.textContent).toContain('启用 Agy')
    await act(async () => { usageBtn.click() })
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

    const policyBtn = host.querySelector<HTMLButtonElement>('button[aria-label="执行与审批模式"]')!
    expect(policyBtn.textContent).toBe('Plan')
    await act(async () => { policyBtn.click() })
    await flush()

    const autoAcceptOpt = [...host.querySelectorAll<HTMLButtonElement>('[role="listbox"][aria-label="执行与审批模式选项"] [role="option"]')]
      .find(b => b.textContent?.includes('Edit · 自动改文件'))!
    await act(async () => { autoAcceptOpt.click() })
    await flush()
    expect(policyBtn.textContent).toBe('Edit · 自动改文件')

    const input = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Run tests')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
    await act(async () => { sendBtn.click() })
    await flush()

    expect(runs[0]).toMatchObject({ mode: 'accept-edits', permission_mode: 'auto-accept-edits' })
    const scrollArea = host.querySelector('[data-anti-chat-scroll]')!
    expect(scrollArea.querySelector('[data-anti-turn="0"] p[role="status"]')).toBeNull()
    const dock = host.querySelector('[data-anti-approval-dock]')!
    expect(dock).not.toBeNull()
    expect(scrollArea.contains(dock)).toBe(false)
    expect(scrollArea.querySelector('[data-anti-approval-inline-hint]')?.textContent).toContain('Run shell command')
    expect(dock.textContent).toContain('Run shell command')
    expect(dock.textContent).toContain('Will run commands automatically in this session')
    expect(host.querySelector('textarea')?.placeholder).toContain('等待上方审批确认')

    const toggleDetailBtn = dock.querySelector<HTMLButtonElement>('button[aria-label="收起审批详情"]')!
    await act(async () => { toggleDetailBtn.click() })
    await flush()
    expect(dock.textContent).not.toContain('Will run commands automatically in this session')
    expect(dock.querySelector('button[aria-label="展开审批详情"]')).not.toBeNull()

    const jumpDockBtn = [...scrollArea.querySelectorAll<HTMLButtonElement>('[data-anti-approval-inline-hint] button')]
      .find(b => b.textContent === '查看下方操作栏')!
    await act(async () => { jumpDockBtn.click() })
    await flush()
    expect(dock.textContent).toContain('Will run commands automatically in this session')

    const allowAlwaysBtn = [...dock.querySelectorAll('button')].find(b => b.textContent === '本会话始终允许') as HTMLButtonElement
    await act(async () => { allowAlwaysBtn.click() })
    await flush()

    expect(approvalCalls).toEqual([{ approval_id: approvalId, decision: 'allow_always' }])
    expect(host.querySelector('[data-anti-approval-dock]')).toBeNull()
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
  let commandItems = [
    { name: 'plan', description: '先生成方案', hint: '<goal>' },
    { name: 'teamwork', description: 'Coordinate multiple autonomous agents together' },
    { name: 'schedule', description: 'Run a scheduled prompt' },
  ]
  const approvalCalls: Record<string, unknown>[] = []
  let usageCalls = 0

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') return reply({ state: 'ready', agy_available: true, auth_state: 'authenticated', version: '1.5.14' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/commands') return reply({ items: commandItems })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === '/api/anti/account-usage') {
      usageCalls += 1
      if (usageCalls === 1) {
        return reply({
          state: 'authenticated',
          rows: [{ model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 100, resets_at: null }],
        })
      }
      return reply({
        state: 'unverified',
        rows: [],
        detail: '本地登录凭据已过期，请先发起一次对话或重新登录以续期。',
      })
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
    if (path === '/api/anti/stats?today=true') {
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

    // 2. Duplicate header buttons ("重连 ACP 会话", "压缩会话上下文", "同步上游模型") are removed from header
    expect(host.querySelector('button[aria-label="重连 ACP 会话"]')).toBeNull()
    expect(host.querySelector('button[aria-label="压缩会话上下文"]')).toBeNull()
    expect(host.querySelector('button[aria-label="同步上游模型"]')).toBeNull()

    // 3. Quota popover untouched reset display ("满额未消耗"), manual refresh button, detail diagnostic & compact 24h stats without cooldown alert
    const usageBtn = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    await act(async () => { usageBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('满额未消耗')
    expect(document.body.textContent).toContain('今日 2 轮（成功 2）')
    expect(document.body.textContent).toContain('150 tok · 缓存 50%')
    expect(document.body.querySelector('[data-anti-cooldown-alert]')).toBeNull()
    expect(document.body.textContent).not.toContain('查看本地配额池')
    const refreshQuotaBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新反重力额度"]')!
    expect(refreshQuotaBtn).not.toBeNull()
    await act(async () => { refreshQuotaBtn.click() })
    await flush()
    expect(usageCalls).toBe(2)
    expect(document.body.textContent).toContain('本地登录凭据已过期')

    // 4. Native slash command picker (typing '/' filters blocked/low-frequency items & Enter selects) & interaction_* question card
    expect(host.querySelector('button[aria-label="插入原生命令"]')).toBeNull()
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      const menuText = host.querySelector('[role="listbox"][aria-label="Agy 原生命令"]')?.textContent ?? ''
      expect(menuText).toContain('/plan')
      expect(menuText).toContain('已折叠 1 个低频命令')
      expect(menuText).not.toContain('/schedule')
      expect(menuText).not.toContain('/teamwork')
    })

    for (const key of ['Enter', 'Tab']) {
      const combo = new KeyboardEvent('keydown', { key, shiftKey: true, bubbles: true, cancelable: true })
      await act(async () => { textarea.dispatchEvent(combo) })
      expect(combo.defaultPrevented).toBe(false)
      expect(textarea.value).toBe('/')
    }

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/team')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    expect(host.querySelector('[role="listbox"][aria-label="Agy 原生命令"]')?.textContent).toContain('/teamwork')
    expect(host.querySelector('[role="listbox"][aria-label="Agy 原生命令"]')?.textContent).toContain('多 Agent 协作拆解大型任务')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/pl')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await flush()
    expect(textarea.value).toBe('/plan ')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    const planOption = [...host.querySelectorAll('[role="listbox"][aria-label="Agy 原生命令"] button')].find(b => b.textContent?.includes('/plan')) as HTMLButtonElement
    await act(async () => { planOption.click() })
    await flush()
    expect(textarea.value).toBe('/plan ')

    commandItems = []
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      const emptyMenu = host.querySelector('[role="listbox"][aria-label="Agy 原生命令"]')
      expect(emptyMenu?.textContent).toContain('当前没有可用的原生命令')
      expect(emptyMenu?.querySelector('[role="option"]')).toBeNull()
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await flush()
    expect(host.querySelector('[role="listbox"][aria-label="Agy 原生命令"]')).toBeNull()

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/plan ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()

    const sendBtn = host.querySelector<HTMLButtonElement>('button[aria-label="发送"]')!
    await act(async () => { sendBtn.click() })
    await flush()
    const qDock = host.querySelector('[data-anti-approval-dock]')!
    expect(host.querySelector('[data-anti-chat-scroll]')!.contains(qDock)).toBe(false)
    expect(qDock.textContent).toContain('请选择目标分支')
    const devChoice = [...qDock.querySelectorAll('button')].find(b => b.textContent === 'dev 分支') as HTMLButtonElement
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

it('shows iconic right-side transcript navigation dock in AntiChat when scrolled away from bottom', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-nav', title: 'Nav test', project: 'demo', workspace: 'D:/demo' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === '/api/anti/sessions/s-nav/runs') {
      return reply([
        { id: 'r1', operation: 'op1', prompt: 'First turn', status: 'success', answer: 'First answer', mode: 'plan', permission_mode: 'approval-required' },
        { id: 'r2', operation: 'op2', prompt: 'Second turn', status: 'success', answer: 'Second answer', mode: 'plan', permission_mode: 'approval-required' },
      ])
    }
    if (path.endsWith('/events')) return reply([])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.textContent).toContain('Second turn')
    })
    expect(host.querySelector('[aria-label="对话位置导航"]')).toBeNull()
    expect(host.querySelector('[aria-label="多轮会话选择器"]')).not.toBeNull()
    expect(host.querySelectorAll('[aria-label="多轮会话选择器"] button')).toHaveLength(2)
    const scroller = host.querySelector('[data-anti-chat-scroll]') as HTMLDivElement
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    await vi.waitFor(() => {
      expect(host.querySelector('[aria-label="对话位置导航"]')).not.toBeNull()
    })
    expect(host.querySelector('button[aria-label="跳到底部"]')?.textContent?.trim()).toBe('')
    expect(host.querySelector('button[aria-label="上一节"]')?.textContent?.trim()).toBe('')
    expect(host.querySelector('button[aria-label="下一节"]')?.textContent?.trim()).toBe('')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('renders chat-aligned bubble chrome, external metadata, floating slash popover, and persistent session drafts', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const sessions = [
    { id: 's-1', title: 'Session One', project: 'demo', workspace: 'D:/demo' },
    { id: 's-2', title: 'Session Two', project: 'demo', workspace: 'D:/demo' },
  ]
  const postedRuns: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/commands') return reply({ items: [{ name: 'plan', description: '先生成方案', hint: '<goal>' }] })
    if (path === '/api/anti/sessions') return reply(sessions)
    if (path === '/api/anti/sessions/s-1/runs' && !init?.body) {
      return reply([{
        id: 'r-done',
        operation: 'op-done',
        prompt: 'Inspect layout',
        status: 'success',
        answer: 'Aligned result',
        mode: 'plan',
        permission_mode: 'approval-required',
        started_at: '2026-11-24T09:00:00Z',
        finished_at: '2026-11-24T09:00:12Z',
        usage: { input_tokens: 120, output_tokens: 30, cache_read_tokens: 60, thinking_tokens: 0 },
      }])
    }
    if (path === '/api/anti/sessions/s-2/runs' && !init?.body) return reply([])
    if (path === '/api/anti/sessions/s-2/runs' && init?.body) {
      const body = JSON.parse(String(init.body))
      postedRuns.push(body)
      return reply({ ...body, id: 'r-2', status: 'success', answer: 'Received ref', started_at: '2026-11-24T09:05:00Z', finished_at: '2026-11-24T09:05:03Z' })
    }
    if (path.endsWith('/events')) return reply([])
    if (path.startsWith('/api/file-transfer')) {
      return reply([{ id: 7, name: 'spec.md', path: 'D:/demo/spec.md', size: 128, engine: 'anti', project: 'demo', available: true }])
    }
    return reply({})
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await vi.waitFor(async () => {
      await flush()
      expect(host.textContent).toContain('Aligned result')
    })

    const article = host.querySelector('[data-anti-turn="0"]')!
    expect(article.textContent).toContain('Agy Agent')
    expect(article.textContent).toContain('用时 0:12')
    expect(article.textContent).toContain('120 in · 30 out · 缓存 50%')
    const assistantBubble = article.querySelector('.group\\/msg')!
    expect(assistantBubble.textContent).not.toContain('120 in')
    expect(assistantBubble.querySelector('button[title="复制结论"]')).not.toBeNull()

    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    const slashMenu = host.querySelector('#slash-command-menu[role="listbox"][aria-label="Agy 原生命令"]')
    expect(slashMenu).not.toBeNull()
    expect(slashMenu?.className).toContain('bottom-[calc(100%+0.5rem)]')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Draft for s1')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const switchBtn = [...host.querySelectorAll('aside[aria-label="会话工作区"] button')].find(b => b.textContent?.includes('Session Two')) as HTMLButtonElement
    await act(async () => { switchBtn.click() })
    await flush()
    expect(host.querySelector('textarea')?.value).toBe('')

    const transferBtn = host.querySelector<HTMLButtonElement>('button[aria-label="中转箱"]')!
    await act(async () => { transferBtn.click() })
    await flush()
    const insertBtn = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('插入') || b.getAttribute('title')?.includes('spec.md')) as HTMLButtonElement | undefined
    if (insertBtn) {
      await act(async () => { insertBtn.click() })
      await flush()
      expect(host.querySelector('[data-file-composer] [data-attachment-kind="file"]')?.textContent).toContain('spec.md')
    }

    const backBtn = [...host.querySelectorAll('aside[aria-label="会话工作区"] button')].find(b => b.textContent?.includes('Session One')) as HTMLButtonElement
    await act(async () => { backBtn.click() })
    await flush()
    expect(host.querySelector('textarea')?.value).toBe('Draft for s1')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('reveals a single conversation collapse control when process details expand and collapses all open processes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-collapse', title: 'Collapse test', project: 'demo', workspace: 'D:/demo' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === '/api/anti/sessions/s-collapse/runs') {
      return reply([
        { id: 'r1', operation: 'op1', prompt: 'First turn', status: 'success', answer: 'First answer', mode: 'plan', permission_mode: 'approval-required' },
        { id: 'r2', operation: 'op2', prompt: 'Second turn', status: 'success', answer: 'Second answer', mode: 'plan', permission_mode: 'approval-required' },
      ])
    }
    if (path.endsWith('/events')) {
      return reply([{ seq: 1, type: 'step.update', step: { index: 1, kind: 'thought', state: 'DONE', text_delta: '思考内容' } }])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.textContent).toContain('Second answer')
    })

    expect(host.querySelector('[data-conversation-collapse]')).toBeNull()
    expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()

    const scroller = host.querySelector('[data-anti-chat-scroll]') as HTMLDivElement
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    })

    const detailsList = [...host.querySelectorAll<HTMLDetailsElement>('[data-anti-turn] details')]
    expect(detailsList).toHaveLength(2)

    await act(async () => {
      detailsList[0].open = true
      detailsList[0].dispatchEvent(new Event('toggle'))
      detailsList[1].open = true
      detailsList[1].dispatchEvent(new Event('toggle'))
    })
    expect(host.querySelectorAll('[data-conversation-collapse]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-collapse-to-latest]')).toHaveLength(1)

    await act(async () => {
      detailsList[0].open = false
      detailsList[0].dispatchEvent(new Event('toggle'))
    })
    expect(host.querySelectorAll('[data-collapse-to-latest]')).toHaveLength(1)

    await act(async () => {
      detailsList[1].open = false
      detailsList[1].dispatchEvent(new Event('toggle'))
    })
    expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()

    await act(async () => {
      detailsList[0].open = true
      detailsList[0].dispatchEvent(new Event('toggle'))
      detailsList[1].open = true
      detailsList[1].dispatchEvent(new Event('toggle'))
    })
    const collapseBtn = host.querySelector<HTMLButtonElement>('[data-collapse-to-latest]')!
    expect(collapseBtn).not.toBeNull()

    await act(async () => { collapseBtn.click() })
    expect(detailsList[0].open).toBe(false)
    expect(detailsList[1].open).toBe(false)
    expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
    expect(scroller.scrollTop).toBe(2000)
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('renders framed unnumbered progress outputs separately from the final conclusion', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-split', title: 'Split test', project: 'demo', workspace: 'D:/demo' }
  const savedBodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === '/api/anti/sessions/s-split/runs') {
      return reply([
        {
          id: 'r1',
          operation: 'op1',
          prompt: 'Multi-step question',
          status: 'success',
          progress_messages: ['阶段一：检查结构', '阶段二：跑完测试'],
          answer: '最终已完成修改',
          mode: 'plan',
          permission_mode: 'approval-required',
        },
        {
          id: 'r2',
          operation: 'op2',
          prompt: 'Simple question',
          status: 'success',
          progress_messages: [],
          answer: '单段直接回复',
          mode: 'plan',
          permission_mode: 'approval-required',
        },
      ])
    }
    if (path === '/api/file-transfer/reply' && init?.body) {
      savedBodies.push(JSON.parse(String(init.body)))
      return { ok: true, status: 204 }
    }
    if (path.endsWith('/events')) return reply([])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.textContent).toContain('单段直接回复')
    })

    const turn0 = host.querySelector('[data-anti-turn="0"]')!
    const progressBox = turn0.querySelector('section[data-anti-progress-outputs]')!
    expect(progressBox).not.toBeNull()
    expect(progressBox.querySelector('ol')).toBeNull()
    const list = progressBox.querySelector('ul')!
    expect(list.className).toContain('list-disc')
    const progressItems = [...list.querySelectorAll(':scope > li')].map(li => li.textContent?.trim())
    expect(progressItems).toEqual(['阶段一：检查结构', '阶段二：跑完测试'])

    const finalBox = turn0.querySelector('[data-anti-final-answer]')!
    expect(finalBox.textContent).toContain('最终结论')
    expect(finalBox.textContent).toContain('最终已完成修改')
    expect(finalBox.textContent).not.toContain('阶段一：检查结构')

    const saveBtn = turn0.querySelector<HTMLButtonElement>('button[title="放入中转箱"]')!
    await act(async () => { saveBtn.click() })
    await flush()
    expect(savedBodies).toEqual([{ text: '最终已完成修改', engine: 'anti', session_id: 's-split', project: 'demo' }])

    const turn1 = host.querySelector('[data-anti-turn="1"]')!
    expect(turn1.querySelector('section[data-anti-progress-outputs]')).toBeNull()
    const turn1Final = turn1.querySelector('[data-anti-final-answer]')!
    expect(turn1Final.textContent).toContain('单段直接回复')
    expect(turn1Final.textContent).not.toContain('最终结论')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('escalates unresponsive soft stop into force stop recovery bar and supports force ACP reset', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-force-ui', title: 'Force UI', project: 'demo', workspace: 'D:/demo', has_conversation: true }
  let activeRun: Record<string, unknown> = {
    id: 'r-stuck',
    operation: 'op-stuck',
    prompt: 'Do long task',
    status: 'running',
    mode: 'plan',
    permission_mode: 'approval-required',
  }
  const calledPaths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    calledPaths.push(path)
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs`) return reply([activeRun])
    if (path === `/api/anti/sessions/${session.id}/runs/${activeRun.id}`) return reply(activeRun)
    if (path === `/api/anti/sessions/${session.id}/runs/${activeRun.id}/cancel`) return reply(activeRun)
    if (path === `/api/anti/sessions/${session.id}/runs/${activeRun.id}/cancel?force=true`) {
      activeRun = { ...activeRun, status: 'cancelled' }
      return reply(activeRun)
    }
    if (path === `/api/anti/sessions/${session.id}/reset?force=true`) {
      activeRun = { ...activeRun, status: 'cancelled' }
      return reply({ ...session, acp_connected: false })
    }
    if (path.endsWith('/events')) return reply([])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="停止"]')).not.toBeNull()
    })
    expect(host.querySelector('[data-anti-force-stop-bar]')).toBeNull()

    // Soft stop returns still-running -> escalates immediately to force stop bar & unlocked force reset
    const stopBtn = host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!
    await act(async () => { stopBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-force-stop-bar]')).not.toBeNull()
    })
    expect(calledPaths).toContain(`/api/anti/sessions/${session.id}/runs/${activeRun.id}/cancel`)
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')?.title).toBe('强制终止当前任务并重置 ACP 进程')
    const recoveryForceResetBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-force-stop-bar] button')].find(
      b => b.textContent?.includes('强制重连 ACP'),
    )!
    expect(recoveryForceResetBtn?.disabled).toBe(false)

    // Clicking "强制终止" sends ?force=true and converges the turn to cancelled
    const forceStopBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-force-stop-bar] button')].find(
      b => b.textContent?.includes('强制终止'),
    )!
    await act(async () => { forceStopBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.textContent).toContain('任务中止')
    })
    expect(calledPaths).toContain(`/api/anti/sessions/${session.id}/runs/r-stuck/cancel?force=true`)
    expect(host.querySelector('[data-anti-force-stop-bar]')).toBeNull()

    // Second active run: clicking "强制重连 ACP" calls /reset?force=true
    activeRun = {
      id: 'r-stuck-2',
      operation: 'op-stuck-2',
      prompt: 'Do another long task',
      status: 'running',
      mode: 'plan',
      permission_mode: 'approval-required',
    }
    await act(async () => { await cache.invalidateQueries({ queryKey: ['anti-runs', session.id] }) })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="停止"]')).not.toBeNull()
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-force-stop-bar]')).not.toBeNull()
    })
    const forceResetBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-force-stop-bar] button')].find(
      b => b.textContent?.includes('强制重连 ACP'),
    )!
    await act(async () => { forceResetBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(calledPaths).toContain(`/api/anti/sessions/${session.id}/reset?force=true`)
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('escalates daemon 409 conflicts to force confirm, shows active workers, and supports mid-turn steer & follow-up queue', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-steer-ui', title: 'Steer UI', project: 'demo', workspace: 'D:/demo', acp_connected: true }
  let supportsSteering = true
  let activeRun: Record<string, unknown> | null = {
    id: 'r-active-1',
    operation: 'op-active-1',
    prompt: 'Initial long run',
    status: 'running',
    mode: 'plan',
    permission_mode: 'approval-required',
  }
  const called: Array<{ path: string; body?: unknown }> = []

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    called.push({ path, body })
    const reply = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(data)) })

    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated', version: '1.5.14', active_count: activeRun ? 1 : 0, supports_steering: supportsSteering })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated' }] })
    if (path === '/api/anti/workers') {
      return reply({
        items: [{
          profile_id: 'default', profile_name: '系统默认', session_id: session.id, session_title: 'Steer UI',
          project: 'demo', workspace: 'D:/demo', pid: 4321, alive: true, busy: true, state: 'running',
          active_run_id: 'r-active-1', idle_seconds: 0, idle_ttl: 1800, dirty: false, retired: false, exit_pending: false,
        }],
      })
    }
    if (path === '/api/anti/restart') return reply({ detail: '当前有正在运行的 Anti 任务' }, 409)
    if (path === '/api/anti/restart?force=true') {
      activeRun = null
      return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated', version: '1.5.14', active_count: 0, supports_steering: supportsSteering })
    }
    if (path === `/api/anti/sessions/${session.id}/reset?force=true`) {
      return reply({ ...session, acp_connected: false })
    }
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs` && init?.method === 'POST') {
      const next = { id: 'r-queued-1', operation: body.operation, prompt: body.prompt, status: 'success', answer: 'queued ok', mode: 'plan', permission_mode: 'approval-required' }
      activeRun = next
      return reply(next)
    }
    if (path === `/api/anti/sessions/${session.id}/runs`) {
      return reply(activeRun ? [activeRun] : [])
    }
    if (path === `/api/anti/sessions/${session.id}/runs/r-active-1`) {
      return reply(activeRun)
    }
    if (path === `/api/anti/sessions/${session.id}/runs/r-active-1/steer`) {
      return reply(activeRun)
    }
    if (path.endsWith('/events')) return reply([])
    if (path.startsWith('/api/file-transfer')) return reply([])
    return reply({})
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="插话纠偏"]')).not.toBeNull()
    })

    // 1. Mid-turn steering Split Button: Enter & primary click steer by default without layout-jumping bottom bar,
    //    while the split dropdown & Ctrl+Enter allow queueing without interrupting.
    expect(host.querySelector('button[aria-label="选择发送或排队方式"]')).not.toBeNull()
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '先跑单测')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.textContent).not.toContain('不想打断当前推理')
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/runs/r-active-1/steer`)).toBe(true)
    })

    // Split menu -> "加入排队" queues even while native steering is supported
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '先排个队')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="选择发送或排队方式"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[role="menu"][aria-label="运行中发送方式"]')).not.toBeNull()
    })
    const queueMenuItem = [...host.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="运行中发送方式"] [role="menuitem"]')]
      .find(b => b.textContent?.includes('加入排队'))!
    await act(async () => { queueMenuItem.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-bar]')?.textContent).toContain('先排个队')
    })

    // Ctrl+Enter directly queues without opening menu
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Ctrl回车排队')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-bar]')?.textContent).toContain('Ctrl回车排队')
    })

    // Dismiss queued bar before switching supports_steering mode
    const cancelQueueBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-bar] button')]
      .find(b => b.textContent?.trim() === '取消排队')!
    await act(async () => { cancelQueueBtn.click() })

    // 2. When supports_steering is false, split dropdown hides and single queue button auto-sends once completed.
    supportsSteering = false
    await act(async () => { await cache.invalidateQueries({ queryKey: ['anti-daemon-status'] }) })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="加入排队"]')).not.toBeNull()
      expect(host.querySelector('button[aria-label="选择发送或排队方式"]')).toBeNull()
    })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '排队补充总结')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="加入排队"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-bar]')?.textContent).toContain('排队补充总结')
    })

    // Complete activeRun -> auto-dispatches queued prompt.
    activeRun = { ...activeRun, status: 'success', answer: 'done' }
    await act(async () => { await cache.invalidateQueries({ queryKey: ['anti-live', session.id, 'r-active-1'] }) })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/runs` && (c.body as { prompt?: string })?.prompt === '排队补充总结')).toBe(true)
    })

    // 3. Header restart returning 409 shows inline force confirm; Active Workers panel resets stuck session.
    activeRun = { id: 'r-active-1', operation: 'op-active-1', prompt: 'Initial long run', status: 'running', mode: 'plan', permission_mode: 'approval-required' }
    await act(async () => { await cache.invalidateQueries({ queryKey: ['anti-daemon-status'] }) })
    await flush()
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="重置 Agy 运行时"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-daemon-force-confirm]')).not.toBeNull()
    })

    const accBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Agy 账号：')) as HTMLButtonElement
    await act(async () => { accBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-anti-modal-force-bar]')).not.toBeNull()
    })
    const workersToggle = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('活跃进程')) as HTMLButtonElement
    await act(async () => { workersToggle.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-anti-workers-panel]')?.textContent).toContain('PID 4321')
    })
    // Toggling ACP 日志 closes 活跃进程 drawer (mutually exclusive)
    const logsToggle = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'ACP 日志') as HTMLButtonElement
    await act(async () => { logsToggle.click() })
    await flush()
    expect(document.body.querySelector('[data-anti-workers-panel]')).toBeNull()
    const workersReopen = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('活跃进程')) as HTMLButtonElement
    await act(async () => { workersReopen.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-anti-workers-panel]')?.textContent).toContain('PID 4321')
    })
    const forceWorkerBtn = [...document.body.querySelectorAll<HTMLButtonElement>('[data-anti-workers-panel] button')].find(
      b => b.textContent?.includes('强制重连'),
    )!
    await act(async () => { forceWorkerBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/reset?force=true`)).toBe(true)
    })

    const forceModalRestartBtn = [...document.body.querySelectorAll<HTMLButtonElement>('[data-anti-modal-force-bar] button')].find(
      b => b.textContent?.includes('强制重置运行时'),
    )!
    await act(async () => { forceModalRestartBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === '/api/anti/restart?force=true')).toBe(true)
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('converges UI to single-account mode with account pill, backup quota refresh, grant revocation, /compact action, and 429 switch+retry', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let session = {
    id: 's-p3',
    title: 'Phase 3 Session',
    project: 'demo',
    workspace: 'D:/demo',
    has_conversation: true,
    profile_id: null as string | null,
    grants: ['edit', 'execute'],
  }
  let activeProfile = 'default'
  const called: Array<{ method: string; path: string; body?: unknown }> = []
  let failOnceWith429 = true

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    called.push({ method, path, body })
    const reply = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(JSON.stringify(data)),
    })

    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') {
      return reply({
        active: activeProfile,
        profiles: [
          {
            id: 'default',
            name: '系统默认',
            has_credentials: true,
            auth_state: 'authenticated',
            usage: {
              state: 'authenticated',
              checked_at: '2026-11-25T08:00:00Z',
              min_remaining_pct: 5,
              rows: [
                { model: 'Gemini 4', limit: 'Five Hour Limit Remaining', remaining_pct: 12 },
                { model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 5 },
              ],
            },
          },
          {
            id: 'backup',
            name: '备用账号',
            has_credentials: true,
            auth_state: 'authenticated',
            usage: {
              state: 'authenticated',
              checked_at: '2026-11-25T08:00:00Z',
              min_remaining_pct: 85,
              rows: [
                { model: 'Gemini 4', limit: 'Five Hour Limit Remaining', remaining_pct: 92 },
                { model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 85 },
              ],
            },
          },
        ],
      })
    }
    if (path === '/api/anti/account-usage?profile_id=backup' && method === 'POST') {
      return reply({
        state: 'authenticated',
        rows: [
          { model: 'Gemini 4', limit: 'Five Hour Limit Remaining', remaining_pct: 94 },
          { model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 88 },
        ],
      })
    }
    if (path === '/api/anti/profiles/backup/switch' && method === 'POST') {
      activeProfile = 'backup'
      return reply({
        active: 'backup',
        profiles: [
          {
            id: 'default',
            name: '系统默认',
            has_credentials: true,
            auth_state: 'authenticated',
            usage: {
              state: 'authenticated',
              checked_at: '2026-11-25T08:00:00Z',
              min_remaining_pct: 5,
              rows: [
                { model: 'Gemini 4', limit: 'Five Hour Limit Remaining', remaining_pct: 12 },
                { model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 5 },
              ],
            },
          },
          {
            id: 'backup',
            name: '备用账号',
            has_credentials: true,
            auth_state: 'authenticated',
            usage: {
              state: 'authenticated',
              checked_at: '2026-11-25T08:00:00Z',
              min_remaining_pct: 88,
              rows: [
                { model: 'Gemini 4', limit: 'Five Hour Limit Remaining', remaining_pct: 94 },
                { model: 'Gemini 4', limit: 'Weekly Limit Remaining', remaining_pct: 88 },
              ],
            },
          },
        ],
      })
    }
    if (path.startsWith('/api/anti/models')) return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path.startsWith('/api/anti/commands')) return reply({ items: [{ name: 'compact', description: '压缩上下文', hint: null }] })
    if (path === '/api/anti/workers') return reply({ items: [] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/grants` && method === 'DELETE') {
      session = { ...session, grants: [] }
      return reply(session)
    }
    if (path === `/api/anti/sessions/${session.id}/compact` && method === 'POST') {
      return reply({
        id: 'r-compact',
        operation: 'op-compact',
        prompt: '/compact',
        status: 'success',
        answer: '上下文已压缩',
        mode: 'plan',
        permission_mode: 'approval-required',
      })
    }
    if (path === `/api/anti/sessions/${session.id}/runs` && method === 'GET') return reply([])
    if (path === `/api/anti/sessions/${session.id}/runs` && method === 'POST') {
      if (failOnceWith429) {
        failOnceWith429 = false
        return reply({ detail: '当前账号触发风控冷却（约 60 秒后自动恢复），请切换可用账号。' }, 429)
      }
      return reply({
        id: 'r-retry-ok',
        operation: 'op-retry',
        prompt: (body as { prompt: string }).prompt,
        status: 'success',
        answer: '切换后重试成功',
        mode: 'plan',
        permission_mode: 'approval-required',
      })
    }
    if (path.endsWith('/events')) return reply([])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-session-grants]')).not.toBeNull()
    })

    // 0. Composer has NO per-session account selector or isolated account label; top bar shows IDE account pill
    expect(host.querySelector('select[aria-label="本会话 Agy 账号"]')).toBeNull()
    expect(host.textContent).not.toContain('当前隔离账号')
    const accountPill = host.querySelector<HTMLButtonElement>('[data-anti-account-pill]')!
    expect(accountPill.textContent).toContain('系统默认')
    expect(accountPill.textContent).toContain('12%')
    expect(accountPill.textContent).not.toContain('5%')

    // Backup account quota refresh works non-disruptively inside modal
    await act(async () => { accountPill.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('button[aria-label="刷新额度：备用账号"]')).not.toBeNull()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新额度：备用账号"]')!.click()
    })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'POST' && c.path === '/api/anti/account-usage?profile_id=backup')).toBe(true)
    })
    const closeModalBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === '关闭')!
    await act(async () => { closeModalBtn.click() })
    await flush()

    // 1. Revoke all session grants via [data-anti-session-grants]
    const revokeAllBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-session-grants] button')].find(
      b => b.textContent?.includes('全部收回'),
    )!
    await act(async () => { revokeAllBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'DELETE' && c.path === `/api/anti/sessions/${session.id}/grants`)).toBe(true)
    })

    // 2. Compact action stays available via typing '/' without cluttering header or input bar
    expect(host.querySelector('button[aria-label="压缩会话上下文"]')).toBeNull()
    expect(host.querySelector('button[aria-label="插入原生命令"]')).toBeNull()
    const textarea = host.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '/')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[role="listbox"][aria-label="Agy 原生命令"]')?.textContent).toContain('/compact')
    })

    // 3. Submit triggers 429 -> one-click failover switches active account via /switch & retries run in same session
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Retry after 429')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-rate-limit-switch]')?.textContent).toContain('切换可用账号')
      expect(host.querySelector('[data-anti-rate-limit-switch]')?.textContent).toContain('备用账号')
    })

    const oneClickBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-rate-limit-switch] button')].find(
      b => b.textContent?.includes('备用账号'),
    )!
    await act(async () => { oneClickBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'POST' && c.path === '/api/anti/profiles/backup/switch')).toBe(true)
      expect(called.some(c => c.method === 'PATCH' && c.path.includes('/profile'))).toBe(false)
      expect(called.filter(c => c.method === 'POST' && c.path === `/api/anti/sessions/${session.id}/runs`).length).toBe(2)
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('supports Orchestrator quick icon button, profile-consolidated model sync and role settings, and fallback notices', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = {
    id: 's-orch-ui',
    title: 'Orch Session',
    project: 'demo',
    workspace: 'D:/demo',
    has_conversation: true,
    profile_id: null as string | null,
    grants: [],
  }
  const initialModels = [
    { id: 'gemini-4-hydrogen', display_name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'], is_default: true },
    { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)', is_orchestrator: true },
  ]
  const syncedModels = [
    ...initialModels,
    { id: 'gemini-pro-orchestrator', display_name: 'Orchestrator (Carbon)', is_orchestrator: true },
  ]
  let modelsPayload = initialModels
  let orchestratorState: { profile_id: string; planner: string | null; executor: string | null } = {
    profile_id: 'default',
    planner: null,
    executor: null,
  }
  const called: Array<{ method: string; path: string; body?: unknown }> = []

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    called.push({ method, path, body })
    const reply = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(JSON.stringify(data)),
    })

    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated' }] })
    if (path === '/api/anti/workers') return reply({ items: [] })
    if (path === '/api/anti/models') return reply({ items: modelsPayload, synced_at: '2026-11-25T06:00:00+08:00' })
    if (path === '/api/anti/models/sync' && method === 'POST') {
      modelsPayload = syncedModels
      return reply({ items: syncedModels, synced_at: '2026-11-25T09:30:00+08:00' })
    }
    if (path === '/api/anti/commands') return reply({ items: [] })
    if (path === '/api/anti/profiles/default/orchestrator' && method === 'GET') return reply(orchestratorState)
    if (path === '/api/anti/profiles/default/orchestrator' && method === 'PATCH') {
      orchestratorState = { profile_id: 'default', ...(body as { planner: string | null; executor: string | null }) }
      return reply(orchestratorState)
    }
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs`) {
      return reply([
        {
          id: 'r-fb-ui',
          operation: 'op-fb-ui',
          prompt: 'Run hybrid',
          status: 'success',
          model: 'old-hybrid',
          effective_model: 'gemini-4-hydrogen-high',
          fallback_notice: '当前账号不支持模型「old-hybrid」，已自动回退至「gemini-4-hydrogen-high」执行',
          answer: '完成',
          mode: 'plan',
          permission_mode: 'approval-required',
        },
      ])
    }
    if (path.endsWith('/events')) return reply([])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-fallback-notice]')?.textContent).toContain('old-hybrid')
    })

    // 1. Header is clean: no standalone sync button, no standalone effort select, no Orch icon until selected, no circle mark
    expect(host.querySelector('button[aria-label="同步上游模型"]')).toBeNull()
    expect(host.querySelector('button[aria-label="思考等级"]')).toBeNull()
    expect(host.querySelector('button[aria-label="Orchestrator 角色设置"]')).toBeNull()
    const modelBtn = host.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!
    expect(modelBtn.querySelector('svg[data-channel]')).toBeNull()
    expect(modelBtn.querySelector('[data-anti-effort-badge]')?.textContent).toBe('High')

    // 2. Select Orchestrator (Neon) -> hides effort badge and shows Plan B pure-icon Orch trigger in header
    await act(async () => { modelBtn.click() })
    const orchOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      el => el.textContent?.includes('Orchestrator (Neon)'),
    )!
    await act(async () => { orchOption.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(modelBtn.querySelector('[data-anti-effort-badge]')).toBeNull()
      const orchTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="Orchestrator 角色设置"]')
      expect(orchTrigger).not.toBeNull()
      expect(orchTrigger?.textContent?.trim()).toBe('')
    })

    // 3. Click Plan B Orch icon -> opens Account Management modal directly on the 模型与 Orchestrator tab
    const orchTrigger = host.querySelector<HTMLButtonElement>('button[aria-label="Orchestrator 角色设置"]')!
    await act(async () => { orchTrigger.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('模型与 Orchestrator')
      expect(document.body.querySelector('[data-anti-models-orch-section]')).not.toBeNull()
    })

    // Switching back to 账号管理 tab hides models section; clicking 模型与 Orchestrator restores it
    const accountsTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes('账号管理'))!
    const modelsTab = [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b => b.textContent?.includes('模型与 Orchestrator'))!
    await act(async () => { accountsTab.click() })
    await flush()
    expect(document.body.querySelector('[data-anti-models-orch-section]')).toBeNull()
    await act(async () => { modelsTab.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-anti-models-orch-section]')).not.toBeNull()
    })

    // Sync upstream models inside Account Management modal
    const syncBtn = document.body.querySelector<HTMLButtonElement>('[data-anti-models-orch-section] button[aria-label="同步上游模型"]')!
    await act(async () => { syncBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'POST' && c.path === '/api/anti/models/sync')).toBe(true)
    })

    // Save Planner / Executor inside Account Management modal
    const plannerSelect = document.body.querySelector<HTMLSelectElement>('select[aria-label="Orchestrator Planner 模型"]')!
    const executorSelect = document.body.querySelector<HTMLSelectElement>('select[aria-label="Orchestrator Executor 模型"]')!
    await act(async () => {
      plannerSelect.value = 'gemini-4-neon-xhigh'
      plannerSelect.dispatchEvent(new Event('change', { bubbles: true }))
      executorSelect.value = 'gemini-4-hydrogen-high'
      executorSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const saveBtn = [...document.body.querySelectorAll<HTMLButtonElement>('[data-anti-orchestrator-section] button')].find(
      b => b.textContent?.trim() === '保存设置',
    )!
    await act(async () => { saveBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(
        c => c.method === 'PATCH'
          && c.path === '/api/anti/profiles/default/orchestrator'
          && JSON.stringify(c.body) === JSON.stringify({ planner: 'gemini-4-neon-xhigh', executor: 'gemini-4-hydrogen-high' }),
      )).toBe(true)
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('displays compact k/M usage units with exact breakdown tooltip and repairs legacy >100% cache ratio', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-compact-usage', title: 'Compact usage', project: 'demo', workspace: 'D:/demo' }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)', is_orchestrator: true }] })
    if (path === '/api/anti/commands') return reply({ items: [] })
    if (path === '/api/anti/workers') return reply({ items: [] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs`) {
      return reply([{
        id: 'r-high-cache',
        operation: 'op-high-cache',
        prompt: 'Analyze repo',
        status: 'success',
        answer: 'Done',
        model: 'gemini-pro-orchestrator-neon',
        mode: 'accept-edits',
        permission_mode: 'full-access',
        usage: {
          input_tokens: 778_033,
          output_tokens: 90_537,
          cache_read_tokens: 4_683_759,
          cache_write_tokens: 0,
          thinking_tokens: 29_726,
        },
      }])
    }
    if (path.endsWith('/events')) return reply([])
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
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-run-usage]')?.textContent).toContain('5.46M in')
    })

    const usageEl = host.querySelector<HTMLElement>('[data-anti-run-usage]')!
    expect(usageEl.textContent).toBe('5.46M in · 90.5k out · 29.7k think · 缓存 86%')
    expect(usageEl.getAttribute('title')).toBe(
      '总输入 5,461,792（新输入 778,033 + 缓存命中 4,683,759） · 输出 90,537 · 思考 29,726 · 缓存命中率 85.8%',
    )
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('auto-refreshes usage after 10 minutes of visible dwell, pauses when hidden, and resets timer on manual refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T10:00:00Z'))

  let visibility: DocumentVisibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  })

  let usageCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path === '/api/anti/account-usage') {
      usageCalls += 1
      return {
        ok: true,
        status: 200,
        json: async () => ({
          state: 'authenticated',
          rows: [{ model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 90, resets_at: '2026-11-30T08:00:00Z' }],
        }),
      }
    }
    if (path === '/api/anti/quota') return { ok: true, status: 200, json: async () => [] }
    if (path === '/api/anti/stats?today=true') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          window_hours: 24, total_runs: 0, success_runs: 0, failed_runs: 0,
          rate_limited_runs: 0, total_tokens: 0, cache_hit_ratio: 0, estimated_cost_usd: 0,
        }),
      }
    }
    throw new Error(`Unexpected request: ${path}`)
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)

  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <AntiAccountUsageButton running autoRefreshKey="default" onChecked={() => {}} />
      </QueryClientProvider>,
    ))

    // 4 minutes visible -> still no auto-refresh
    await act(async () => { await vi.advanceTimersByTimeAsync(4 * 60 * 1000) })
    expect(usageCalls).toBe(0)

    // Hide page for 20 minutes -> paused, 0 requests while hidden
    visibility = 'hidden'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60 * 1000) })
    expect(usageCalls).toBe(0)

    // Resume visible -> accumulates 6 more minutes (4 + 6 = 10 min) -> fires once
    visibility = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000) })
    expect(usageCalls).toBe(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1 * 60 * 1000) })
    expect(usageCalls).toBe(1)

    // 5 minutes later user clicks icon manually -> fires immediately (call #2) and resets 10-min dwell timer
    await act(async () => { await vi.advanceTimersByTimeAsync(5 * 60 * 1000) })
    expect(usageCalls).toBe(1)
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!.click()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(usageCalls).toBe(2)

    // Next 9 minutes -> must NOT fire early; at 10 minutes after manual click -> fires call #3
    await act(async () => { await vi.advanceTimersByTimeAsync(AUTO_USAGE_REFRESH_INTERVAL_MS - 60 * 1000) })
    expect(usageCalls).toBe(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(60 * 1000) })
    expect(usageCalls).toBe(3)
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete (document as unknown as Record<string, unknown>).visibilityState
  }
})


