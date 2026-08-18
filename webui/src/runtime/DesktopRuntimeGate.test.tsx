// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesktopRuntimeGate } from './DesktopRuntimeGate'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('DesktopRuntimeGate', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete window.__GA_HUB_RUNTIME__
    delete window.__TAURI_INTERNALS__
  })

  it('renders browser/server children without a native readiness call', () => {
    act(() => root.render(
      <DesktopRuntimeGate><div data-testid="content">ready</div></DesktopRuntimeGate>,
    ))

    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
  })

  it('fails closed when a Tauri page is missing its injected runtime', async () => {
    window.__TAURI_INTERNALS__ = {}

    await act(async () => {
      root.render(
        <DesktopRuntimeGate><div data-testid="content">must not render</div></DesktopRuntimeGate>,
      )
      await Promise.resolve()
    })

    expect(host.querySelector('[data-testid="content"]')).toBeNull()
    expect(host.textContent).toContain('桌面运行配置未注入')
  })
})
