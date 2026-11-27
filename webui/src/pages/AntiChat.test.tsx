// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { expect, it, vi, beforeEach } from 'vitest'
import AntiChat from './AntiChat'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'
import { AntiAccountUsageButton } from '@/components/AntiAccountUsageButton'
import { resetPageState } from '@/utils/pageState'
import { dialog } from '@/stores/dialogStore'
import { useToastStore } from '@/stores/toastStore'

beforeEach(() => {
  localStorage.clear()
  resetPageState()
  useToastStore.setState({ items: [] })
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
    expect(button('启用 Agy')?.classList.contains('bg-[var(--c-solid-danger-bg)]')).toBe(true)
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
    await wait(() => expect(button('Agy ACP 运行中')?.disabled).toBe(false))
    expect(button('Agy ACP 运行中')?.getAttribute('aria-haspopup')).toBe('dialog')
    expect(host.querySelector('[role=img][aria-label="agy 已验证登录"]')).not.toBeNull()
    expect(usageRequests()).toHaveLength(0)
    expect(usageButton.closest('header')).not.toBeNull()
    expect(host.querySelector('[role=group][aria-label="Anti 状态"]')?.contains(usageButton)).toBe(false)
    await act(async () => usageButton.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(quotaDialog()?.textContent).toContain('点击刷新查询剩余额度。')
    expect(usageRequests()).toHaveLength(0)
    usageButton.focus()
    expect(document.activeElement).toBe(usageButton)
    await act(async () => usageButton.click())
    await wait(() => expect(quotaDialog()?.textContent).toContain('42.5%'))
    expect(usageButton.getAttribute('aria-expanded')).toBe('true')
    expect(quotaDialog()?.closest('header')).toBeNull()
    expect(usageRequests()).toHaveLength(1)
    expect(quotaDialog()?.textContent).toContain('Example Model')
    expect(quotaDialog()?.textContent).toContain('周')
    expect(quotaDialog()?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42.5')
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
    const workSettingsBtn = dialog?.querySelector<HTMLButtonElement>('button[aria-label="账号设置：工作"]')
    expect(workSettingsBtn).toBeTruthy()
    await act(async () => workSettingsBtn!.click())
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
    await act(async () => dialog?.querySelector<HTMLButtonElement>('button[aria-label="返回账号列表"]')!.click())
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
    expect(item?.querySelector('.model-select-label')?.textContent).toContain(name)
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
    if (path === '/api/anti/workers') return reply({ items: [] })
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
      expect(document.body.textContent).toContain('今日对话 5 (成功 4) · 调用 19')
      expect(document.body.textContent).toContain('12k tok · 72.4 tok/s · 缓存 40%')
    })
    expect(document.body.textContent).not.toContain('查看本地配额池')
    expect(document.body.textContent).not.toContain('5h 窗口 64%')
    const unlockBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '提前解锁') as HTMLButtonElement
    await act(async () => { unlockBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-anti-cooldown-alert]')).toBeNull()
      expect(document.body.textContent).toContain('今日对话 5 (成功 4) · 调用 19')
    })

    await act(async () => { usageBtn.click() })

    // Runtime diagnostics dropdown on top-left status badge hosts ACP 日志
    const diagBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Agy ACP 运行中"]')!
    await act(async () => { diagBtn.click() })
    await flush()
    const logsBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'ACP 日志') as HTMLButtonElement
    await act(async () => { logsBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('[INFO] AntiCLI ready')
    const closeDiagBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '关闭') as HTMLButtonElement
    await act(async () => { closeDiagBtn.click() })
    await flush()

    // Profile dropdown: layered account list (system default omitted) + top-right add view + per-account settings (logout & delete)
    const accountsBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Agy 账号：')) as HTMLButtonElement
    await act(async () => { accountsBtn.click() })
    await flush()
    expect(document.body.querySelector('[role="tab"]')).toBeNull()
    expect(document.body.querySelector('[data-account-card="default"]')).toBeNull()
    expect(document.body.querySelector('[data-account-card="work"]')).not.toBeNull()
    expect(document.body.querySelector('button[aria-label="账号管理设置"]')).toBeNull()

    const addAccountBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="添加账号"]')!
    await act(async () => { addAccountBtn.click() })
    await flush()

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

    const confirmProfileSpy = vi.spyOn(dialog, 'confirm').mockResolvedValue(true)
    try {
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：克隆号"]')!.click()
      })
      await flush()
      const logoutBtn = document.body.querySelector('button[aria-label="清除凭据：克隆号"]') as HTMLButtonElement
      await act(async () => { logoutBtn.click() })
      await flush()
      expect(confirmProfileSpy).toHaveBeenCalledWith(
        '清除账号凭据？',
        expect.stringContaining('克隆号'),
        expect.objectContaining({ tone: 'danger' }),
      )
      expect(profilesList.find(p => p.id === 'cloned')?.has_credentials).toBe(false)

      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="返回账号列表"]')!.click()
      })
      await flush()
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：工作"]')!.click()
      })
      await flush()
      const delBtn = document.body.querySelector('button[aria-label="删除账号：工作"]') as HTMLButtonElement
      await act(async () => { delBtn.click() })
      await flush()
      expect(confirmProfileSpy).toHaveBeenCalledWith(
        '删除账号？',
        expect.stringContaining('工作'),
        expect.objectContaining({ tone: 'danger' }),
      )
      expect(profilesList.some(p => p.id === 'work')).toBe(false)
    } finally {
      confirmProfileSpy.mockRestore()
    }

    // Close profile modal and stop gateway; offline cached quota remains available when opened
    const closeModalBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent === '关闭') as HTMLButtonElement
    await act(async () => { closeModalBtn.click() })
    await flush()

    const stopBtn = host.querySelector('button[aria-label="停止 Agy 运行时"]') as HTMLButtonElement
    expect(stopBtn.closest('[data-anti-runtime-controls]')).not.toBeNull()
    expect(stopBtn.textContent?.trim()).toBe('')
    expect(stopBtn.querySelector('svg')).not.toBeNull()
    expect(stopBtn.className).toContain('ga-btn-icon-danger')
    await act(async () => { stopBtn.click() })
    await flush()
    expect(host.textContent).toContain('启用 Agy')
    await act(async () => { usageBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('缓存 ')
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
    if (path === '/api/anti/workers') return reply({ items: [] })
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
    expect(stopBtn.textContent?.trim()).toBe('')
    expect(restartBtn.textContent?.trim()).toBe('')
    expect(stopBtn.disabled).toBe(true)
    expect(restartBtn.disabled).toBe(true)

    const loginBtn = [...host.querySelectorAll('button')].find(b => b.textContent === '去登录账号') as HTMLButtonElement
    await act(async () => { loginBtn.click() })
    await flush()
    expect(document.body.querySelector('[aria-labelledby="agy-accounts-title"]')).not.toBeNull()
    const closeAccBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '关闭') as HTMLButtonElement
    await act(async () => { closeAccBtn.click() })
    await flush()

    const extBadgeBtn = host.querySelector<HTMLButtonElement>('button[aria-label="外部 Agy 运行中"]')!
    await act(async () => { extBadgeBtn.click() })
    await flush()
    expect(document.body.querySelector('[role="dialog"][aria-label="Agy 运行时诊断"]')?.textContent).toContain('外部运行中')
    const closeBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '关闭') as HTMLButtonElement
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
  let codeStatusCalls = 0
  let holdCodeStatus = false
  let releaseCodeStatus: (() => void) | null = null
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
    if (path === '/api/anti/profiles') return reply({
      active: 'work',
      profiles: [
        { id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated' },
        { id: 'work', name: '工作', has_credentials: true, auth_state: 'authenticated' },
      ],
    })
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
    if (path === '/api/anti/profiles/work/login/start') {
      return reply({
        flow_id: 'flow-1',
        profile_id: 'work',
        phase: 'waiting_code',
        authorization_url: 'https://accounts.google.com/o/oauth2/auth?client_id=test',
        error: null,
      })
    }
    if (path === '/api/anti/profiles/login/submit/flow-1') {
      codeSubmitted = JSON.parse(String(init?.body)).code
      return reply({ flow_id: 'flow-1', profile_id: 'work', phase: 'completed', authorization_url: null, error: null })
    }
    if (path === '/api/anti/profiles/login/status/flow-1') {
      codeStatusCalls += 1
      if (holdCodeStatus) {
        await new Promise<void>(resolve => { releaseCodeStatus = resolve })
      }
      return reply({ flow_id: 'flow-1', profile_id: 'work', phase: 'waiting_code', authorization_url: 'https://accounts.google.com/o/oauth2/auth?client_id=test', error: null })
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
    expect(document.body.textContent).toContain('今日对话 2 (成功 2)')
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
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：工作"]')!.click()
    })
    await flush()
    const codeLoginBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="授权码登录：工作"]')!
    await act(async () => { codeLoginBtn.click() })
    await flush()
    expect(document.body.textContent).toContain('https://accounts.google.com/o/oauth2/auth?client_id=test')
    const refreshCodeBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新授权状态"]')!
    const statusCallsBefore = codeStatusCalls
    holdCodeStatus = true
    await act(async () => {
      refreshCodeBtn.click()
      refreshCodeBtn.click()
    })
    expect(codeStatusCalls).toBe(statusCallsBefore + 1)
    expect(refreshCodeBtn.disabled).toBe(true)
    expect(refreshCodeBtn.textContent?.trim()).toBe('刷新中…')
    holdCodeStatus = false
    await act(async () => { releaseCodeStatus?.(); await Promise.resolve() })
    await flush()
    expect(refreshCodeBtn.disabled).toBe(false)
    expect(refreshCodeBtn.textContent?.trim()).toBe('刷新')
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
    expect(turn1Final.querySelector('[data-final-conclusion-divider]')?.textContent).toContain('最终结论')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('streams active Agy segments in process outputs without premature final conclusion, then settles on completion', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let activeSource: {
    onopen: (() => void) | null
    onerror: (() => void) | null
    listeners: Map<string, EventListener[]>
    emit: (type: string, payload: unknown) => void
  } | null = null
  class FakeEventSource {
    onopen: (() => void) | null = null
    onmessage: ((event: MessageEvent<string>) => void) | null = null
    onerror: (() => void) | null = null
    listeners = new Map<string, EventListener[]>()
    close = vi.fn()
    addEventListener(type: string, listener: EventListener) {
      const list = this.listeners.get(type) ?? []
      list.push(listener)
      this.listeners.set(type, list)
    }
    emit(type: string, payload: unknown) {
      const event = new MessageEvent(type, { data: JSON.stringify(payload) })
      for (const listener of this.listeners.get(type) ?? []) listener(event)
    }
    constructor() {
      activeSource = this
    }
  }
  vi.stubGlobal('EventSource', FakeEventSource)

  const session = { id: 's-live-progress', title: 'Live progress test', project: 'demo', workspace: 'D:/demo' }
  let liveRun: Record<string, unknown> = {
    id: 'r-live',
    operation: 'op-live',
    prompt: 'Run live task',
    status: 'running',
    mode: 'plan',
    permission_mode: 'approval-required',
  }
  const cancelledRun: Record<string, unknown> = {
    id: 'r-cancelled',
    operation: 'op-cancelled',
    prompt: 'Stopped task',
    status: 'cancelled',
    answer: '中断前的半截输出',
    progress_messages: [],
    mode: 'plan',
    permission_mode: 'approval-required',
  }
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === '/api/anti/sessions/s-live-progress/runs') return reply([cancelledRun, liveRun])
    if (path === '/api/anti/sessions/s-live-progress/runs/r-live') return reply(liveRun)
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
      expect(host.querySelector('[data-anti-turn="0"]')).not.toBeNull()
      expect(host.querySelector('[data-anti-turn="1"]')).not.toBeNull()
      expect(activeSource).not.toBeNull()
    })

    // Cancelled run renders its partial body without a "最终结论" divider.
    const cancelledTurn = host.querySelector('[data-anti-turn="0"]')!
    expect(cancelledTurn.textContent).toContain('中断前的半截输出')
    expect(cancelledTurn.textContent).toContain('任务中止')
    expect(cancelledTurn.querySelector('[data-final-conclusion-divider]')).toBeNull()

    const liveTurn = host.querySelector('[data-anti-turn="1"]')!
    expect(liveTurn.querySelector('details')?.className).not.toContain('border-b')

    // Emit segment 1 while active -> stays inside process outputs, never rendered as final answer.
    await act(async () => {
      activeSource!.onopen?.()
      activeSource!.emit('message.delta', { seq: 1, type: 'message.delta', text: '阶段一说明', step: { index: 0, kind: 'agent_response', state: 'ACTIVE' } })
    })
    await vi.waitFor(() => {
      const box = liveTurn.querySelector('section[data-anti-progress-outputs]')
      expect(box?.textContent).toContain('阶段一说明')
      expect(box?.textContent).toContain('实时输出')
      expect(box?.querySelector('[data-anti-progress-live="true"]')?.textContent).toContain('阶段一说明')
      expect(liveTurn.querySelector('[data-anti-final-answer]')).toBeNull()
      expect(liveTurn.querySelector('[data-final-conclusion-divider]')).toBeNull()
    })

    // Follow with tool_call and segment 2 -> both remain in the same process stream; segment 2 becomes live.
    await act(async () => {
      activeSource!.emit('step.update', { seq: 2, type: 'step.update', step: { index: 1, kind: 'tool_call', tool: 'view_file', state: 'DONE' } })
      activeSource!.emit('message.delta', { seq: 3, type: 'message.delta', text: '阶段二跟进', step: { index: 2, kind: 'agent_response', state: 'ACTIVE' } })
    })
    await vi.waitFor(() => {
      const items = [...liveTurn.querySelectorAll('section[data-anti-progress-outputs] ul > li')]
      expect(items.map(el => el.textContent?.trim())).toEqual(['阶段一说明', '阶段二跟进'])
      expect(items[0].getAttribute('data-anti-progress-live')).toBeNull()
      expect(items[1].getAttribute('data-anti-progress-live')).toBe('true')
      expect(liveTurn.querySelector('[data-anti-final-answer]')).toBeNull()
      expect(liveTurn.querySelector('[data-final-conclusion-divider]')).toBeNull()
    })

    // Once completed cleanly, progress box stays expanded and final conclusion settles once below divider.
    liveRun = {
      ...liveRun,
      status: 'success',
      progress_messages: ['阶段一说明'],
      answer: '最终总结正文',
    }
    await act(async () => {
      activeSource!.onerror?.()
    })
    await vi.waitFor(async () => {
      await flush()
      const box = liveTurn.querySelector('section[data-anti-progress-outputs]')
      expect(box?.textContent).toContain('阶段一说明')
      expect(box?.querySelector('[data-anti-progress-live]')).toBeNull()
      const finalBox = liveTurn.querySelector('[data-anti-final-answer]')
      expect(finalBox?.querySelector('[data-final-conclusion-divider]')?.textContent).toContain('最终结论')
      expect(finalBox?.textContent).toContain('最终总结正文')
    })
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

    // Soft stop returns still-running -> escalates immediately to top recovery bar (above textarea, never bottom-lifting)
    const stopBtn = host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!
    await act(async () => { stopBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-force-stop-bar]')).not.toBeNull()
    })
    expect(calledPaths).toContain(`/api/anti/sessions/${session.id}/runs/${activeRun.id}/cancel`)
    const escalatedStopBtn = host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!
    expect(escalatedStopBtn.title).toBe('强制终止当前任务并重置 ACP 进程')
    expect(escalatedStopBtn.getAttribute('data-stop-state')).toBe('force')
    const recoveryBar = host.querySelector<HTMLElement>('[data-anti-force-stop-bar]')!
    const composerTextarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    expect(Boolean(recoveryBar.compareDocumentPosition(composerTextarea) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
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

    // Second active run: recovery bar can be dismissed and "强制重连 ACP" calls /reset?force=true
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
    const dismissBtn = host.querySelector<HTMLButtonElement>('[data-anti-force-stop-bar] button[aria-label="关闭提示"]')!
    expect(dismissBtn).not.toBeNull()
    await act(async () => { dismissBtn.click() })
    expect(host.querySelector('[data-anti-force-stop-bar]')).toBeNull()

    // Re-trigger via Stop button -> still escalates to force cancel or let's reset via a third run for force-reset check
    activeRun = {
      id: 'r-stuck-3',
      operation: 'op-stuck-3',
      prompt: 'Do third long task',
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

it('cancels an in-flight submit when Stop is clicked during pending and routes cancel failures to toast', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const session = { id: 's-early-stop', title: 'Early Stop', project: 'demo', workspace: 'D:/demo', acp_connected: true }
  const called: { method: string; path: string }[] = []
  let runsList: Record<string, unknown>[] = []
  let resolveSubmit!: () => void
  let failSoftCancel = false

  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url, 'http://localhost')
    const path = `${parsed.pathname}${parsed.search}`
    const method = (init?.method ?? 'GET').toUpperCase()
    called.push({ method, path })
    const reply = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(data),
      json: async () => JSON.parse(JSON.stringify(data)),
    })
    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen (High)' }] })
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs` && method === 'GET') return reply(runsList)
    if (path === `/api/anti/sessions/${session.id}/runs` && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      await new Promise<void>(resolve => { resolveSubmit = resolve })
      const created = {
        id: 'r-early',
        operation: body.operation,
        prompt: body.prompt,
        status: 'running',
        mode: 'plan',
        permission_mode: 'approval-required',
      }
      runsList = [created]
      return reply(created)
    }
    if (path === `/api/anti/sessions/${session.id}/runs/r-early/cancel`) {
      if (failSoftCancel) {
        return reply({ detail: '停止通道暂时不可用' }, 500)
      }
      runsList = runsList.map(r => (r.id === 'r-early' ? { ...r, status: 'cancelled' } : r))
      return reply(runsList[0])
    }
    if (path === `/api/anti/sessions/${session.id}/runs/r-early`) return reply(runsList[0] ?? {})
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
      expect(host.querySelector('textarea')).not.toBeNull()
    })

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Oops wrong prompt')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    // While POST /runs is still in-flight, Stop button is already shown and clickable
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="停止"]')).not.toBeNull()
    })
    const pendingStopBtn = host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!
    await act(async () => { pendingStopBtn.click() })
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')?.getAttribute('data-stop-state')).toBe('stopping')

    // Once POST /runs resolves, frontend automatically fires /cancel for r-early
    await act(async () => { resolveSubmit() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'POST' && c.path === `/api/anti/sessions/${session.id}/runs/r-early/cancel`)).toBe(true)
      expect(host.textContent).toContain('任务中止')
    })

    // Transient cancel error routes to toast.error instead of pinning a sticky <p role="alert"> block
    failSoftCancel = true
    runsList = [{
      id: 'r-early',
      operation: 'op-err',
      prompt: 'Another run',
      status: 'running',
      mode: 'plan',
      permission_mode: 'approval-required',
    }]
    await act(async () => { await cache.invalidateQueries({ queryKey: ['anti-runs', session.id] }) })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="停止"]')).not.toBeNull()
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(useToastStore.getState().items.some(item => item.kind === 'error' && item.message.includes('停止通道暂时不可用'))).toBe(true)
    })
    expect(host.querySelector('p[role="alert"]')).toBeNull()
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="停止"]')?.getAttribute('data-stop-state')).toBe('force')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('escalates daemon 409 conflicts to force confirm, shows active workers, and supports queue-first composer, persistent QueueDock, Ctrl+Enter steer, and draft-safe edit', async () => {
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
  let queueItems: Array<Record<string, unknown>> = []
  let queuePauseReason: string | null = null
  let qSeq = 0
  const queueStatePayload = () => {
    const hasActive = Boolean(activeRun && ['submitting', 'queued', 'running', 'unknown'].includes(String(activeRun.status)))
    const paused = queueItems.length > 0 && !hasActive
    return {
      items: queueItems,
      paused,
      pause_reason: paused ? (queuePauseReason ?? '上一轮任务已中止，已暂停自动发送排队消息') : null,
    }
  }
  const called: Array<{ path: string; method?: string; body?: unknown }> = []

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const method = init?.method ?? 'GET'
    called.push({ path, method, body })
    const reply = (data: unknown, status = 200) =>
      ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(data)) })

    if (path === '/api/projects') return reply({ items: [{ name: 'demo', display_name: 'Demo', path: 'D:/demo', dangling: false }] })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated', version: '1.5.14', active_count: activeRun ? 1 : 0, supports_steering: supportsSteering })
    if (path === '/api/anti/profiles') return reply({
      active: 'work',
      profiles: [
        { id: 'default', name: '系统默认', has_credentials: true, auth_state: 'authenticated' },
        { id: 'work', name: '工作', has_credentials: true, auth_state: 'authenticated' },
      ],
    })
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
    if (path === '/api/anti/sessions') return reply([{ ...session, queued_count: queueItems.length }])
    if (path === `/api/anti/sessions/${session.id}/runs` && method === 'POST') {
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
    if (path === `/api/anti/sessions/${session.id}/queue` && method === 'GET') {
      return reply(queueStatePayload())
    }
    if (path === `/api/anti/sessions/${session.id}/queue` && method === 'POST') {
      qSeq += 1
      queueItems.push({
        id: `q-${qSeq}`,
        session_id: session.id,
        position: queueItems.length + 1,
        prompt: body.prompt ?? '',
        model: body.model ?? null,
        effort: body.effort ?? null,
        references: body.references ?? [],
        attachments: body.attachments ?? [],
        mode: body.mode ?? 'plan',
        permission_mode: body.permission_mode ?? 'approval-required',
        created_at: new Date().toISOString(),
      })
      return reply(queueStatePayload())
    }
    if (path === `/api/anti/sessions/${session.id}/queue` && method === 'DELETE') {
      queueItems = []
      queuePauseReason = null
      return reply(queueStatePayload())
    }
    if (path === `/api/anti/sessions/${session.id}/queue/dispatch` && method === 'POST') {
      const head = queueItems.shift()!
      const dispatched = { id: 'r-dispatched-1', operation: `q-${head.id}`, prompt: head.prompt, status: 'running', mode: head.mode, permission_mode: head.permission_mode }
      activeRun = dispatched
      queuePauseReason = null
      return reply({ run: dispatched, queue: queueStatePayload() })
    }
    const moveMatch = path.match(new RegExp(`^/api/anti/sessions/${session.id}/queue/([^/]+)/move$`))
    if (moveMatch && method === 'POST') {
      const qid = moveMatch[1]
      const idx = queueItems.findIndex(item => item.id === qid)
      if (idx > 0 && body?.direction === 'up') {
        ;[queueItems[idx - 1], queueItems[idx]] = [queueItems[idx], queueItems[idx - 1]]
      }
      return reply(queueStatePayload())
    }
    const steerQueuedMatch = path.match(new RegExp(`^/api/anti/sessions/${session.id}/queue/([^/]+)/steer$`))
    if (steerQueuedMatch && method === 'POST') {
      const qid = steerQueuedMatch[1]
      queueItems = queueItems.filter(item => item.id !== qid)
      return reply({ run: activeRun, queue: queueStatePayload() })
    }
    const delMatch = path.match(new RegExp(`^/api/anti/sessions/${session.id}/queue/([^/]+)$`))
    if (delMatch && method === 'DELETE') {
      const qid = delMatch[1]
      queueItems = queueItems.filter(item => item.id !== qid)
      if (!queueItems.length) queuePauseReason = null
      return reply(queueStatePayload())
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
      expect(host.querySelector('button[aria-label="加入排队"]')).not.toBeNull()
    })

    // 1. Default Enter & primary click enqueue into QueueDock above composer without split chevron or calling /steer
    expect(host.querySelector('button[aria-label="选择发送或排队方式"]')).toBeNull()
    const textarea = host.querySelector('textarea')!
    expect(textarea.placeholder).toContain('Enter 加入排队')
    expect(textarea.placeholder).toContain('Ctrl+Enter 插话纠偏')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '排队第1条')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-dock]')?.textContent).toContain('排队第1条')
      expect(host.querySelector('[data-anti-queued-dock]')?.textContent).toContain('下一条')
    })
    expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/runs/r-active-1/steer`)).toBe(false)

    // Primary button click enqueues a 2nd item, showing multi-item FIFO dock & allowing reorder/immediate steer
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '排队第2条')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="加入排队"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      const dock = host.querySelector('[data-anti-queued-dock]')
      expect(dock?.textContent).toContain('2 条')
      expect(dock?.textContent).toContain('排队第2条')
    })

    // Move item #2 up -> becomes "下一条"
    const moveUpBtn = host.querySelector<HTMLButtonElement>('[data-anti-queued-item="q-2"] button[aria-label="上移排队消息"]')!
    await act(async () => { moveUpBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-item="q-2"]')?.textContent).toContain('下一条')
    })

    // Promote queued item to immediate steer
    const promoteBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-item="q-2"] button')]
      .find(b => b.textContent?.trim() === '立即插话')!
    await act(async () => { promoteBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/queue/q-2/steer`)).toBe(true)
      expect(host.querySelector('[data-anti-queued-item="q-2"]')).toBeNull()
    })

    // Plan B edit flow:
    // 1a. Non-empty composer -> clicking 编辑 shows conflict resolution bar
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '新写草稿')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const editQ1Btn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-item="q-1"] button')]
      .find(b => b.textContent?.trim() === '编辑')!
    await act(async () => { editQ1Btn.click() })
    expect(host.querySelector('[data-anti-queue-edit-conflict]')).not.toBeNull()

    // Cancel keeps draft untouched & item still queued
    const cancelConflictBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queue-edit-conflict] button')]
      .find(b => b.textContent?.trim() === '取消')!
    await act(async () => { cancelConflictBtn.click() })
    expect(host.querySelector('[data-anti-queue-edit-conflict]')).toBeNull()
    expect(textarea.value).toBe('新写草稿')

    // Choose "草稿先入队再编辑" -> stashes '新写草稿' as q-3 and refills '排队第1条' into composer
    await act(async () => { editQ1Btn.click() })
    const stashBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queue-edit-conflict] button')]
      .find(b => b.textContent?.trim() === '草稿先入队再编辑')!
    await act(async () => { stashBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(textarea.value).toBe('排队第1条')
      expect(host.querySelector('[data-anti-queued-dock]')?.textContent).toContain('新写草稿')
    })

    // Choose "覆盖当前草稿" -> replaces '排队第1条' in composer with q-3 ('新写草稿') directly
    const editQ3Btn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-item="q-3"] button')]
      .find(b => b.textContent?.trim() === '编辑')!
    await act(async () => { editQ3Btn.click() })
    const overwriteBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queue-edit-conflict] button')]
      .find(b => b.textContent?.trim() === '覆盖当前草稿')!
    await act(async () => { overwriteBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(textarea.value).toBe('新写草稿')
      expect(host.querySelector('[data-anti-queued-dock]')).toBeNull()
    })

    // Empty composer direct edit refill
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-item="q-4"]')).not.toBeNull()
      expect(textarea.value).toBe('')
    })
    const directEditBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-item="q-4"] button')]
      .find(b => b.textContent?.trim() === '编辑')!
    await act(async () => { directEditBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(textarea.value).toBe('新写草稿')
      expect(host.querySelector('[data-anti-queued-dock]')).toBeNull()
    })

    // Ctrl+Enter -> immediate /steer without split menu
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '先跑单测')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/runs/r-active-1/steer` && (c.body as { prompt?: string })?.prompt === '先跑单测')).toBe(true)
    })

    // 2. When supports_steering is false, Ctrl+Enter hint disappears; primary queue button remains and paused dock offers "继续发送" -> /queue/dispatch.
    supportsSteering = false
    await act(async () => { await cache.invalidateQueries({ queryKey: ['anti-daemon-status'] }) })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('button[aria-label="加入排队"]')).not.toBeNull()
      expect(host.querySelector('button[aria-label="选择发送或排队方式"]')).toBeNull()
      expect(textarea.placeholder).not.toContain('Ctrl+Enter 插话纠偏')
    })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '排队补充总结')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="加入排队"]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-dock]')?.textContent).toContain('排队补充总结')
    })

    // Non-success stop leaves queue paused with reason and "继续发送" button
    activeRun = { ...activeRun, status: 'cancelled' }
    await act(async () => {
      await cache.invalidateQueries({ queryKey: ['anti-live', session.id, 'r-active-1'] })
      await cache.invalidateQueries({ queryKey: ['anti-runs', session.id] })
      await cache.invalidateQueries({ queryKey: ['anti-queue', session.id] })
    })
    await vi.waitFor(async () => {
      await flush()
      const dock = host.querySelector('[data-anti-queued-dock]')
      expect(dock?.textContent).toContain('上一轮任务已中止')
      expect([...(dock?.querySelectorAll('button') ?? [])].some(b => b.textContent?.trim() === '继续发送')).toBe(true)
    })
    const resumeBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-dock] button')]
      .find(b => b.textContent?.trim() === '继续发送')!
    await act(async () => { resumeBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.path === `/api/anti/sessions/${session.id}/queue/dispatch`)).toBe(true)
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

    const diagBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Agy ACP 运行中"]')!
    await act(async () => { diagBtn.click() })
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

    // Backup account quota refresh works from card list, and per-account settings avoids duplicate quota/switch/add controls
    await act(async () => { accountPill.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('button[aria-label="查询额度：备用账号"]')).not.toBeNull()
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="查询额度：备用账号"]')!.click()
    })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'POST' && c.path === '/api/anti/account-usage?profile_id=backup')).toBe(true)
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：备用账号"]')!.click()
    })
    await flush()
    const backupSettingsView = document.body.querySelector('[data-account-settings-view="backup"]')!
    expect(backupSettingsView).not.toBeNull()
    expect(backupSettingsView.querySelector('button[aria-label="查询额度：备用账号"]')).toBeNull()
    expect(backupSettingsView.querySelector('button[aria-label="切换到备用账号"]')).toBeNull()
    expect(backupSettingsView.querySelector('[role="progressbar"]')).toBeNull()
    expect(backupSettingsView.querySelector('#agy-profile-name')).toBeNull()
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

it('supports 2-preset Orchestrator config, model visibility filter, and backend role alignment on run submit', async () => {
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
    { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
    { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' },
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
  let modelsConfigState: {
    config_path: string
    auto_sync: boolean
    schedule_hours: number[]
    default_model: string
    default_effort: string
    allow_auto_fallback: boolean
    aliases: Record<string, string>
    quota_rules: Array<{ pattern: string; group: string }>
    orchestrator_presets: Array<{ id: string; name: string; planner: string | null; executor: string | null }>
    hidden_models: string[]
  } = {
    config_path: 'agy_models.json',
    auto_sync: true,
    schedule_hours: [0, 6, 12, 18],
    default_model: 'gemini-4-hydrogen-high',
    default_effort: 'high',
    allow_auto_fallback: true,
    aliases: {},
    quota_rules: [],
    orchestrator_presets: [
      { id: 'preset-1', name: 'Neon', planner: 'gemini-4-neon-high', executor: 'gemini-4-hydrogen-high' },
      { id: 'preset-2', name: 'Carbon', planner: 'gemini-4-carbon-high', executor: 'gemini-4-hydrogen-high' },
    ],
    hidden_models: [],
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
    if (path === '/api/anti/models/config' && method === 'GET') return reply(modelsConfigState)
    if (path === '/api/anti/models/config' && method === 'PATCH') {
      modelsConfigState = {
        ...modelsConfigState,
        ...(body as Record<string, unknown>),
      }
      return reply(modelsConfigState)
    }
    if (path === '/api/anti/commands') return reply({ items: [] })
    if (path === '/api/anti/profiles/default/orchestrator' && method === 'GET') return reply(orchestratorState)
    if (path === '/api/anti/profiles/default/orchestrator' && method === 'PATCH') {
      orchestratorState = { profile_id: 'default', ...(body as { planner: string | null; executor: string | null }) }
      return reply(orchestratorState)
    }
    if (path === '/api/anti/sessions') return reply([session])
    if (path === `/api/anti/sessions/${session.id}/runs` && method === 'POST') {
      return reply({
        id: 'r-orch-submit',
        operation: (body as { operation: string }).operation,
        prompt: (body as { prompt: string }).prompt,
        status: 'running',
        model: (body as { model: string }).model,
        effort: (body as { effort: string }).effort,
        mode: 'plan',
        permission_mode: 'approval-required',
      })
    }
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

    // 1. Header is clean: no standalone sync button, no standalone effort select, no standalone Orch trigger button
    expect(host.querySelector('button[aria-label="同步上游模型"]')).toBeNull()
    expect(host.querySelector('button[aria-label="思考等级"]')).toBeNull()
    expect(host.querySelector('button[aria-label="Orchestrator 角色设置"]')).toBeNull()
    const modelBtn = host.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!
    expect(modelBtn.querySelector('[data-anti-effort-badge]')?.textContent).toBe('High')

    // 2. Open model selector and click Orch · Neon -> closes immediately, hides effort badge, aligns backend
    await act(async () => { modelBtn.click() })
    const orchOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      el => el.textContent?.includes('Orch · Neon'),
    )!
    await act(async () => { orchOption.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(modelBtn.getAttribute('aria-expanded')).toBe('false')
      expect(modelBtn.querySelector('[data-anti-effort-badge]')).toBeNull()
      expect(modelBtn.textContent).toContain('Orch · Neon')
      expect(called.some(c => c.method === 'PATCH' && c.path === '/api/anti/profiles/default/orchestrator')).toBe(true)
    })

    // 3. Re-open dropdown and click "模型筛选与 Orch 预设" -> opens standalone Orchestrator modal
    await act(async () => { modelBtn.click() })
    const openSettingsBtn = document.body.querySelector<HTMLButtonElement>('[data-anti-open-model-settings]')!
    await act(async () => { openSettingsBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[aria-labelledby="agy-orchestrator-title"]')).not.toBeNull()
      expect(document.body.querySelector('[data-anti-orchestrator-section]')).not.toBeNull()
      expect(document.body.querySelector('[data-anti-model-visibility-section]')).not.toBeNull()
    })

    // Sync upstream models inside modal
    const syncBtn = document.body.querySelector<HTMLButtonElement>('[data-anti-models-orch-section] button[aria-label="同步上游模型"]')!
    await act(async () => { syncBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(c => c.method === 'POST' && c.path === '/api/anti/models/sync')).toBe(true)
    })

    // 4. Planner candidates strictly align with official roles (no GPT-OSS 120B); Carbon omits XHigh effort
    const planner1Select = document.body.querySelector<HTMLSelectElement>('select[aria-label="预设 1 Planner 模型"]')!
    const planner1Options = [...planner1Select.options].map(o => o.value)
    expect(planner1Options).not.toContain('gpt-oss-120b')
    expect(planner1Options).toContain('gemini-4-neon')
    expect(planner1Options).toContain('gemini-4-carbon')

    const preset2EffortGroup = document.body.querySelector<HTMLElement>('[role="radiogroup"][aria-label="预设 2 Planner 思考等级"]')!
    expect(preset2EffortGroup.textContent).not.toContain('XHigh')

    // Customize Preset 1 name + planner xhigh + executor medium + hide GPT-OSS 120B, then click 保存设置
    const preset1NameInput = document.body.querySelector<HTMLInputElement>('input[aria-label="预设 1 名称"]')!
    const preset1PlannerXHigh = document.body.querySelector<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="预设 1 Planner 思考等级"] button[aria-label="xhigh"]',
    )!
    const preset1ExecMedium = document.body.querySelector<HTMLButtonElement>(
      '[role="radiogroup"][aria-label="预设 1 Executor 思考等级"] button[aria-label="medium"]',
    )!
    const hideGptCheckbox = document.body.querySelector<HTMLInputElement>('input[aria-label="显示模型 GPT-OSS 120B"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(preset1NameInput, '主力架构')
      preset1NameInput.dispatchEvent(new Event('input', { bubbles: true }))
      preset1NameInput.dispatchEvent(new Event('change', { bubbles: true }))
      preset1PlannerXHigh.click()
      preset1ExecMedium.click()
      hideGptCheckbox.click()
    })

    const saveBtn = [...document.body.querySelectorAll<HTMLButtonElement>('[aria-labelledby="agy-orchestrator-title"] button')].find(
      b => b.textContent?.trim() === '保存设置',
    )!
    await act(async () => { saveBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(called.some(
        c => c.method === 'PATCH'
          && c.path === '/api/anti/models/config'
          && JSON.stringify((c.body as { hidden_models?: string[] })?.hidden_models) === JSON.stringify(['gpt-oss-120b']),
      )).toBe(true)
      expect(modelBtn.textContent).toContain('Orch · 主力架构')
    })

    // Close modal, confirm dropdown hides GPT-OSS 120B and shows renamed preset, then submit a run with role alignment fields
    const closeOrchBtn = [...document.body.querySelectorAll<HTMLButtonElement>('[aria-labelledby="agy-orchestrator-title"] button')].find(
      b => b.textContent?.trim() === '关闭',
    )!
    await act(async () => { closeOrchBtn.click() })
    await flush()

    await act(async () => { modelBtn.click() })
    const dropdownText = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map(el => el.textContent).join(' | ')
    expect(dropdownText).not.toContain('GPT-OSS 120B')
    expect(dropdownText).toContain('Orch · 主力架构')
    await act(async () => { modelBtn.click() })

    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Run aligned preset')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    await vi.waitFor(async () => {
      await flush()
      const submitCall = called.find(c => c.method === 'POST' && c.path === `/api/anti/sessions/${session.id}/runs`)
      expect(submitCall).toBeDefined()
      expect(submitCall?.body).toMatchObject({
        model: 'gemini-pro-orchestrator-neon',
        orchestrator_planner: 'gemini-4-neon-xhigh',
        orchestrator_executor: 'gemini-4-hydrogen-medium',
      })
    })

    // Account management modal stays strictly account-focused (no model settings tab or subtitle)
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-anti-account-pill]')!.click() })
    await vi.waitFor(async () => {
      await flush()
      const accDialog = document.body.querySelector('[aria-labelledby="agy-accounts-title"]')
      expect(accDialog).not.toBeNull()
      expect(accDialog?.querySelector('[data-anti-models-orch-section]')).toBeNull()
      expect(accDialog?.querySelector('[role="tab"]')).toBeNull()
      expect(accDialog?.textContent).not.toContain('所有会话共用上下文与配置')
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

it('never auto-refreshes usage on a timer and only queries on explicit manual click', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-25T10:00:00Z'))

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
        <AntiAccountUsageButton running onChecked={() => {}} />
      </QueryClientProvider>,
    ))

    // Even after 30 minutes of visible dwell, 0 automatic quota probes are fired
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1000) })
    expect(usageCalls).toBe(0)

    // Manual click on button triggers exactly 1 probe
    await act(async () => {
      host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!.click()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(usageCalls).toBe(1)

    // Another 30 minutes later -> still no automatic re-query
    await act(async () => { await vi.advanceTimersByTimeAsync(30 * 60 * 1000) })
    expect(usageCalls).toBe(1)

    // Manual click on popover "刷新" button triggers call #2
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新反重力额度"]')!.click()
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(usageCalls).toBe(2)
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('renders layered account cards with Gemini 5h/weekly bars, single card settings entry, expandable details, and no bulk refresh-all', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const freshAt = new Date(Date.now() - 60_000).toISOString()
  const staleAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
  const refreshCalls: string[] = []
  const tierPatches: Array<{ path: string; body: Record<string, unknown> }> = []
  let profilesPayload: {
    active: string
    profiles: Array<{
      id: string
      name: string
      has_credentials: boolean
      auth_state: string
      account_tier?: string
      account_tier_name?: string
      usage?: {
        checked_at: string
        min_remaining_pct: number
        rows: Array<{ model: string; limit: string; remaining_pct: number; resets_at: string | null }>
      }
    }>
  } = {
    active: 'main',
    profiles: [
      {
        id: 'default',
        name: '系统默认',
        has_credentials: true,
        auth_state: 'authenticated',
      },
      {
        id: 'main',
        name: '主账号',
        has_credentials: true,
        auth_state: 'authenticated',
        account_tier: 'ultra',
        account_tier_name: 'Google AI Ultra',
        usage: {
          checked_at: staleAt,
          min_remaining_pct: 40,
          rows: [
            { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 82, resets_at: '2026-11-26T12:00:00Z' },
            { model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 64.5, resets_at: '2026-12-01T00:00:00Z' },
            { model: 'Claude & GPT (shared)', limit: 'Five Hour Limit Remaining', remaining_pct: 40, resets_at: '2026-11-26T12:00:00Z' },
            { model: 'Claude & GPT (shared)', limit: 'Weekly Limit Remaining', remaining_pct: 100, resets_at: null },
          ],
        },
      },
      {
        id: 'backup',
        name: '备用账号',
        has_credentials: true,
        auth_state: 'authenticated',
        account_tier: 'pro',
        account_tier_name: 'Google AI Pro',
        usage: {
          checked_at: freshAt,
          min_remaining_pct: 18,
          rows: [
            { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 18, resets_at: '2026-11-26T12:00:00Z' },
            { model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 55, resets_at: '2026-12-01T00:00:00Z' },
          ],
        },
      },
    ],
  }

  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const reply = (data: unknown, status = 200) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(JSON.stringify(data)),
    })
    if (path === '/api/anti/status') return reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply(profilesPayload)
    if (path.startsWith('/api/anti/profiles/') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body || '{}')) as Record<string, unknown>
      tierPatches.push({ path, body })
      const targetId = path.split('/').pop()
      profilesPayload = {
        ...profilesPayload,
        profiles: profilesPayload.profiles.map(p => (
          p.id === targetId
            ? {
                ...p,
                account_tier: (body.account_tier as string) || undefined,
                account_tier_name: body.account_tier === 'pro' ? 'Google AI Pro' : undefined,
              }
            : p
        )),
      }
      return reply(profilesPayload)
    }
    if (path === '/api/projects') return reply({ items: [] })
    if (path.startsWith('/api/file-transfer')) return reply([])
    if (path === '/api/anti/sessions') return reply([])
    if (path === '/api/anti/workers') return reply({ items: [] })
    if (path.startsWith('/api/anti/account-usage') && init?.method === 'POST') {
      refreshCalls.push(path)
      return reply({ state: 'authenticated', rows: profilesPayload.profiles[1].usage!.rows })
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
      expect(host.querySelector('[data-anti-account-pill]')).not.toBeNull()
    })

    // Outer pill keeps cached 5h percentage & tier visual effect without tier text label
    const outerPill = host.querySelector<HTMLButtonElement>('[data-anti-account-pill]')!
    expect(outerPill.dataset.accountTier).toBe('ultra')
    expect(outerPill.className).toContain('ga-account-pill--ultra')
    expect(outerPill.getAttribute('title')).toContain('Google AI Ultra')
    expect(outerPill.textContent).toContain('40%')
    expect(outerPill.textContent).not.toMatch(/ultra/i)

    // Open Account Management modal -> NO automatic refresh-all or quota probe, and 'default' is excluded from cards
    await act(async () => { outerPill.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(document.body.querySelector('[data-account-card="main"]')).not.toBeNull()
    })
    expect(refreshCalls).toEqual([])

    const dialog = document.body.querySelector('[role="dialog"][aria-labelledby="agy-accounts-title"]')!
    const listWidth = dialog.parentElement!.style.width
    expect(dialog.querySelector('h2')?.textContent).toBe('账号管理')
    expect(dialog.querySelector('[role="tab"]')).toBeNull()
    expect(dialog.querySelector('[data-account-card="default"]')).toBeNull()
    expect(dialog.textContent).not.toContain('所有会话共用上下文与配置')
    expect(dialog.querySelector('button[aria-label="刷新全部额度"]')).toBeNull()
    expect(dialog.querySelector('button[aria-label="添加账号"]')).not.toBeNull()
    expect(dialog.querySelector('button[aria-label="账号管理设置"]')).toBeNull()

    // Top-right button switches to compact add-account view with identical width
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="添加账号"]')!.click() })
    await flush()
    expect(dialog.querySelector('[data-account-add-view]')).not.toBeNull()
    expect(dialog.parentElement!.style.width).toBe(listWidth)
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="返回账号列表"]')!.click() })
    await flush()

    // Account cards show clean identity + tier badge without proactive quota bars
    const mainCard = dialog.querySelector('[data-account-card="main"]')!
    const backupCard = dialog.querySelector('[data-account-card="backup"]')!
    expect(mainCard.querySelector('[data-account-tier-badge="ultra"]')?.textContent).toContain('Ultra')
    expect(backupCard.querySelector('[data-account-tier-badge="pro"]')?.textContent).toContain('Pro')
    expect(mainCard.querySelector('[role="progressbar"]')).toBeNull()
    expect(mainCard.querySelector('[data-account-quota-details="main"]')).toBeNull()
    expect(mainCard.querySelector('button[aria-label="查询额度：主账号"]')).not.toBeNull()
    expect(mainCard.querySelector('button[aria-label="账号设置：主账号"]')).not.toBeNull()
    expect(backupCard.querySelector('button[aria-label="切换到备用账号"]')).not.toBeNull()

    // Click "查询额度" on card -> probes backend and expands shared quota progress bars (with '(shared)' stripped)
    const queryBtn = mainCard.querySelector<HTMLButtonElement>('button[aria-label="查询额度：主账号"]')!
    await act(async () => { queryBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(refreshCalls).toEqual(['/api/anti/account-usage?profile_id=main'])
      expect(mainCard.querySelector('[data-account-quota-details="main"]')).not.toBeNull()
    })
    const details = mainCard.querySelector('[data-account-quota-details="main"]')!
    expect(details.querySelector('[data-anti-quota-bars]')).not.toBeNull()
    expect(details.textContent).toContain('Claude & GPT')
    expect(details.textContent).not.toContain('(shared)')
    expect(details.textContent).toContain('40%')
    expect(details.querySelectorAll('[role="progressbar"]')).toHaveLength(4)

    // Navigate into account settings -> uniform width, no duplicated quota/add blocks, manual tier tagging works cleanly via PATCH
    await act(async () => {
      mainCard.querySelector<HTMLButtonElement>('button[aria-label="账号设置：主账号"]')!.click()
    })
    await flush()
    expect(dialog.parentElement!.style.width).toBe(listWidth)
    expect(dialog.querySelector('[data-account-settings-tier="ultra"]')?.textContent).toContain('Google AI Ultra')
    const proTierBtn = dialog.querySelector<HTMLButtonElement>('[data-account-tier-option="pro"]')!
    await act(async () => { proTierBtn.click() })
    await vi.waitFor(async () => {
      await flush()
      expect(tierPatches).toEqual([{ path: '/api/anti/profiles/main', body: { account_tier: 'pro' } }])
    })
    await act(async () => { dialog.querySelector<HTMLButtonElement>('button[aria-label="返回账号列表"]')!.click() })
    await flush()

    // Escape closes the dropdown and returns focus to trigger pill; outside pointerdown also dismisses it
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await flush()
    expect(document.body.querySelector('[role="dialog"][aria-labelledby="agy-accounts-title"]')).toBeNull()
    expect(document.activeElement).toBe(outerPill)
    await act(async () => { outerPill.click() })
    await flush()
    expect(document.body.querySelector('[role="dialog"][aria-labelledby="agy-accounts-title"]')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    await flush()
    expect(document.body.querySelector('[role="dialog"][aria-labelledby="agy-accounts-title"]')).toBeNull()

    // Alert state suppresses tier shimmer class on outer pill so warning/login-required remains dominant
    profilesPayload = {
      ...profilesPayload,
      profiles: profilesPayload.profiles.map(p => (
        p.id === 'main' ? { ...p, auth_state: 'login_required' } : p
      )),
    }
    await act(async () => { await cache.refetchQueries({ queryKey: ['agy-profiles'] }) })
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector<HTMLButtonElement>('[data-anti-account-pill]')?.className).not.toContain('ga-account-pill--pro')
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('previews cached quota popover on hover without network refresh, keeps open onto panel, and pins on click', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  let usageCalls = 0
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/account-usage') {
      usageCalls += 1
      return reply({
        state: 'authenticated',
        rows: [
          { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 77, resets_at: '2026-11-26T12:00:00Z' },
        ],
      })
    }
    if (path === '/api/anti/quota') return reply([])
    if (path === '/api/anti/stats?today=true') {
      return reply({
        window_hours: 24, total_runs: 1, success_runs: 1, failed_runs: 0,
        rate_limited_runs: 0, total_tokens: 100, cache_hit_ratio: 0.5, estimated_cost_usd: 0.01,
      })
    }
    return reply({})
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const dialog = () => document.body.querySelector<HTMLElement>('[role=dialog][aria-label="反重力剩余额度"]')

  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <AntiAccountUsageButton
          running
          profileName="系统默认"
          cachedUsage={{
            checked_at: new Date(Date.now() - 3_600_000).toISOString(),
            min_remaining_pct: 64.5,
            rows: [
              { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 82, resets_at: '2026-11-26T12:00:00Z' },
              { model: 'Gemini', limit: 'Weekly Limit Remaining', remaining_pct: 64.5, resets_at: '2026-12-01T00:00:00Z' },
            ],
          }}
          onChecked={() => {}}
        />
      </QueryClientProvider>,
    ))

    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(usageCalls).toBe(0)
    expect(dialog()?.textContent).toContain('缓存 ')
    expect(dialog()?.textContent).toContain('82%')
    expect(dialog()?.textContent).toContain('64.5%')

    // Moving pointer from trigger button onto the portal popover wrapper preserves hover preview
    const panelWrapper = dialog()!.parentElement!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: panelWrapper }))
      panelWrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: btn }))
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(dialog()).not.toBeNull()
    expect(usageCalls).toBe(0)

    // Leaving panel dismisses after short grace delay
    await act(async () => {
      panelWrapper.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(dialog()).toBeNull()
    expect(usageCalls).toBe(0)

    // Hover then click trigger button -> pins panel and triggers live refresh
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(dialog()).not.toBeNull()
    expect(usageCalls).toBe(0)
    await act(async () => {
      btn.click()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(usageCalls).toBe(1)
    expect(dialog()?.textContent).toContain('77%')

    // Leaving pinned popover keeps it open until explicitly dismissed by clicking button again
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(dialog()).not.toBeNull()

    await act(async () => {
      btn.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(dialog()).toBeNull()
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})

it('selects the session from ?session= query param and highlights unread completed runs from /api/anti/sessions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const sessionsPayload = [
    {
      id: 'anti-1',
      project: 'demo',
      title: '最近空闲',
      workspace: 'D:/demo',
      updated_at: '2026-11-26T10:00:00Z',
      active_run_id: null,
      completed_run_id: null,
      last_outcome: null,
      last_error: null,
      has_conversation: true,
      acp_connected: false,
      profile_id: null,
      grants: [],
      engine: 'anti',
    },
    {
      id: 'anti-2',
      project: 'demo',
      title: '后台已完成',
      workspace: 'D:/demo',
      updated_at: '2026-11-26T09:00:00Z',
      active_run_id: null,
      completed_run_id: 'run-done-2',
      last_outcome: 'completed',
      last_error: null,
      has_conversation: true,
      acp_connected: false,
      profile_id: null,
      grants: [],
      engine: 'anti',
    },
  ]
  const fetchMock = vi.fn(async (path: string) => {
    const reply = (data: unknown) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(data)) })
    if (path === '/api/anti/status') return reply({ state: 'ready', agy_available: true, auth_state: 'authenticated' })
    if (path === '/api/anti/profiles') return reply({ active: 'default', profiles: [{ id: 'default', name: '系统默认' }] })
    if (path === '/api/anti/sessions') return reply(sessionsPayload)
    if (path === '/api/anti/models') return reply({ items: [{ id: 'gemini-4-hydrogen-high', display_name: 'Gemini 4 Hydrogen' }] })
    if (path === '/api/anti/models/config') return reply({ config_path: '', orchestrator_presets: [], hidden_models: [] })
    if (path === '/api/anti/commands') return reply({ items: [] })
    if (path === '/api/anti/sessions/anti-1/runs' || path === '/api/anti/sessions/anti-2/runs') return reply([])
    if (path === '/api/anti/quota') return reply([])
    if (path === '/api/anti/stats?today=true') {
      return reply({ window_hours: 24, total_runs: 0, success_runs: 0, failed_runs: 0, rate_limited_runs: 0, total_tokens: 0, cache_hit_ratio: 0, estimated_cost_usd: 0 })
    }
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  function LocationProbe() {
    const loc = useLocation()
    return <output data-loc={`${loc.pathname}${loc.search}`} />
  }
  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter initialEntries={['/anti?session=anti-2']}>
          <AntiChat />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    ))
    await vi.waitFor(async () => {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
      const completedRow = host.querySelector('[data-session-id="anti-2"]')
      expect(completedRow?.getAttribute('data-activity')).toBe('completed')
      expect(completedRow?.querySelector('[aria-current="page"]')).not.toBeNull()
      // Deep link ?session= is consumed cleanly back to /anti
      expect(host.querySelector('output')?.getAttribute('data-loc')).toBe('/anti')
    })
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('keeps cached quota rows and layout stable while pending or failing, then syncs profile cache on refresh', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const initialCheckedAt = new Date(Date.now() - 120_000).toISOString()
  let resolveProbe: ((res: unknown) => void) | null = null
  const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })

  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (path === '/api/anti/account-usage') {
      return new Promise(resolve => {
        resolveProbe = resolve
      })
    }
    if (path === '/api/anti/quota') return Promise.resolve(reply([]))
    if (path === '/api/anti/stats?today=true') {
      return Promise.resolve(reply({
        window_hours: 24, total_runs: 1, success_runs: 1, failed_runs: 0,
        rate_limited_runs: 0, total_tokens: 100, cache_hit_ratio: 0.5, estimated_cost_usd: 0.01,
      }))
    }
    return Promise.resolve(reply({}))
  }))

  const initialRows = [
    { model: 'Claude & GPT (shared)', limit: 'Weekly Limit Remaining', remaining_pct: 70, resets_at: '2026-12-01T00:00:00Z' },
    { model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 80, resets_at: '2026-11-26T15:00:00Z' },
  ]
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  cache.setQueryData(['agy-profiles'], {
    active: 'default',
    profiles: [{
      id: 'default',
      name: '系统默认',
      has_credentials: true,
      auth_state: 'authenticated',
      usage: { checked_at: initialCheckedAt, min_remaining_pct: 70, rows: initialRows },
    }],
  })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const dialog = () => document.body.querySelector<HTMLElement>('[role=dialog][aria-label="反重力剩余额度"]')
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })

  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <AntiAccountUsageButton
          running
          profileName="系统默认"
          cachedUsage={{ checked_at: initialCheckedAt, min_remaining_pct: 70, rows: initialRows }}
          onChecked={() => {}}
        />
      </QueryClientProvider>,
    ))

    // Trigger click -> opens dialog & starts refresh (in flight)
    const triggerBtn = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    await act(async () => { triggerBtn.click() })
    await flush()

    const refreshBtn = dialog()!.querySelector<HTMLButtonElement>('button[aria-label="刷新反重力额度"]')!
    expect(refreshBtn.className).toContain('w-[4.25rem]')
    expect(refreshBtn.textContent).toBe('检测中')
    // Status line & sorted cached progress bars stay intact while refreshing (no hide/pop jump, '(shared)' stripped)
    expect(dialog()!.querySelector('[data-anti-usage-status]')?.textContent).toContain('缓存 ')
    expect(dialog()!.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
    const pendingModels = [...dialog()!.querySelectorAll('[data-anti-quota-bars] > li')].map(li => li.querySelector('span')?.textContent)
    expect(pendingModels).toEqual(['Gemini', 'Claude & GPT'])
    expect(dialog()!.textContent).not.toContain('(shared)')

    // Empty probe failure keeps existing rows and shows detail message below
    await act(async () => {
      resolveProbe!(reply({ state: 'unverified', rows: [], detail: '网络超时，请稍后再试' }))
    })
    await flush()
    expect(dialog()!.textContent).toContain('80%')
    expect(dialog()!.textContent).toContain('70%')
    expect(dialog()!.textContent).toContain('网络超时，请稍后再试')

    // Second refresh succeeds with Reported Quota fallback -> sorts deterministically, translates label, updates profiles cache
    resolveProbe = null
    await act(async () => { refreshBtn.click() })
    await flush()
    await act(async () => {
      resolveProbe!(reply({
        state: 'authenticated',
        rows: [
          { model: 'Claude', limit: 'Reported Quota', remaining_pct: 35, resets_at: '2026-11-26T16:00:00Z' },
          { model: 'Gemini', limit: 'Reported Quota', remaining_pct: 76, resets_at: null },
        ],
      }))
    })
    await flush()
    expect(dialog()!.querySelector('[data-anti-usage-status]')?.textContent).toContain('更新于')
    expect(dialog()!.textContent).toContain('当前额度')
    const settledModels = [...dialog()!.querySelectorAll('ul > li')].map(li => li.querySelector('span')?.textContent)
    expect(settledModels).toEqual(['Gemini', 'Claude'])
    const cachedProfiles = cache.getQueryData<{ profiles: Array<{ id: string; usage?: { min_remaining_pct?: number; rows: Array<{ model: string }> } }> }>(['agy-profiles'])
    expect(cachedProfiles?.profiles[0].usage?.min_remaining_pct).toBe(35)
    expect(cachedProfiles?.profiles[0].usage?.rows.map(r => r.model)).toEqual(['Gemini', 'Claude'])
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})




it('renders per-model cost breakdown in AntiAccountUsageButton stats footer', async () => {
  const reply = (data: unknown) => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(data)) })
  vi.stubGlobal('fetch', vi.fn((path: string) => {
    if (path === '/api/anti/account-usage') {
      return Promise.resolve(reply({
        state: 'authenticated',
        rows: [{ model: 'Gemini', limit: 'Five Hour Limit Remaining', remaining_pct: 90, resets_at: null }],
      }))
    }
    if (path === '/api/anti/quota') return Promise.resolve(reply([]))
    if (path.startsWith('/api/anti/stats')) {
      return Promise.resolve(reply({
        window_hours: 0,
        total_runs: 1,
        success_runs: 1,
        failed_runs: 0,
        rate_limited_runs: 0,
        total_tokens: 155_000,
        cache_hit_ratio: 0.5,
        estimated_cost_usd: 0.0042,
        by_model: [
          {
            model: 'gemini-4-neon',
            display_name: 'Gemini 4 Neon',
            runs: 1,
            calls: 1,
            roles: ['planner'],
            input_tokens: 50_000,
            output_tokens: 2_000,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            thinking_tokens: 0,
            estimated_cost_usd: 0.003,
          },
          {
            model: 'claude-sonnet-5-5',
            display_name: 'Claude Sonnet 5.5',
            runs: 1,
            calls: 2,
            roles: ['executor'],
            input_tokens: 100_000,
            output_tokens: 3_000,
            cache_read_tokens: 77_500,
            cache_write_tokens: 0,
            thinking_tokens: 0,
            estimated_cost_usd: 0.0012,
          },
        ],
      }))
    }
    return Promise.resolve(reply({}))
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const dialog = () => document.body.querySelector<HTMLElement>('[role=dialog][aria-label="反重力剩余额度"]')
  const flush = () => act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })

  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <AntiAccountUsageButton running profileName="系统默认" onChecked={() => {}} />
      </QueryClientProvider>,
    ))
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="检测反重力额度"]')!
    await act(async () => { btn.click() })
    await flush()
    await flush()

    // Per-model breakdown is collapsed by default behind the "明细" button, and strips (规划)/(执行) suffixes
    expect(dialog()?.querySelector('[data-anti-usage-by-model]')).toBeNull()
    const toggleBtn = dialog()?.querySelector<HTMLButtonElement>('[data-anti-usage-breakdown-toggle]')
    expect(toggleBtn).not.toBeNull()
    expect(toggleBtn!.textContent).toContain('明细')
    await act(async () => { toggleBtn!.click() })
    await flush()

    const byModelEl = dialog()?.querySelector('[data-anti-usage-by-model]')
    expect(byModelEl).not.toBeNull()
    expect(byModelEl!.textContent).toContain('Gemini 4 Neon')
    expect(byModelEl!.textContent).toContain('Claude Sonnet 5.5')
    expect(byModelEl!.textContent).not.toContain('(规划)')
    expect(byModelEl!.textContent).not.toContain('(执行)')
    expect(byModelEl!.textContent).toContain('~$0.003')
    expect(byModelEl!.textContent).toContain('~$0.0012')
  } finally {
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('enforces closeOnBackdrop=false on AntiChat creating modal, guards dirty AntiAgyProfiles close, and ignores stale codeLoginStatus after cancel', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  let resolveStatus!: (res: Response) => void
  const statusPending = new Promise<Response>((resolve) => { resolveStatus = resolve })
  const profilesPayload = {
    active: 'work',
    login_profile: null,
    profiles: [
      { id: 'work', name: '工作', auth_state: 'authenticated', has_credentials: true, path: 'C:/work' },
    ],
  }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname
    if (path === '/api/anti/status' || path === '/api/anti/daemon/status') return Promise.resolve(reply({ state: 'ready', managed: true, active_count: 0, agy_available: true, auth_state: 'authenticated' }))
    if (path === '/api/file-transfer') return Promise.resolve(reply([]))
    if (path === '/api/anti/profiles') return Promise.resolve(reply(profilesPayload))
    if (path === '/api/anti/sessions') return Promise.resolve(reply([]))
    if (path === '/api/anti/models') return Promise.resolve(reply({ items: [] }))
    if (path === '/api/anti/models/config') return Promise.resolve(reply({ orchestrator_presets: [], hidden_models: [] }))
    if (path === '/api/anti/profiles/work/login/start' && init?.method === 'POST') {
      return Promise.resolve(reply({ flow_id: 'flow-stale', profile_id: 'work', phase: 'waiting_code', authorization_url: 'https://accounts.google.com/auth' }))
    }
    if (path === '/api/anti/profiles/login/status/flow-stale' && (!init?.method || init.method === 'GET')) {
      return statusPending
    }
    if (path === '/api/anti/profiles/login/cancel/flow-stale' && init?.method === 'POST') {
      return Promise.resolve(reply({ ok: true }))
    }
    return Promise.resolve(reply({}))
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)

  try {
    await act(async () => root.render(
      <QueryClientProvider client={cache}>
        <MemoryRouter>
          <AntiChat />
        </MemoryRouter>
      </QueryClientProvider>,
    ))
    await flush()

    // 1. creating modal ignores backdrop clicks
    const createBtn = host.querySelector<HTMLButtonElement>('[data-testid="create-session-empty"]')!
    await act(async () => { createBtn.click() })
    await flush()
    const createDialog = document.body.querySelector('[aria-labelledby="anti-create-session-title"]')!
    expect(createDialog).not.toBeNull()
    await act(async () => {
      createDialog.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.body.querySelector('[aria-labelledby="anti-create-session-title"]')).not.toBeNull()
    await act(async () => {
      const cancelBtn = [...createDialog.querySelectorAll('button')].find(b => b.textContent?.trim() === '取消')!
      cancelBtn.click()
    })
    expect(document.body.querySelector('[aria-labelledby="anti-create-session-title"]')).toBeNull()

    // 2. AntiAgyProfiles dirty add-form confirms before discarding on close
    const accountsBtn = [...host.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('Agy 账号：'))!
    await act(async () => { accountsBtn.click() })
    await flush()
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[aria-label="添加账号"]')!.click() })
    await flush()
    const nameInput = document.body.querySelector('#agy-profile-name') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(nameInput, '草稿账号')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-labelledby="agy-accounts-title"] button[aria-label="关闭"]')!.click()
      await Promise.resolve()
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(document.body.querySelector('[aria-labelledby="agy-accounts-title"]')).not.toBeNull()
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[aria-labelledby="agy-accounts-title"] button[aria-label="关闭"]')!.click()
      await Promise.resolve()
    })
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(document.body.querySelector('[aria-labelledby="agy-accounts-title"]')).toBeNull()

    // 3. Stale codeLoginStatus response after cancelling must not resurrect codeLogin form
    await act(async () => { accountsBtn.click() })
    await flush()
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[aria-label="账号设置：工作"]')!.click() })
    await flush()
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[aria-label="授权码登录：工作"]')!.click() })
    await flush()
    expect(document.body.textContent).toContain('Google 授权码登录')

    // Trigger in-flight status refresh, then cancel before status resolves
    await act(async () => { document.body.querySelector<HTMLButtonElement>('button[aria-label="刷新授权状态"]')!.click() })
    await act(async () => {
      const cancelLoginBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === '取消')!
      cancelLoginBtn.click()
    })
    expect(document.body.textContent).not.toContain('Google 授权码登录')

    await act(async () => {
      resolveStatus(reply({ flow_id: 'flow-stale', profile_id: 'work', phase: 'waiting_code', authorization_url: 'https://accounts.google.com/auth' }))
      await Promise.resolve()
    })
    expect(document.body.textContent).not.toContain('Google 授权码登录')
  } finally {
    confirmSpy.mockRestore()
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('confirms via dialog.confirm before clearing AntiQueuedDock items', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  })
  const session = {
    id: 's-q-clear',
    title: 'Queue Clear Session',
    project: 'demo',
    workspace: 'D:/demo',
    has_conversation: false,
    queued_count: 1,
  }
  let queueItems = [{ id: 'q-1', prompt: '待清空消息', mode: 'plan', permission_mode: 'approval-required' }]
  let deleteCalls = 0
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/anti/status') return Promise.resolve(reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' }))
    if (path === '/api/anti/profiles') return Promise.resolve(reply({ active: 'default', profiles: [] }))
    if (path === '/api/anti/sessions') return Promise.resolve(reply([{ ...session, queued_count: queueItems.length }]))
    if (path === `/api/anti/sessions/${session.id}/runs`) return Promise.resolve(reply([]))
    if (path === `/api/anti/sessions/${session.id}/queue` && method === 'GET') return Promise.resolve(reply({ items: queueItems, pause_reason: null }))
    if (path === `/api/anti/sessions/${session.id}/queue` && method === 'DELETE') {
      deleteCalls += 1
      queueItems = []
      return Promise.resolve(reply({ items: [], pause_reason: null }))
    }
    if (path.startsWith('/api/anti/models')) return Promise.resolve(reply({ items: [] }))
    if (path.startsWith('/api/file-transfer')) return Promise.resolve(reply([]))
    return Promise.resolve(reply({}))
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) })
  const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('[data-anti-queued-dock]')).not.toBeNull()
    })

    const clearBtn = [...host.querySelectorAll<HTMLButtonElement>('[data-anti-queued-dock] button')]
      .find(b => b.textContent?.trim() === '清空')!
    await act(async () => { clearBtn.click(); await Promise.resolve() })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith(
      '清空待发队列？',
      expect.stringContaining('1 条'),
      expect.objectContaining({ tone: 'danger' }),
    )
    expect(deleteCalls).toBe(0)
    expect(host.querySelector('[data-anti-queued-dock]')).not.toBeNull()

    await act(async () => { clearBtn.click(); await Promise.resolve() })
    await vi.waitFor(async () => {
      await flush()
      expect(deleteCalls).toBe(1)
      expect(host.querySelector('[data-anti-queued-dock]')).toBeNull()
    })
  } finally {
    confirmSpy.mockRestore()
    await act(async () => root.unmount())
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('routes session rename failures to toast without sticky alert and surfaces orchestrator preset persistence errors', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  for (const item of useToastStore.getState().items) {
    useToastStore.getState().dismiss(item.id)
  }
  const reply = (data: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(data),
    json: async () => JSON.parse(JSON.stringify(data)),
  })
  const session = { id: 's-toast-1', title: '初始标题', project: 'demo', workspace: 'D:/demo', has_conversation: false }
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const path = new URL(url, 'http://localhost').pathname
    const method = init?.method ?? 'GET'
    if (path === '/api/anti/status') return Promise.resolve(reply({ state: 'ready', managed: true, agy_available: true, auth_state: 'authenticated' }))
    if (path === '/api/anti/profiles') return Promise.resolve(reply({ active: 'p-1', profiles: [{ id: 'p-1', name: '主力', has_credentials: true, auth_state: 'authenticated' }] }))
    if (path === '/api/anti/sessions') return Promise.resolve(reply([session]))
    if (path === `/api/anti/sessions/${session.id}` && method === 'PATCH') {
      return Promise.resolve(reply({ detail: { message: '会话标题包含非法字符' } }, 400))
    }
    if (path === `/api/anti/sessions/${session.id}/runs`) return Promise.resolve(reply([]))
    if (path === `/api/anti/sessions/${session.id}/queue`) return Promise.resolve(reply({ items: [], pause_reason: null }))
    if (path === '/api/anti/models') return Promise.resolve(reply({
      items: [
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', family: 'claude' },
        { id: 'claude-orchestrator', name: 'Claude Orchestrator', is_orchestrator: true },
      ],
    }))
    if (path === '/api/anti/models/config') return Promise.resolve(reply({ orchestrator_presets: [], hidden_models: [] }))
    if (path === '/api/anti/profiles/p-1/orchestrator' && method === 'PATCH') {
      return Promise.resolve(reply({ detail: '预设同步失败' }, 500))
    }
    if (path.startsWith('/api/file-transfer')) return Promise.resolve(reply([]))
    return Promise.resolve(reply({}))
  }))

  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) })

  try {
    await act(async () => root.render(<QueryClientProvider client={cache}><AntiChat /></QueryClientProvider>))
    await vi.waitFor(async () => {
      await flush()
      expect(host.querySelector('aside')?.textContent).toContain('初始标题')
    })

    const rowBtn = Array.from(host.querySelectorAll('aside button')).find(b => b.textContent?.includes('初始标题')) as HTMLButtonElement
    await act(async () => { rowBtn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    const input = host.querySelector<HTMLInputElement>('input[aria-label="重命名 初始标题"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '新标题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.blur()
    })

    await vi.waitFor(async () => {
      await flush()
      expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('会话标题包含非法字符'))).toBe(true)
    })
    expect(host.querySelector('p[role="alert"]')).toBeNull()

    // Select an orchestrator preset whose persistence fails -> toast.error fires
    const modelBtn = host.querySelector<HTMLButtonElement>('button[aria-label="模型"]')!
    await act(async () => { modelBtn.click() })
    await vi.waitFor(() => {
      const candidate = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.includes('Orch'))
      expect(candidate).toBeDefined()
    })
    const orchOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent?.includes('Orch'))!
    await act(async () => { orchOption.click() })

    await vi.waitFor(async () => {
      await flush()
      expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('预设同步失败'))).toBe(true)
    })
  } finally {
    await act(async () => root.unmount())
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    cache.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})
