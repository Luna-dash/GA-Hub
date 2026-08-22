// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopRuntimeGate } from './DesktopRuntimeGate'

vi.mock('./desktopBootstrap', () => ({
  queryDesktopBackendReadiness: vi.fn(),
}))

import { queryDesktopBackendReadiness } from './desktopBootstrap'

const mockReadiness = vi.mocked(queryDesktopBackendReadiness)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('DesktopRuntimeGate', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    mockReadiness.mockReset()
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete window.__GA_HUB_RUNTIME__
    delete window.__TAURI_INTERNALS__
    delete window.__GA_HUB_HIDE_LOADING__
  })

  it('renders browser/server children without a native readiness call', () => {
    act(() => root.render(
      <DesktopRuntimeGate><div data-testid="content">ready</div></DesktopRuntimeGate>,
    ))

    expect(mockReadiness).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
  })

  it('fails closed when a Tauri page is missing its injected runtime', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockReadiness.mockRejectedValue(new Error('桌面运行配置未注入'))
    const hide = vi.fn()
    window.__GA_HUB_HIDE_LOADING__ = hide

    await act(async () => {
      root.render(
        <DesktopRuntimeGate><div data-testid="content">must not render</div></DesktopRuntimeGate>,
      )
      await Promise.resolve()
    })

    expect(hide).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-testid="content"]')).toBeNull()
    expect(host.textContent).toContain('桌面运行配置未注入')
  })

  it('dismisses the boot loader and renders children once backend is ready', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockReadiness.mockResolvedValue(true)
    const hide = vi.fn()
    window.__GA_HUB_HIDE_LOADING__ = hide

    await act(async () => {
      root.render(
        <DesktopRuntimeGate><div data-testid="content">ready</div></DesktopRuntimeGate>,
      )
      // 轮询 promise 与 React 状态更新需要几个微任务拍落地
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(hide).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
  })
})
