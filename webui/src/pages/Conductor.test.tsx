// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConductorStore } from '@/stores/conductorStore'
import { useToastStore } from '@/stores/toastStore'
import Conductor from './Conductor'
import { resetPageState } from '@/utils/pageState'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  conductorStatus: vi.fn(),
  conductorSubagents: vi.fn(),
  conductorWorkflows: vi.fn(),
  conductorDeleteWorkflow: vi.fn(),
  conductorChat: vi.fn(),
  conductorLog: vi.fn(),
  conductorSendChat: vi.fn(),
  conductorStop: vi.fn(),
  conductorStart: vi.fn(),
  conductorSubagentAction: vi.fn(),
  conductorSubagent: vi.fn(),
  conductorSettings: vi.fn(),
  revealFile: vi.fn(),
  llms: vi.fn(),
  selectMainLlm: vi.fn(),
  selectSubagentLlm: vi.fn(),
  dialogConfirm: vi.fn(),
}))

vi.mock('@/stores/dialogStore', () => ({
  dialog: { confirm: mocks.dialogConfirm },
}))

vi.mock('@/api/client', () => ({
  api: {
    conductorStatus: mocks.conductorStatus,
    conductorSubagents: mocks.conductorSubagents,
    conductorWorkflows: mocks.conductorWorkflows,
    conductorDeleteWorkflow: mocks.conductorDeleteWorkflow,
    conductorChat: mocks.conductorChat,
    conductorLog: mocks.conductorLog,
    conductorSendChat: mocks.conductorSendChat,
    conductorStop: mocks.conductorStop,
    conductorStart: mocks.conductorStart,
    conductorSubagentAction: mocks.conductorSubagentAction,
    conductorSubagent: mocks.conductorSubagent,
    conductorSettings: mocks.conductorSettings,
    revealFile: mocks.revealFile,
    llms: mocks.llms,
  },
}))

vi.mock('@/components/PageShell', () => ({
  PageShell: ({ title, titleExtra, actions, middleArea, children }: {
    title: string
    titleExtra?: ReactNode
    actions?: ReactNode
    middleArea?: ReactNode
    children: ReactNode
  }) => (
    <div>
      <header><h1>{title}</h1>{titleExtra}{actions}{middleArea}</header>
      {children}
    </div>
  ),
}))

vi.mock('@/components/ModelSelect', () => ({
  MainModelSelect: ({ value, onChange }: { value?: string; onChange: (value: string) => void }) => (
    <select aria-label="Conductor 主模型" value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
      <option value="main">主模型</option>
    </select>
  ),
  SubagentModelSelect: ({ value, onChange, autoFocus }: {
    value: string | null
    onChange: (value: string | null) => void
    autoFocus?: boolean
  }) => (
    <select
      aria-label="子代理默认模型"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      autoFocus={autoFocus}
    >
      <option value="">跟随主模型</option>
      <option value="worker">子代理模型</option>
    </select>
  ),
}))

vi.mock('@/components/MarkdownView', () => ({
  MarkdownView: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('@/hooks/useHubEvent', () => ({
  useHubEvent: () => undefined,
}))

vi.mock('@/hooks/useSharedModelSelection', () => ({
  useSharedModelSelection: () => ({
    mainLlmKey: 'main',
    subagentLlmKey: null,
    mainLlmIndex: 0,
    subagentLlmIndex: 0,
    selectedSubagentLlmIndex: null,
    selectMainLlm: mocks.selectMainLlm,
    selectSubagentLlm: mocks.selectSubagentLlm,
  }),
}))

describe('Conductor chat scroll restoration', () => {
  let host: HTMLDivElement
  let root: Root | undefined
  let queryClient: QueryClient | undefined
  let animationFrames: FrameRequestCallback[]

  beforeEach(() => {
    resetPageState()
    vi.clearAllMocks()
    localStorage.clear()
    useConductorStore.getState().clear()
    useToastStore.setState({ items: [] })
    mocks.conductorStatus.mockResolvedValue({
      started: true,
      stopping: false,
      admission_open: true,
      loop_alive: true,
      agent_alive: true,
      subagents: { running: 0, stopped: 0 },
      chat_count: 1,
      auto_accept: true,
    })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })
    mocks.conductorWorkflows.mockResolvedValue({ items: [] })
    mocks.conductorChat.mockResolvedValue({
      items: [{ id: 'result-1', role: 'conductor', msg: 'finished', ts: 1 }],
    })
    mocks.conductorLog.mockResolvedValue({ log: [] })
    mocks.conductorSubagent.mockResolvedValue({
      id: 'reviewing', prompt: '检查桌面启动流程', reply: '完整回复正文',
      status: 'stopped', created_at: 3, updated_at: 3, review_status: 'pending',
      review_note: '', attempt: 1, generation: 1, request_id: 'request-1',
    })
    mocks.llms.mockResolvedValue({ llms: [] })

    animationFrames = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      animationFrames.push(callback)
      return animationFrames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: vi.fn(),
    })
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  afterEach(() => {
    act(() => root?.unmount())
    queryClient?.clear()
    host?.remove()
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function renderPage() {
    if (!root || !queryClient) throw new Error('test page not initialized')
    act(() => root?.render(
      <QueryClientProvider client={queryClient!}>
        <Conductor />
      </QueryClientProvider>,
    ))
  }

  async function flushQueries() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  // Under parallel-suite load a single setTimeout(0) can race react-query
  // resolution (full-suite runs failed different tests here three times in a
  // row). Poll inside `act` until the assertion holds instead of asserting
  // synchronously after one flush.
  async function waitFor(assertion: () => void, attempts = 40) {
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await flushQueries()
      try {
        assertion()
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  async function waitForInitialScrollFrame() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await flushQueries()
      if (
        useConductorStore.getState().chatMessages.length > 0
        && animationFrames.length > 0
      ) return
    }
    throw new Error('initial chat scroll frame was not scheduled')
  }

  function runAnimationFrames() {
    const callbacks = animationFrames.splice(0)
    act(() => callbacks.forEach((callback) => callback(0)))
  }

  function chatScroller(): HTMLDivElement {
    const element = host.querySelector('form')?.previousElementSibling
    if (!(element instanceof HTMLDivElement)) throw new Error('chat scroller not found')
    return element
  }

  function button(label: string): HTMLButtonElement {
    const match = Array.from(host.querySelectorAll('button')).find(
      (item) => (item.getAttribute('aria-label') || item.textContent?.trim()) === label,
    )
    if (!(match instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`)
    return match
  }

  it('opens the first non-empty snapshot at the latest message and restores a later reading position', async () => {
    renderPage()
    const firstScroller = chatScroller()
    Object.defineProperty(firstScroller, 'scrollHeight', { configurable: true, value: 900 })

    // The first render is empty. The later HTTP snapshot must still get a
    // chance to establish the initial position at the live edge.
    await waitForInitialScrollFrame()
    runAnimationFrames()
    expect(firstScroller.scrollTop).toBe(900)

    firstScroller.scrollTop = 240
    act(() => firstScroller.dispatchEvent(new Event('scroll', { bubbles: true })))
    act(() => root?.unmount())

    root = createRoot(host)
    renderPage()
    const restoredScroller = chatScroller()
    Object.defineProperty(restoredScroller, 'scrollHeight', { configurable: true, value: 1_200 })
    await flushQueries()
    runAnimationFrames()

    expect(restoredScroller.scrollTop).toBe(240)
  })

  it('shows task meaning and subagent lifecycle instead of model turn logs', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'awaiting_review',
        stage: 'reworking',
        subagents: {
          running: { generation: 1, state: 'running' },
          reworking: { generation: 2, state: 'running' },
          reviewing: { generation: 1, state: 'pending' },
          accepted: { generation: 1, state: 'accepted' },
        },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorChat.mockResolvedValue({
      items: [{
        id: 'user-1',
        role: 'user',
        msg: '分析项目性能并给出可以落地的优化方案',
        ts: 1,
        request_id: 'request-1',
        kind: null,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [
        {
          id: 'running', prompt: '扫描主要性能瓶颈', reply: '', status: 'running',
          created_at: 1, updated_at: 1, review_status: 'none', review_note: '',
          attempt: 1, completed_at: null, accepted_at: null, generation: 1,
          request_id: 'request-1', stage: 'running',
        },
        {
          id: 'reworking', prompt: '补充基准测试证据', reply: '', status: 'running',
          created_at: 2, updated_at: 2, review_status: 'none', review_note: '补充测试',
          attempt: 2, completed_at: null, accepted_at: null, generation: 2,
          request_id: 'request-1', stage: 'reworking',
        },
        {
          id: 'reviewing', prompt: '检查桌面启动流程', reply: 'done', status: 'stopped',
          created_at: 3, updated_at: 3, review_status: 'pending', review_note: '',
          attempt: 1, completed_at: 3, accepted_at: null, generation: 1,
          request_id: 'request-1', stage: 'reviewing',
        },
        {
          id: 'accepted', prompt: '验证历史会话加载速度', reply: 'done', status: 'stopped',
          created_at: 4, updated_at: 4, review_status: 'accepted', review_note: '',
          attempt: 1, completed_at: 4, accepted_at: 4, generation: 1,
          request_id: 'request-1', stage: 'accepted',
        },
      ],
    })

    renderPage()
    for (let attempt = 0; attempt < 10; attempt += 1) await flushQueries()

    const text = host.textContent || ''
    expect(text).toContain('分析项目性能并给出可以落地的优化方案')
    expect(text).toContain('扫描主要性能瓶颈')
    expect(text).toContain('返工中')
    expect(text).toContain('待你验收')
    expect(text).toContain('已通过')
    expect(text).toContain('1 个待验收')
    expect(text).not.toContain('T1')
    expect(text).not.toContain('Reply (')
    expect(mocks.conductorLog).not.toHaveBeenCalled()

    const headings = Array.from(host.querySelectorAll('h2')).map((item) => item.textContent)
    expect(headings).toContain('当前任务')
    expect(host.querySelectorAll('.conductor-worker-card')).toHaveLength(4)
    expect(headings).toContain('工人卷宗')
    // The metric grid is the single source of the task's live numbers; the
    // accepted count surfaces there rather than in a duplicate status line.
    const metrics = host.querySelector('[aria-label="当前任务概览"]')
    expect(metrics?.textContent).toContain('1 已通过')
    const titleBadge = host.querySelector('header .ga-badge')
    expect(titleBadge?.textContent).toBe('运行中')
    expect(titleBadge?.classList.contains('ga-badge-connected')).toBe(true)
    expect(metrics?.textContent).not.toContain('编排服务在线')
  })

  it('keeps subagent controls out of the title bar and defaults the dialog to following the main model', async () => {
    renderPage()
    await flushQueries()

    expect(button('子代理设置').getAttribute('aria-haspopup')).toBe('dialog')
    expect(host.textContent).not.toContain('默认模型')
    expect(host.textContent).not.toContain('固定使用所选模型')

    const trigger = button('子代理设置')
    act(() => trigger.click())

    const dialog = host.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-modal')).toBe('true')
    const select = dialog?.querySelector('[aria-label="子代理默认模型"]') as HTMLSelectElement
    const lock = dialog?.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(select.value).toBe('')
    expect(select.textContent).toContain('跟随主模型')
    expect(lock.disabled).toBe(true)
  })

  it('applies subagent settings only when saved', async () => {
    renderPage()
    await flushQueries()

    act(() => button('子代理设置').click())
    const dialog = host.querySelector('[role="dialog"]')!
    const select = dialog.querySelector('[aria-label="子代理默认模型"]') as HTMLSelectElement
    act(() => {
      select.value = 'worker'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const lock = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(lock.disabled).toBe(false)
    act(() => lock.click())
    act(() => button('取消').click())
    runAnimationFrames()
    expect(mocks.selectSubagentLlm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('子代理设置'))

    act(() => button('子代理设置').click())
    const reopened = host.querySelector('[role="dialog"]')!
    const reopenedSelect = reopened.querySelector('[aria-label="子代理默认模型"]') as HTMLSelectElement
    act(() => {
      reopenedSelect.value = 'worker'
      reopenedSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const reopenedLock = reopened.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => reopenedLock.click())
    act(() => button('保存').click())

    expect(mocks.selectSubagentLlm).toHaveBeenCalledWith('worker')
    expect(localStorage.getItem('gahub.conductor.subagentModelLocked.v1')).toBe('true')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes subagent settings with Escape without saving', async () => {
    renderPage()
    await flushQueries()
    act(() => button('子代理设置').click())
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    runAnimationFrames()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.selectSubagentLlm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('子代理设置'))
  })

  it('saves the auto-accept policy through the settings API', async () => {
    mocks.conductorSettings.mockResolvedValue({
      started: true,
      stopping: false,
      admission_open: true,
      loop_alive: true,
      agent_alive: true,
      subagents: { running: 0, stopped: 0 },
      chat_count: 1,
      auto_accept: false,
    })
    renderPage()
    await flushQueries()

    act(() => button('子代理设置').click())
    let dialog = host.querySelector('[role="dialog"]')!
    const autoAccept = dialog.querySelector('[aria-label="质检通过自动验收"]') as HTMLInputElement
    expect(autoAccept.checked).toBe(true)

    act(() => autoAccept.click())
    act(() => button('保存').click())
    await flushQueries()

    expect(mocks.conductorSettings).toHaveBeenCalledWith(false)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('leaves the auto-accept policy untouched when the value did not change', async () => {
    renderPage()
    await flushQueries()

    act(() => button('子代理设置').click())
    act(() => button('保存').click())
    await flushQueries()

    expect(mocks.conductorSettings).not.toHaveBeenCalled()
  })

  function typeMessage(text: string) {
    const textarea = host.querySelector('form textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value',
    )!.set!
    act(() => {
      setter.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  function lastToast(): { kind: string; message: string } | undefined {
    const items = useToastStore.getState().items
    return items.at(-1)
  }

  function setSubagentFixtures() {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'awaiting_review',
        stage: 'awaiting_review',
        subagents: { reviewing: { generation: 1, state: 'pending' } },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [{
        id: 'reviewing', prompt: '检查桌面启动流程', reply: 'done', status: 'stopped',
        created_at: 3, updated_at: 3, review_status: 'pending', review_note: '',
        attempt: 1, completed_at: 3, accepted_at: null, generation: 1,
        request_id: 'request-1', stage: 'reviewing',
      }],
    })
  }

  it('offers accept, rework and abort controls for a completed worker', async () => {
    setSubagentFixtures()
    mocks.conductorSubagentAction.mockResolvedValue({ id: 'reviewing', status: 'stopped' })
    renderPage()
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()

    act(() => button('通过').click())
    await flushQueries()
    expect(mocks.conductorSubagentAction).toHaveBeenCalledWith(
      'reviewing', 'accept', '', null, {}, false, undefined,
    )
    expect(lastToast()?.kind).toBe('success')
  })

  it('shows the worker reply, deliverables and a full-result dialog', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'awaiting_review',
        stage: 'awaiting_review',
        subagents: { reviewing: { generation: 1, state: 'pending' } },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [{
        id: 'reviewing',
        prompt: '检查桌面启动流程',
        reply: '启动路径已核对，结果写入 report.md',
        status: 'stopped',
        created_at: 3, updated_at: 3, review_status: 'pending', review_note: '',
        attempt: 1, completed_at: 3, accepted_at: null, generation: 1,
        request_id: 'request-1', stage: 'reviewing',
        done_marker: true,
        deliverables_missing: [],
        deliverables_stale: [],
        manifest: {
          goal: '核对桌面启动路径',
          deliverables: [{ path: 'D:/out/report.md', desc: '终稿' }],
        },
        quality_checks: { checks_ok: true, checks: [] },
      }],
    })
    mocks.conductorSubagent.mockResolvedValue({
      id: 'reviewing',
      prompt: '检查桌面启动流程',
      reply: '完整回复：启动路径已核对。',
      status: 'stopped',
      created_at: 3, updated_at: 3, review_status: 'pending',
      review_note: '', attempt: 1, generation: 1, request_id: 'request-1',
      manifest: {
        goal: '核对桌面启动路径',
        deliverables: [{ path: 'D:/out/report.md', desc: '终稿' }],
      },
    })
    renderPage()
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()

    const text = host.textContent || ''
    expect(text).toContain('核对桌面启动路径')
    expect(text).toContain('report.md')
    expect(text).toContain('1 个待验收')
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()
    expect(mocks.conductorSubagent).toHaveBeenCalledWith('reviewing', 20_000)
    expect(host.textContent).toContain('完整回复：启动路径已核对。')
    expect(host.textContent).toContain('工人卷宗')
  })

  it('surfaces verification evidence and offers a force accept on unverified 409', async () => {
    setSubagentFixtures()
    mocks.conductorSubagentAction.mockRejectedValueOnce(
      Object.assign(new Error('completion_unverified'), {
        status: 409,
        body: { detail: {
          error: 'completion_unverified',
          checks_ok: false,
          deliverables_missing: [],
          deliverables_stale: ['D:/out/report.md'],
          quality_checks: { checks_ok: false, checks: [
            { kind: 'file_contains', path: 'D:/out/report.md', passed: false,
              status: 'failed', severity: 'blocking', detail: 'content did not match' },
          ] },
        } },
      }),
    )
    renderPage()
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()

    act(() => button('通过').click())
    await flushQueries()

    const evidence = host.querySelector('[data-testid="subagent-evidence-reviewing"]')
    expect(evidence?.textContent).toContain('机器验收未通过')
    expect(evidence?.textContent).toContain('交付物未更新：D:/out/report.md')
    expect(evidence?.textContent).toContain('content did not match')
    expect(lastToast()?.kind).toBe('error')

    act(() => button('强制通过（人工核对后）').click())
    await flushQueries()
    expect(mocks.conductorSubagentAction).toHaveBeenLastCalledWith(
      'reviewing', 'accept', '人工核对证据后强制通过', null, {}, true, undefined,
    )
    expect(host.querySelector('[data-testid="subagent-evidence-reviewing"]')).toBeNull()
  })

  it('requires a reason before a rework can be submitted', async () => {
    setSubagentFixtures()
    mocks.conductorSubagentAction.mockResolvedValue({ id: 'reviewing', status: 'running' })
    renderPage()
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()

    act(() => button('打回返工').click())
    const textarea = host.querySelector('[aria-label="打回原因"]') as HTMLTextAreaElement
    const confirm = button('确认打回') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)

    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype, 'value',
    )!.set!
    act(() => {
      setter.call(textarea, '补充失败场景的回归证据')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect((host.querySelector('[aria-label="打回原因"]') as HTMLTextAreaElement).value)
      .toBe('补充失败场景的回归证据')
    act(() => button('确认打回').click())
    await flushQueries()

    expect(mocks.conductorSubagentAction).toHaveBeenLastCalledWith(
      'reviewing', 'rework', '补充失败场景的回归证据', null, {}, false, undefined,
    )
    expect(host.querySelector('[aria-label="打回原因"]')).toBeNull()
  })

  it('keeps the current-round chat and hides messages from other requests', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'supervising',
        stage: 'supervising',
        subagents: { live: { generation: 1, state: 'running' } },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorChat.mockResolvedValue({
      items: [
        { id: 'old', role: 'user', msg: '上一轮已经结束的任务', ts: 1, request_id: 'request-0' },
        { id: 'now', role: 'user', msg: '分析项目性能并给出可以落地的优化方案', ts: 2, request_id: 'request-1' },
        { id: 'reply', role: 'conductor', msg: '已经开始分派', ts: 3, request_id: 'request-1' },
      ],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [{
        id: 'live', prompt: '扫描主要性能瓶颈', reply: '', status: 'running',
        created_at: 1, updated_at: 1, review_status: 'none', review_note: '',
        attempt: 1, completed_at: null, accepted_at: null, generation: 1,
        request_id: 'request-1', stage: 'running',
      }],
    })
    renderPage()
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()
    expect(host.textContent).toContain('分析项目性能并给出可以落地的优化方案')
    expect(host.textContent).toContain('已经开始分派')
    expect(host.textContent).not.toContain('上一轮已经结束的任务')
  })

  it('offers only abort for a live worker', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'supervising',
        stage: 'supervising',
        subagents: { live: { generation: 1, state: 'running' } },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [{
        id: 'live', prompt: '扫描主要性能瓶颈', reply: '', status: 'running',
        created_at: 1, updated_at: 1, review_status: 'none', review_note: '',
        attempt: 1, completed_at: null, accepted_at: null, generation: 1,
        request_id: 'request-1', stage: 'running',
      }],
    })
    mocks.conductorSubagentAction.mockResolvedValue({ id: 'live', status: 'stopped' })
    renderPage()
    for (let attempt = 0; attempt < 6; attempt += 1) await flushQueries()

    expect(() => button('通过')).toThrow()
    expect(() => button('打回返工')).toThrow()
    act(() => button('终止').click())
    await flushQueries()
    expect(mocks.conductorSubagentAction).toHaveBeenCalledWith(
      'live', 'abort', '', null, {}, false, undefined,
    )
  })

  it('disables resend while a task is in flight and preserves text typed during the send', async () => {
    let resolveSend!: (item: { id: string; role: string; msg: string; ts: number }) => void
    mocks.conductorSendChat.mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve }),
    )
    renderPage()
    // The composer needs the llms query + model selection to have resolved;
    // under parallel-suite load one flushQueries() can lose that race.
    await waitFor(() => expect(host.querySelector('form textarea')).toBeTruthy())

    typeMessage('分析这个任务')
    act(() => button('发送').click())
    await waitFor(() => {
      // Double-submit guard: the in-flight request keeps the button busy.
      expect(button('发送中').disabled).toBe(true)
      expect(mocks.conductorSendChat).toHaveBeenCalledTimes(1)
    })

    // Whatever the user types while the request is in flight survives.
    typeMessage('补充：还包括启动流程')
    await act(async () => {
      resolveSend({ id: 'u1', role: 'user', msg: '分析这个任务', ts: 1 })
    })
    await waitFor(() => expect(button('发送').disabled).toBe(false))
    runAnimationFrames()

    expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
      .toBe('补充：还包括启动流程')
    expect(useToastStore.getState().items).toHaveLength(0)
  })

  it('sends a follow-up to the open workflow instead of forking a new task', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'supervising',
        stage: 'supervising',
        subagents: { live: { generation: 1, state: 'running' } },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSendChat.mockResolvedValue({
      id: 'u1', role: 'user', msg: '补充：还要覆盖登录场景', ts: 1, request_id: 'request-1',
    })
    renderPage()
    await waitFor(() => expect(host.querySelector('form textarea')).toBeTruthy())
    await waitFor(() => expect(button('发送补充')).toBeTruthy())

    typeMessage('补充：还要覆盖登录场景')
    act(() => button('发送补充').click())
    await waitFor(() => expect(mocks.conductorSendChat).toHaveBeenCalledTimes(1))
    expect(mocks.conductorSendChat).toHaveBeenCalledWith(
      '补充：还要覆盖登录场景', 'user', expect.anything(), 'request-1',
    )
  })

  it('offers an explicit new-task submit that omits the request id', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'supervising',
        stage: 'supervising',
        subagents: { live: { generation: 1, state: 'running' } },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSendChat.mockResolvedValue({
      id: 'u2', role: 'user', msg: '另起一个独立任务', ts: 2,
    })
    renderPage()
    await waitFor(() => expect(host.querySelector('form textarea')).toBeTruthy())
    await waitFor(() => expect(host.textContent).toContain('新任务'))

    typeMessage('另起一个独立任务')
    act(() => button('新任务').click())
    await waitFor(() => expect(mocks.conductorSendChat).toHaveBeenCalledTimes(1))
    expect(mocks.conductorSendChat).toHaveBeenCalledWith(
      '另起一个独立任务', 'user', expect.anything(), undefined,
    )
  })

  it('falls back to fresh-task wording when the viewed workflow is closed', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'completed',
        stage: 'completed',
        subagents: {},
        created_at: 1,
        completed_at: 2,
      }],
    })
    renderPage()
    await waitFor(() => expect(host.querySelector('form textarea')).toBeTruthy())
    await waitFor(() => expect(
      (host.querySelector('form textarea') as HTMLTextAreaElement).placeholder,
    ).toBe('描述一个新任务…'))
    expect(button('发送')).toBeTruthy()
  })

  it('restores the draft and warns instead of silently dropping a failed task', async () => {
    mocks.conductorSendChat.mockRejectedValueOnce(new Error('boom'))
    renderPage()
    await waitFor(() => expect(host.querySelector('form textarea')).toBeTruthy())

    typeMessage('分析这个任务')
    act(() => button('发送').click())
    await waitFor(() => {
      expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
        .toBe('分析这个任务')
      expect(lastToast()?.kind).toBe('error')
      expect(lastToast()?.message)
        .toBe('任务发送失败，内容已恢复，请检查 Conductor 状态后重试。')
    })

    // Timeouts carry a distinct warning: the task may already be admitted,
    // so an immediate resend would duplicate it.
    const timeout: Error & { name: string } = Object.assign(new Error('timeout'), { name: 'HttpTimeoutError' })
    mocks.conductorSendChat.mockRejectedValueOnce(timeout)
    typeMessage('重试任务')
    act(() => button('发送').click())
    await waitFor(() => {
      expect(lastToast()?.message)
        .toBe('任务请求超时。任务可能仍在启动或已被受理，请勿立即重复发送。')
      expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
        .toBe('重试任务')
    })
  })

  it('reports when the conductor could not be stopped instead of faking success', async () => {
    mocks.conductorStop.mockResolvedValueOnce({ ok: false })
    renderPage()
    // 停止 renders only after the status query reports started; one
    // flushQueries() raced that under load (button not found: 停止).
    await waitFor(() => expect(button('停止').disabled).toBe(false))

    act(() => button('停止').click())
    await waitFor(() => expect(lastToast()?.message).toBe('Conductor 未能停止，请检查引擎状态。'))
    expect(lastToast()?.kind).toBe('error')
    expect(button('停止').disabled).toBe(false)

    mocks.conductorStop.mockRejectedValueOnce(new Error('engine down'))
    act(() => button('停止').click())
    await waitFor(() => expect(lastToast()?.message).toBe('停止 Conductor 失败，请稍后重试。'))
  })

  function failedWorkflowFixture(terminalEvent: string | null) {
    return {
      request_id: 'request-1',
      status: 'failed',
      stage: terminalEvent ? 'failed' : 'recoverable_failure',
      terminal_event: terminalEvent,
      subagents: { worker: { generation: 1, state: 'failed' } },
      created_at: 1,
      completed_at: terminalEvent ? 2 : null,
    }
  }

  it('keeps finished tasks reachable: the board can pin a previous workflow', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [
        {
          request_id: 'request-old',
          status: 'completed',
          stage: 'completed',
          subagents: { old: { generation: 1, state: 'accepted' } },
          created_at: 1,
          completed_at: 2,
        },
        {
          request_id: 'request-new',
          status: 'supervising',
          stage: 'supervising',
          subagents: { new: { generation: 1, state: 'running' } },
          created_at: 3,
          completed_at: null,
        },
      ],
    })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })
    mocks.conductorChat.mockResolvedValue({
      items: [
        { id: 'c1', role: 'user', msg: '旧任务：整理归档', ts: 1, request_id: 'request-old' },
        { id: 'c2', role: 'user', msg: '新任务：画一个 pelican', ts: 3, request_id: 'request-new' },
      ],
    })
    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => expect(host.textContent).toContain('新任务：画一个 pelican'))

    // The new open task auto-follows; the finished one stays reachable.
    expect(host.textContent).toContain('旧任务：整理归档')
    const pinOld = host.querySelector(
      'button[aria-label="切换到任务：旧任务：整理归档"]',
    ) as HTMLButtonElement
    expect(pinOld).toBeTruthy()
    act(() => pinOld.click())
    await waitFor(() => expect(host.textContent).toContain('旧任务：整理归档'))
    // Pinned view: the board header follows the pinned workflow only
    // (the history nav legitimately still lists the new task).
    const board = host.querySelector('section[aria-label="当前任务"]')
    expect(board?.textContent).toContain('旧任务：整理归档')
    expect(board?.textContent).not.toContain('新任务')

    // 回到最新 releases the pin and follows the newest workflow again.
    expect(button('回到最新').title).toBe('回到最新任务')
    act(() => button('回到最新').click())
    await waitFor(() => {
      const latest = host.querySelector('section[aria-label="当前任务"]')
      expect(latest?.textContent).toContain('新任务：画一个 pelican')
    })
  })

  it('presents a recoverable worker failure as open, not as a closed workflow', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [failedWorkflowFixture(null)],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [{
        id: 'worker', prompt: '生成验收报告', reply: '', status: 'stopped',
        created_at: 1, updated_at: 1, review_status: 'none', review_note: '',
        attempt: 1, completed_at: 1, accepted_at: null, generation: 1,
        request_id: 'request-1', stage: 'stopped',
      }],
    })

    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => {
      const text = host.textContent || ''
      expect(text).toContain('子代理失败')
      expect(text).toContain('返工或补派')
      expect(text).not.toContain('执行失败')
    })
  })

  it('keeps the terminal failure wording once the workflow is closed', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [failedWorkflowFixture('workflow_failed')],
    })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })

    renderPage()
    await waitFor(() => {
      const text = host.textContent || ''
      expect(text).toContain('执行失败')
      expect(text).not.toContain('子代理失败')
    })
  })

  it('shows the persisted failure reason on a closed workflow', async () => {
    const failed = { ...failedWorkflowFixture('workflow_failed'), error: 'conductor start failed: gahub_app unavailable' }
    mocks.conductorWorkflows.mockResolvedValue({ items: [failed] })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })

    renderPage()
    await waitFor(() => {
      const text = host.textContent || ''
      expect(text).toContain('执行失败')
      expect(text).toContain('conductor start failed: gahub_app unavailable')
      expect(text).not.toContain('原因已写入本轮对话')
    })
  })

  it('offers a one-click retry that prefills the composer with the failed task', async () => {
    mocks.conductorWorkflows.mockResolvedValue({ items: [failedWorkflowFixture('workflow_failed')] })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })
    mocks.conductorChat.mockResolvedValue({
      items: [{ id: 'u1', role: 'user', msg: '整理归档目录并生成索引', ts: 1, request_id: 'request-1' }],
    })

    renderPage()
    await waitFor(() => expect(host.textContent).toContain('重新发起这个任务'))

    act(() => button('重新发起这个任务').click())
    expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
      .toBe('整理归档目录并生成索引')
  })

  it('opens a usable composer from an empty task board', async () => {
    mocks.conductorChat.mockResolvedValue({ items: [] })
    mocks.conductorWorkflows.mockResolvedValue({ items: [] })
    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => expect(host.textContent).toContain('暂无任务'))
    act(() => button('对话').click())
    expect(host.querySelector('.conductor-layout')?.getAttribute('data-mobile-view')).toBe('context')
    expect(host.querySelector('#conductor-panel-chat')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('textarea[aria-label="任务内容"]')).toBeTruthy()
    expect(button('发送').disabled).toBe(true)
  })

  it('renders captured lifecycle events in the activity timeline', async () => {
    setSubagentFixtures()
    act(() => {
      useConductorStore.getState().addWorkerActivity({
        id: 'ev:1', name: 'spawned', request_id: 'request-1',
        at: 1_700_000_000, text: '子代理已派出', worker_id: 'reviewing',
      })
      useConductorStore.getState().addWorkflowActivity({
        request_id: 'request-1', kind: 'workflow_completed', at: 1_700_000_060, text: '任务完成',
      })
    })

    renderPage()
    await waitFor(() => {
      const timeline = host.querySelector('section[aria-label="任务动态"]')
      expect(timeline?.textContent).toContain('子代理已派出')
      expect(timeline?.textContent).toContain('任务完成')
    })
  })

  it('exposes deliverable reveal actions and the previous review note', async () => {
    setSubagentFixtures()
    mocks.conductorSubagent.mockResolvedValue({
      id: 'reviewing', prompt: '检查桌面启动流程', reply: 'done',
      status: 'stopped', created_at: 3, updated_at: 3, review_status: 'pending',
      review_note: '上一轮意见：路径指向旧文件', attempt: 1, generation: 1,
      request_id: 'request-1',
      manifest: {
        goal: '核对桌面启动路径',
        deliverables: [{ path: 'D:/out/report.md', desc: '终稿' }],
      },
    })
    mocks.revealFile.mockResolvedValue({ ok: true })

    renderPage()
    await waitFor(() => expect(host.textContent).toContain('上一轮意见：路径指向旧文件'))

    act(() => button('打开').click())
    expect(mocks.revealFile).toHaveBeenCalledWith('D:/out/report.md', 'open')
    act(() => button('所在位置').click())
    expect(mocks.revealFile).toHaveBeenCalledWith('D:/out/report.md', 'folder')
  })

  it('opens the dossier straight from the worker card without a redundant button', async () => {
    setSubagentFixtures()
    renderPage()
    await waitFor(() => expect(host.querySelector('.conductor-worker-toggle')).toBeTruthy())
    const worker = host.querySelector('.conductor-worker-toggle') as HTMLButtonElement
    expect(host.querySelector('#conductor-panel-delivery')?.hasAttribute('hidden')).toBe(true)
    act(() => worker.click())
    // One click is "open this worker": the card expands inline, the dossier
    // follows, and the delivery tab comes forward — no second button, and
    // collapsing must not disturb the right panel.
    expect(host.querySelector('.conductor-worker-process')).toBeTruthy()
    expect(host.querySelector('#conductor-panel-delivery')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('#conductor-panel-chat')?.hasAttribute('hidden')).toBe(true)
    expect(host.querySelector('.conductor-layout')?.getAttribute('data-mobile-view')).toBe('context')
    expect(worker.getAttribute('aria-pressed')).toBe('true')
    expect(host.textContent).not.toContain('打开完整卷宗')
    act(() => button('动态').click())
    expect(host.querySelector('#conductor-panel-activity')?.hasAttribute('hidden')).toBe(false)
    expect(host.querySelector('#conductor-panel-delivery')?.hasAttribute('hidden')).toBe(true)
    act(() => button('当前任务').click())
    expect(host.querySelector('.conductor-layout')?.getAttribute('data-mobile-view')).toBe('board')
    expect(worker.getAttribute('aria-pressed')).toBe('true')
    act(() => worker.click())
    expect(host.querySelector('.conductor-worker-process')).toBe(null)
    expect(host.querySelector('#conductor-panel-delivery')?.hasAttribute('hidden')).toBe(true)
  })

  it('filters and searches task cards and preserves the original task title', async () => {
    mocks.conductorWorkflows.mockResolvedValue({ items: [
      { request_id: 'old', stage: 'completed', status: 'completed', subagents: {}, created_at: 1 },
      { request_id: 'new', stage: 'awaiting_review', status: 'awaiting_review', subagents: {}, created_at: 2 },
    ] })
    mocks.conductorChat.mockResolvedValue({ items: [
      { id: 'u1', role: 'user', msg: '归档资料', request_id: 'old', ts: 1 },
      { id: 'u2', role: 'user', msg: '核对接口', request_id: 'new', ts: 2 },
      { id: 'u3', role: 'user', msg: '补充性能测试', request_id: 'new', ts: 3 },
    ] })
    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => expect(host.querySelectorAll('.conductor-history-row')).toHaveLength(2))
    const tabs = Array.from(host.querySelectorAll('[aria-label="任务状态"] button')) as HTMLButtonElement[]
    act(() => tabs[2].click())
    expect(host.querySelectorAll('.conductor-history-row')).toHaveLength(1)
    expect(host.querySelector('.conductor-history-title')?.textContent).toBe('核对接口')
    act(() => tabs[3].click())
    expect(host.querySelector('.conductor-history-title')?.textContent).toBe('归档资料')
    act(() => tabs[0].click())
    const search = host.querySelector('input[aria-label="搜索任务"]') as HTMLInputElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(search, '归档')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.querySelectorAll('.conductor-history-row')).toHaveLength(1)
    expect(host.querySelector('.conductor-history-title')?.textContent).toBe('归档资料')
  })

  it('expands the history bar, deletes a finished task and keeps it deleted', async () => {
    mocks.conductorWorkflows.mockResolvedValue({ items: [
      { request_id: 'old', stage: 'completed', status: 'completed', subagents: {}, created_at: 1 },
    ] })
    mocks.conductorChat.mockResolvedValue({ items: [
      { id: 'u1', role: 'user', msg: '归档资料', request_id: 'old', ts: 1 },
    ] })
    mocks.conductorDeleteWorkflow.mockResolvedValue({ ok: true, request_id: 'old' })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })
    mocks.conductorStatus.mockResolvedValue({ ready: true, started: true })
    mocks.dialogConfirm.mockResolvedValue(true)

    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => expect(host.querySelectorAll('.conductor-history-row')).toHaveLength(1))

    const del = host.querySelector('button[aria-label="删除任务：归档资料"]') as HTMLButtonElement
    expect(del).toBeTruthy()
    act(() => del.click())
    await waitFor(() => expect(mocks.conductorDeleteWorkflow).toHaveBeenCalledWith('old'))
    await waitFor(() => expect(useToastStore.getState().items.some((toast) => toast.kind === 'success')).toBe(true))
    expect(mocks.dialogConfirm).toHaveBeenCalled()
  })

  it('allows deletion of a cancelled task', async () => {
    mocks.conductorWorkflows.mockResolvedValue({ items: [{
      request_id: 'cancelled', status: 'cancelled', stage: 'failed',
      terminal_event: 'workflow_cancelled', subagents: {}, created_at: 1, completed_at: 2,
    }] })
    mocks.conductorChat.mockResolvedValue({ items: [
      { id: 'u1', role: 'user', msg: '中断的资料整理', request_id: 'cancelled', ts: 1 },
    ] })
    mocks.conductorDeleteWorkflow.mockResolvedValue({ ok: true, request_id: 'cancelled' })
    mocks.dialogConfirm.mockResolvedValue(true)

    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => expect(host.querySelector('button[aria-label="删除任务：中断的资料整理"]')).toBeTruthy())
    act(() => (host.querySelector('button[aria-label="删除任务：中断的资料整理"]') as HTMLButtonElement).click())
    await waitFor(() => expect(mocks.conductorDeleteWorkflow).toHaveBeenCalledWith('cancelled'))
  })

  it('offers delete for paused-session workflows once the conductor stops', async () => {
    mocks.conductorWorkflows.mockResolvedValue({ items: [
      { request_id: 'live', stage: 'supervising', status: 'running', subagents: {}, created_at: 2 },
    ] })
    mocks.conductorChat.mockResolvedValue({ items: [] })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })
    mocks.conductorStatus.mockResolvedValue({ ready: true, started: false })

    renderPage()
    await waitFor(() => expect(host.querySelector('[aria-label="展开历史任务"]')).toBeTruthy())
    act(() => (host.querySelector('[aria-label="展开历史任务"]') as HTMLButtonElement).click())
    await waitFor(() => expect(
      host.querySelector('button[aria-label="删除任务：未命名任务"]'),
    ).toBeTruthy())
  })

  it('moves worker selection with j/k and accepts the selected worker with a', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'awaiting_review',
        stage: 'awaiting_review',
        subagents: {
          reviewing: { generation: 1, state: 'pending' },
          accepted: { generation: 1, state: 'accepted' },
        },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [
        {
          id: 'reviewing', prompt: '检查桌面启动流程', reply: 'done', status: 'stopped',
          created_at: 3, updated_at: 3, review_status: 'pending', review_note: '',
          attempt: 1, completed_at: 3, accepted_at: null, generation: 1,
          request_id: 'request-1', stage: 'reviewing',
        },
        {
          id: 'accepted', prompt: '验证历史会话加载速度', reply: 'done', status: 'stopped',
          created_at: 4, updated_at: 4, review_status: 'accepted', review_note: '',
          attempt: 1, completed_at: 4, accepted_at: 4, generation: 1,
          request_id: 'request-1', stage: 'accepted',
        },
      ],
    })
    mocks.conductorSubagentAction.mockResolvedValue({ id: 'reviewing', status: 'stopped' })

    renderPage()
    await waitFor(() => expect(host.textContent).toContain('工人卷宗'))
    const aside = () => {
      const element = host.querySelector('aside')
      if (!element) throw new Error('dossier aside not found')
      return element
    }
    // The reviewable worker is auto-selected on mount.
    expect(aside().textContent).toContain('检查桌面启动流程')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })))
    expect(aside().textContent).toContain('验证历史会话加载速度')
    expect(aside().textContent).not.toContain('检查桌面启动流程')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })))
    expect(aside().textContent).toContain('检查桌面启动流程')

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })))
    await flushQueries()
    expect(mocks.conductorSubagentAction).toHaveBeenCalledWith(
      'reviewing', 'accept', '', null, {}, false, undefined,
    )
  })

  it('renders the worker reply chat-style and anchors reached milestones inline', async () => {
    setSubagentFixtures()
    mocks.conductorSubagent.mockResolvedValue({
      id: 'reviewing',
      prompt: '整理归档目录',
      reply: '## 处理结果\n归档目录已建立，索引见下。\n【里程碑】归档已建立\n后续步骤已写入 plan.md。\n\n[DONE] <summary>归档完成</summary>',
      status: 'stopped', created_at: 3, updated_at: 3, review_status: 'pending',
      review_note: '', attempt: 1, generation: 1, request_id: 'request-1',
      plan_milestones: [
        {
          id: 'ms-file', desc: '索引文件生成', status: 'reached', reached_at: 1_700_000_050,
          check: { kind: 'file_exists', path: 'D:/out/plan.md' },
        },
        {
          id: 'ms-archive', desc: '归档目录建立', status: 'reached', reached_at: 1_700_000_100,
          check: { kind: 'archive_contains', contains: '【里程碑】归档已建立' },
        },
        {
          id: 'ms-pending', desc: '交叉验证抽检', status: 'pending',
          check: { kind: 'archive_contains', contains: '【里程碑】交叉验证完成' },
        },
      ],
    })

    renderPage()
    await waitFor(() => expect(host.textContent).toContain('进度里程碑'))

    const panel = host.querySelector('[aria-label="进度里程碑"]')
    expect(panel?.textContent).toContain('索引文件生成')
    expect(panel?.textContent).toContain('文件存在 · plan.md')
    expect(panel?.textContent).toContain('归档目录建立')
    expect(panel?.textContent).toContain('输出标记检查')
    expect(panel?.textContent).toContain('已达成')

    // The reached archive marker becomes an inline anchor chip in the reply…
    const anchor = host.querySelector('[data-testid="dossier-milestone-anchor"]')
    expect(anchor?.textContent).toContain('归档目录建立')
    // …and the raw marker line no longer leaks into the rendered output.
    expect(host.textContent).not.toContain('【里程碑】归档已建立')
    // The [DONE] protocol tail is stripped as well.
    expect(host.textContent).not.toContain('[DONE]')
    expect(host.textContent).toContain('后续步骤已写入 plan.md。')
  })

  it('advances selection to the next reviewable worker after a decision', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1',
        status: 'awaiting_review',
        stage: 'awaiting_review',
        subagents: {
          first: { generation: 1, state: 'pending' },
          second: { generation: 1, state: 'pending' },
        },
        created_at: 1,
        completed_at: null,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [
        {
          id: 'first', prompt: '第一个工人任务', reply: 'ok', status: 'stopped',
          created_at: 1, updated_at: 1, review_status: 'pending', review_note: '',
          attempt: 1, completed_at: 1, accepted_at: null, generation: 1,
          request_id: 'request-1', stage: 'reviewing',
        },
        {
          id: 'second', prompt: '第二个工人任务', reply: 'ok', status: 'stopped',
          created_at: 2, updated_at: 2, review_status: 'pending', review_note: '',
          attempt: 1, completed_at: 2, accepted_at: null, generation: 1,
          request_id: 'request-1', stage: 'reviewing',
        },
      ],
    })
    mocks.conductorSubagentAction.mockResolvedValue({ id: 'first', status: 'stopped' })

    renderPage()
    await waitFor(() => expect(host.textContent).toContain('工人卷宗'))
    expect((host.querySelector('aside') as HTMLElement).textContent).toContain('第一个工人任务')

    act(() => button('通过').click())
    await flushQueries()
    expect(mocks.conductorSubagentAction).toHaveBeenNthCalledWith(
      1, 'first', 'accept', '', null, {}, false, undefined,
    )

    // The dossier now shows the second worker without a manual click.
    expect((host.querySelector('aside') as HTMLElement).textContent).toContain('第二个工人任务')
    act(() => button('通过').click())
    await flushQueries()
    expect(mocks.conductorSubagentAction).toHaveBeenNthCalledWith(
      2, 'second', 'accept', '', null, {}, false, undefined,
    )
  })

  it('treats archived workers as read-only history without review prompts', async () => {
    // Engine cleared its pool (conductor restart); the archive carries the
    // workers of a finished task, one still marked pending from its last run.
    mocks.conductorWorkflows.mockResolvedValue({
      items: [{
        request_id: 'request-1', status: 'completed', stage: 'completed',
        subagents: {}, created_at: 1, completed_at: 2,
      }],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [
        {
          id: 'w1', prompt: '扫描目录结构', reply: '', status: 'stopped',
          created_at: 1, updated_at: 2, review_status: 'accepted', review_note: '',
          attempt: 1, completed_at: 2, accepted_at: 2, generation: 1,
          request_id: 'request-1', stage: 'accepted', archived: true,
          plan_milestones: [{ id: 'm1', desc: '建立索引', status: 'reached', reached_at: 2 }],
        },
        {
          id: 'w2', prompt: '生成检查清单', reply: '', status: 'stopped',
          created_at: 2, updated_at: 3, review_status: 'pending', review_note: '',
          attempt: 1, completed_at: 3, accepted_at: null, generation: 1,
          request_id: 'request-1', stage: 'reviewing', archived: true,
        },
      ],
    })

    renderPage()
    await waitFor(() => expect(host.querySelectorAll('.conductor-worker-card')).toHaveLength(2))

    // Archived rows never present themselves as review work.
    const text = host.textContent || ''
    expect(text).not.toContain('个待验收')
    expect(host.querySelectorAll('[data-archived="true"]')).toHaveLength(2)
    expect(host.querySelectorAll('.conductor-worker-archived-badge')).toHaveLength(2)
    // Truncated archive rows say so instead of claiming a live wait.
    expect(text).toContain('存档记录：执行文字结果未随快照保留')
    // The dossier reflects the last worker and stays read-only.
    const aside = host.querySelector('aside') as HTMLElement
    expect(aside.textContent).toContain('存档记录')
    expect(Array.from(aside.querySelectorAll('button')).map((b) => b.textContent))
      .not.toContain('通过')
    // The history row counts archived workers (1/2), not "尚未指派".
    act(() => button('展开历史任务').click())
    await flushQueries()
    expect(host.querySelector('.conductor-history-meta')?.textContent).toContain('1/2 子任务已通过')
  })
})
