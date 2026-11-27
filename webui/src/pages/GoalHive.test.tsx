// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftStore } from '@/stores/draftStore'
import { useGoalHiveStore } from '@/stores/goalhiveStore'
import { dialog } from '@/stores/dialogStore'
import { useToastStore } from '@/stores/toastStore'
import GoalHive from './GoalHive'
import { resetPageState } from '@/utils/pageState'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  llms: vi.fn(),
  selectMainLlm: vi.fn(),
  selectSubagentLlm: vi.fn(),
  socketOpen: vi.fn(),
  socketClose: vi.fn(),
  socketSend: vi.fn((_command: unknown) => true),
}))

vi.mock('@/api/client', () => ({
  api: { llms: mocks.llms },
}))

vi.mock('@/components/PageShell', () => ({
  PageShell: ({ title, titleExtra, actions, children }: {
    title: string
    titleExtra?: ReactNode
    actions?: ReactNode
    children: ReactNode
  }) => (
    <div>
      <header data-testid="page-header">{title}{titleExtra}{actions}</header>
      <main>{children}</main>
    </div>
  ),
}))

vi.mock('@/components/ModelSelect', () => ({
  MainModelSelect: ({ value, onChange, className }: { value?: string; onChange: (value: string) => void; className?: string }) => (
    <select className={className} aria-label="Goal / Hive 主模型" value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
      <option value="main">主模型</option>
    </select>
  ),
  SubagentModelSelect: ({ value, onChange, autoFocus }: {
    value: string | null
    onChange: (value: string | null) => void
    autoFocus?: boolean
  }) => (
    <select
      aria-label="Hive 子代理默认模型"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      autoFocus={autoFocus}
    >
      <option value="">跟随主模型</option>
      <option value="worker">子代理模型</option>
    </select>
  ),
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

vi.mock('@/runtime/goalHiveSocket', () => ({
  GoalHiveSocket: class {
    onState: (state: 'connecting' | 'open' | 'closed') => void = () => undefined
    onMessages: (messages: unknown[]) => void = () => undefined

    open() {
      mocks.socketOpen()
      this.onState('open')
    }

    close() {
      mocks.socketClose()
    }

    send(command: unknown) {
      return mocks.socketSend(command)
    }
  },
}))

describe('Goal Hive compact subagent settings', () => {
  let host: HTMLDivElement
  let root: Root
  let queryClient: QueryClient
  let animationFrames: FrameRequestCallback[]

  beforeEach(() => {
    resetPageState()
    vi.clearAllMocks()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    mocks.llms.mockResolvedValue({ llms: [] })
    useDraftStore.setState({ texts: {}, attachments: {} })
    useGoalHiveStore.setState({ messages: [], conn: 'closed', mode: 'goal' })
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
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    queryClient.clear()
    host.remove()
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function renderPage() {
    act(() => root.render(
      <QueryClientProvider client={queryClient}>
        <GoalHive />
      </QueryClientProvider>,
    ))
  }

  function button(label: string, scope: ParentNode = host): HTMLButtonElement {
    const match = Array.from(scope.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === label,
    )
    if (!(match instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`)
    return match
  }

  function runAnimationFrames() {
    const callbacks = animationFrames.splice(0)
    act(() => callbacks.forEach((callback) => callback(0)))
  }

  it('keeps mode and the inline subagent selector out of the title bar', () => {
    renderPage()

    const header = host.querySelector('[data-testid="page-header"]')!
    expect(header.querySelector('[aria-label="Goal / Hive 主模型"]')?.className).toBe('max-w-[400px]')
    expect(header.textContent).toContain('子代理设置')
    expect(header.textContent).not.toContain('子代理模型')
    expect(header.textContent).not.toContain('GOAL')
    expect(header.textContent).not.toContain('HIVE')
    expect(header.querySelector('[aria-label="Hive 子代理默认模型"]')).toBeNull()
    expect(button('子代理设置', header).disabled).toBe(true)

    const modeControl = host.querySelector('[aria-label="Goal Hive 模式"]')!
    expect(button('GOAL', modeControl).getAttribute('aria-pressed')).toBe('true')
    expect(button('HIVE', modeControl).getAttribute('aria-pressed')).toBe('false')
  })

  it('defaults Hive workers to the main model and saves only on confirmation', async () => {
    renderPage()
    act(() => button('HIVE').click())

    const trigger = button('子代理设置')
    expect(trigger.disabled).toBe(false)
    act(() => trigger.click())

    let dlg = host.querySelector('[role="dialog"]')!
    let select = dlg.querySelector('[aria-label="Hive 子代理默认模型"]') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.textContent).toContain('跟随主模型')
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    act(() => {
      select.value = 'worker'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // Backdrop clicks must be ignored
    act(() => {
      dlg.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    // Cancelling dirty-close confirmation keeps dialog open
    await act(async () => {
      button('取消', dlg).click()
      await Promise.resolve()
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    // Confirming dirty-close discards edits and closes
    await act(async () => {
      button('取消', dlg).click()
      await Promise.resolve()
    })
    runAnimationFrames()
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(mocks.selectSubagentLlm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    confirmSpy.mockRestore()

    act(() => trigger.click())
    dlg = host.querySelector('[role="dialog"]')!
    select = dlg.querySelector('[aria-label="Hive 子代理默认模型"]') as HTMLSelectElement
    act(() => {
      select.value = 'worker'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => button('保存', dlg).click())
    expect(mocks.selectSubagentLlm).toHaveBeenCalledWith('worker')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('closes the Hive subagent dialog with Escape without saving', () => {
    renderPage()
    act(() => button('HIVE').click())
    const trigger = button('子代理设置')
    act(() => trigger.click())
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    runAnimationFrames()

    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(mocks.selectSubagentLlm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
  })

  it('asks for confirmation before resetting non-empty history', async () => {
    useGoalHiveStore.setState({ messages: [{ id: 'm1', role: 'user', content: 'hi', ts: 1, streaming: false }], conn: 'open', mode: 'goal' })
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    renderPage()

    await act(async () => { button('清空历史').click(); await Promise.resolve() })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(mocks.socketSend).not.toHaveBeenCalled()

    await act(async () => { button('清空历史').click(); await Promise.resolve() })
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(mocks.socketSend).toHaveBeenCalledWith({ type: 'reset' })
  })

  it('surfaces disconnected WebSocket state explicitly and pauses auto-scroll when scrolled up', () => {
    renderPage()
    act(() => { useGoalHiveStore.getState().setConn('closed') })

    expect(host.querySelector('[data-testid="page-header"] [aria-label="连接已断开"]')).not.toBeNull()
    expect(host.textContent).toContain('实时通道已断开，正在等待重连…')
    const textarea = host.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '目标')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(button('启动 Goal').disabled).toBe(true)

    act(() => { useGoalHiveStore.getState().setConn('open') })
    const logEl = host.querySelector<HTMLDivElement>('div.overflow-auto')!
    const scrollToSpy = vi.mocked(logEl.scrollTo)
    scrollToSpy.mockClear()

    Object.defineProperty(logEl, 'scrollHeight', { configurable: true, value: 1000 })
    Object.defineProperty(logEl, 'clientHeight', { configurable: true, value: 300 })
    Object.defineProperty(logEl, 'scrollTop', { configurable: true, writable: true, value: 100 })
    act(() => { logEl.dispatchEvent(new Event('scroll')) })

    act(() => {
      useGoalHiveStore.getState().setMessages([{ id: 'm1', role: 'assistant', content: 'streaming chunk', ts: 1, streaming: true }])
    })
    expect(scrollToSpy).not.toHaveBeenCalled()

    logEl.scrollTop = 680
    act(() => { logEl.dispatchEvent(new Event('scroll')) })
    act(() => {
      useGoalHiveStore.getState().setMessages([{ id: 'm1', role: 'assistant', content: 'streaming chunk 2', ts: 1, streaming: true }])
    })
    expect(scrollToSpy).toHaveBeenCalled()
  })

  it('shows retryable alert on llms failure and toasts when ws send returns false', async () => {
    mocks.llms.mockRejectedValueOnce({ body: { detail: '模型服务不可用' } })
    renderPage()
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('模型列表加载失败：模型服务不可用')
    })

    mocks.llms.mockResolvedValueOnce({ llms: [{ key: 'main', index: 0, name: 'Main', current: true }] })
    await act(async () => { button('重试').click(); await new Promise(r => setTimeout(r, 15)) })
    expect(host.querySelector('[role="alert"]')).toBeNull()

    mocks.socketSend.mockReturnValue(false)
    const textarea = host.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, '目标文本')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => { button('启动 Goal').click() })
    expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('实时通道未连接'))).toBe(true)
    expect(useDraftStore.getState().texts['goalHive:goal:target']).toBe('目标文本')
  })
})
