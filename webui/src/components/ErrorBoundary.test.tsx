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
})
