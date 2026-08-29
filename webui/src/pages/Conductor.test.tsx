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
  conductorChat: vi.fn(),
  conductorLog: vi.fn(),
  conductorSendChat: vi.fn(),
  conductorStop: vi.fn(),
  conductorStart: vi.fn(),
  llms: vi.fn(),
  selectMainLlm: vi.fn(),
  selectSubagentLlm: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: {
    conductorStatus: mocks.conductorStatus,
    conductorSubagents: mocks.conductorSubagents,
    conductorWorkflows: mocks.conductorWorkflows,
    conductorChat: mocks.conductorChat,
    conductorLog: mocks.conductorLog,
    conductorSendChat: mocks.conductorSendChat,
    conductorStop: mocks.conductorStop,
    conductorStart: mocks.conductorStart,
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
    })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })
    mocks.conductorWorkflows.mockResolvedValue({ items: [] })
    mocks.conductorChat.mockResolvedValue({
      items: [{ id: 'result-1', role: 'conductor', msg: 'finished', ts: 1 }],
    })
    mocks.conductorLog.mockResolvedValue({ log: [] })
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
      (item) => item.textContent?.trim() === label,
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
          request_id: 'request-1',
        },
        {
          id: 'reworking', prompt: '补充基准测试证据', reply: '', status: 'running',
          created_at: 2, updated_at: 2, review_status: 'none', review_note: '补充测试',
          attempt: 2, completed_at: null, accepted_at: null, generation: 2,
          request_id: 'request-1',
        },
        {
          id: 'reviewing', prompt: '检查桌面启动流程', reply: 'done', status: 'stopped',
          created_at: 3, updated_at: 3, review_status: 'pending', review_note: '',
          attempt: 1, completed_at: 3, accepted_at: null, generation: 1,
          request_id: 'request-1',
        },
        {
          id: 'accepted', prompt: '验证历史会话加载速度', reply: 'done', status: 'stopped',
          created_at: 4, updated_at: 4, review_status: 'accepted', review_note: '',
          attempt: 1, completed_at: 4, accepted_at: 4, generation: 1,
          request_id: 'request-1',
        },
      ],
    })

    renderPage()
    for (let attempt = 0; attempt < 10; attempt += 1) await flushQueries()

    const text = host.textContent || ''
    expect(text).toContain('分析项目性能并给出可以落地的优化方案')
    expect(text).toContain('扫描主要性能瓶颈')
    expect(text).toContain('返工中')
    expect(text).toContain('正在验收')
    expect(text).toContain('已通过')
    expect(text).not.toContain('T1')
    expect(text).not.toContain('Reply (')
    expect(mocks.conductorLog).not.toHaveBeenCalled()

    const headings = Array.from(host.querySelectorAll('h2')).map((item) => item.textContent)
    expect(headings.indexOf('子代理状态')).toBeLessThan(headings.indexOf('任务进度'))
    expect(host.querySelector('[aria-label="子代理状态跟踪"]')?.textContent).toContain('1/4 已通过')
    const titleBadge = host.querySelector('header .ga-badge')
    expect(titleBadge?.textContent).toBe('运行中')
    expect(titleBadge?.classList.contains('ga-badge-connected')).toBe(true)
    expect(host.querySelector('[aria-label="子代理状态跟踪"]')?.textContent).not.toContain('编排服务在线')
  })

  it('keeps subagent controls out of the title bar and defaults the dialog to following the main model', async () => {
    renderPage()
    await flushQueries()

    expect(host.textContent).toContain('子代理设置')
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

  it('disables resend while a task is in flight and preserves text typed during the send', async () => {
    let resolveSend!: (item: { id: string; role: string; msg: string; ts: number }) => void
    mocks.conductorSendChat.mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve }),
    )
    renderPage()
    await flushQueries()

    typeMessage('分析这个任务')
    act(() => button('发送').click())
    await flushQueries()

    // Double-submit guard: the in-flight request keeps the button busy.
    const pending = button('发送中…')
    expect(pending.disabled).toBe(true)
    expect(mocks.conductorSendChat).toHaveBeenCalledTimes(1)

    // Whatever the user types while the request is in flight survives.
    typeMessage('补充：还包括启动流程')
    await act(async () => {
      resolveSend({ id: 'u1', role: 'user', msg: '分析这个任务', ts: 1 })
    })
    await flushQueries()
    runAnimationFrames()

    expect(button('发送').disabled).toBe(false)
    expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
      .toBe('补充：还包括启动流程')
    expect(useToastStore.getState().items).toHaveLength(0)
  })

  it('restores the draft and warns instead of silently dropping a failed task', async () => {
    mocks.conductorSendChat.mockRejectedValueOnce(new Error('boom'))
    renderPage()
    await flushQueries()

    typeMessage('分析这个任务')
    act(() => button('发送').click())
    await flushQueries()

    expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
      .toBe('分析这个任务')
    expect(lastToast()?.kind).toBe('error')
    expect(lastToast()?.message)
      .toBe('任务发送失败，内容已恢复，请检查 Conductor 状态后重试。')

    // Timeouts carry a distinct warning: the task may already be admitted,
    // so an immediate resend would duplicate it.
    const timeout: Error & { name: string } = Object.assign(new Error('timeout'), { name: 'HttpTimeoutError' })
    mocks.conductorSendChat.mockRejectedValueOnce(timeout)
    typeMessage('重试任务')
    act(() => button('发送').click())
    await flushQueries()

    expect(lastToast()?.message)
      .toBe('任务请求超时。任务可能仍在启动或已被受理，请勿立即重复发送。')
    expect((host.querySelector('form textarea') as HTMLTextAreaElement).value)
      .toBe('重试任务')
  })

  it('reports when the conductor could not be stopped instead of faking success', async () => {
    mocks.conductorStop.mockResolvedValueOnce({ ok: false })
    renderPage()
    await flushQueries()

    act(() => button('停止').click())
    await flushQueries()

    expect(lastToast()?.kind).toBe('error')
    expect(lastToast()?.message).toBe('Conductor 未能停止，请检查引擎状态。')
    expect(button('停止').disabled).toBe(false)

    mocks.conductorStop.mockRejectedValueOnce(new Error('engine down'))
    act(() => button('停止').click())
    await flushQueries()

    expect(lastToast()?.message).toBe('停止 Conductor 失败，请稍后重试。')
  })

  function failedWorkflowFixture(terminalEvent: string | null) {
    return {
      request_id: 'request-1',
      status: 'failed',
      terminal_event: terminalEvent,
      subagents: { worker: { generation: 1, state: 'failed' } },
      created_at: 1,
      completed_at: terminalEvent ? 2 : null,
    }
  }

  it('presents a recoverable worker failure as open, not as a closed workflow', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [failedWorkflowFixture(null)],
    })
    mocks.conductorSubagents.mockResolvedValue({
      items: [{
        id: 'worker', prompt: '生成验收报告', reply: '', status: 'stopped',
        created_at: 1, updated_at: 1, review_status: 'none', review_note: '',
        attempt: 1, completed_at: 1, accepted_at: null, generation: 1,
        request_id: 'request-1',
      }],
    })

    renderPage()
    await flushQueries()

    const text = host.textContent || ''
    expect(text).toContain('子代理失败')
    expect(text).toContain('返工或补派')
    expect(text).not.toContain('执行失败')
  })

  it('keeps the terminal failure wording once the workflow is closed', async () => {
    mocks.conductorWorkflows.mockResolvedValue({
      items: [failedWorkflowFixture('workflow_failed')],
    })
    mocks.conductorSubagents.mockResolvedValue({ items: [] })

    renderPage()
    await flushQueries()

    const text = host.textContent || ''
    expect(text).toContain('执行失败')
    expect(text).not.toContain('子代理失败')
  })
})
