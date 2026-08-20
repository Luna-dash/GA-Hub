// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDraftStore } from '@/stores/draftStore'
import { useGoalHiveStore } from '@/stores/goalhiveStore'
import GoalHive from './GoalHive'

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
  MainModelSelect: ({ value, onChange }: { value?: string; onChange: (value: string) => void }) => (
    <select aria-label="Goal / Hive 主模型" value={value ?? ''} onChange={(event) => onChange(event.target.value)}>
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
    vi.clearAllMocks()
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

  it('defaults Hive workers to the main model and saves only on confirmation', () => {
    renderPage()
    act(() => button('HIVE').click())

    const trigger = button('子代理设置')
    expect(trigger.disabled).toBe(false)
    act(() => trigger.click())

    let dialog = host.querySelector('[role="dialog"]')!
    let select = dialog.querySelector('[aria-label="Hive 子代理默认模型"]') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.textContent).toContain('跟随主模型')
    act(() => {
      select.value = 'worker'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => button('取消', dialog).click())
    runAnimationFrames()
    expect(mocks.selectSubagentLlm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)

    act(() => trigger.click())
    dialog = host.querySelector('[role="dialog"]')!
    select = dialog.querySelector('[aria-label="Hive 子代理默认模型"]') as HTMLSelectElement
    act(() => {
      select.value = 'worker'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => button('保存', dialog).click())
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
})
