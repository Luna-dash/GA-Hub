// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from './ErrorBoundary'

let host: HTMLDivElement
let root: Root

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) throw new Error('boom during render')
  return <p>recovered route</p>
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('catches route errors and resets automatically when resetKey changes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await act(async () => {
      root.render(
        <ErrorBoundary resetKey="/broken">
          <Bomb shouldThrow />
        </ErrorBoundary>,
      )
    })
    expect(host.textContent).toContain('页面渲染出错')
    expect(host.textContent).toContain('boom during render')

    await act(async () => {
      root.render(
        <ErrorBoundary resetKey="/healthy">
          <Bomb shouldThrow={false} />
        </ErrorBoundary>,
      )
    })
    expect(host.textContent).toContain('recovered route')
    expect(host.textContent).not.toContain('页面渲染出错')
  })

  it('supports in-place retry without full page reload and delegates home navigation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let fail = true
    function Flaky() {
      if (fail) throw new Error('transient crash')
      return <p>in-place ok</p>
    }
    const onNavigateHome = vi.fn()

    await act(async () => {
      root.render(
        <ErrorBoundary resetKey="/flaky" onNavigateHome={onNavigateHome}>
          <Flaky />
        </ErrorBoundary>,
      )
    })
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.every((b) => b.type === 'button')).toBe(true)
    const retryBtn = buttons.find((b) => b.textContent === '重试')!
    const homeBtn = buttons.find((b) => b.textContent === '返回首页')!
    expect(retryBtn).toBeDefined()
    expect(homeBtn).toBeDefined()

    fail = false
    await act(async () => retryBtn.click())
    expect(host.textContent).toContain('in-place ok')
    expect(onNavigateHome).not.toHaveBeenCalled()

    fail = true
    await act(async () => {
      root.render(
        <ErrorBoundary resetKey="/flaky-2" onNavigateHome={onNavigateHome}>
          <Flaky />
        </ErrorBoundary>,
      )
    })
    const homeBtn2 = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === '返回首页')!
    await act(async () => homeBtn2.click())
    expect(onNavigateHome).toHaveBeenCalledTimes(1)
  })
})
