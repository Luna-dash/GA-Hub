// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConductorStore } from '@/stores/conductorStore'
import Conductor from './Conductor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  conductorStatus: vi.fn(),
  conductorSubagents: vi.fn(),
  conductorWorkflows: vi.fn(),
  conductorChat: vi.fn(),
  conductorLog: vi.fn(),
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
    vi.clearAllMocks()
    localStorage.clear()
    useConductorStore.getState().clear()
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
})
