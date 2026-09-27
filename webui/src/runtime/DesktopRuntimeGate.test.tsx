// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopRuntimeGate, LIVENESS_POLL_MS } from './DesktopRuntimeGate'

vi.mock('./desktopBootstrap', () => ({
  queryDesktopBackendReadiness: vi.fn(),
}))

vi.mock('@/utils/desktop', () => ({
  restartDesktopBackend: vi.fn(),
}))

vi.mock('@/utils/backendRestart', () => ({
  waitForDesktopRestart: vi.fn(),
}))

import { queryDesktopBackendReadiness } from './desktopBootstrap'
import { waitForDesktopRestart } from '@/utils/backendRestart'
import { restartDesktopBackend } from '@/utils/desktop'

const mockReadiness = vi.mocked(queryDesktopBackendReadiness)
const mockRestartBackend = vi.mocked(restartDesktopBackend)
const mockWaitForRestart = vi.mocked(waitForDesktopRestart)

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Render the gate inside Tauri and settle the boot poll. */
async function renderReadyGate(root: Root): Promise<void> {
  await act(async () => {
    root.render(
      <DesktopRuntimeGate><div data-testid="content">ready</div></DesktopRuntimeGate>,
    )
    // 轮询 promise 与 React 状态更新需要几个微任务拍落地
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('DesktopRuntimeGate', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    mockReadiness.mockReset()
    mockRestartBackend.mockReset()
    mockWaitForRestart.mockReset()
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

    await renderReadyGate(root)

    expect(hide).toHaveBeenCalledOnce()
    expect(host.querySelector('[data-testid="content"]')?.textContent).toBe('ready')
  })

  it('surfaces a backend death that happens after readiness', async () => {
    vi.useFakeTimers()
    try {
      window.__TAURI_INTERNALS__ = {}
      mockReadiness.mockResolvedValueOnce(true)
      // Tauri rejects a `Result::Err` command with the serialized value, i.e. a
      // plain string rather than an Error instance.
      mockReadiness.mockRejectedValue(
        'GA-Hub 后端进程已退出（可能崩溃或被系统终止），请重启后端。',
      )

      await renderReadyGate(root)
      expect(host.querySelector('[data-testid="content"]')).not.toBeNull()

      // One liveness tick is enough: the shell reports a dead sidecar as an error.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS + 10)
      })

      expect(host.textContent).toContain('后端进程已退出')
      // Children stay mounted under the overlay so the restart keeps their state.
      expect(host.querySelector('[data-testid="content"]')).not.toBeNull()
      expect(host.textContent).toContain('重启后端')
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a not-ready backend as a restart in progress, not a failure', async () => {
    vi.useFakeTimers()
    try {
      window.__TAURI_INTERNALS__ = {}
      mockReadiness.mockResolvedValueOnce(true)
      // Stopping/Spawning/Running: a shell-side restart, which has its own UI and
      // can legitimately take tens of seconds on a cold one-file sidecar.
      mockReadiness.mockResolvedValue(false)

      await renderReadyGate(root)

      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS * 12)
      })

      expect(host.textContent).not.toContain('后端已断开')
      expect(host.textContent).not.toContain('重启后端')
      expect(host.querySelector('[data-testid="content"]')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restarts through the desktop facade from the lost overlay', async () => {
    vi.useFakeTimers()
    try {
      window.__TAURI_INTERNALS__ = {}
      mockReadiness.mockResolvedValueOnce(true)
      mockReadiness.mockRejectedValue('GA-Hub 后端进程已退出')
      // Never resolves: the assertion is about the delegated calls, not the reload.
      mockWaitForRestart.mockReturnValue(new Promise(() => {}))

      await renderReadyGate(root)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(LIVENESS_POLL_MS + 10)
      })

      const button = Array.from(host.querySelectorAll('button'))
        .find(element => element.textContent?.includes('重启后端'))
      expect(button).toBeDefined()

      await act(async () => { button?.click() })

      expect(mockRestartBackend).toHaveBeenCalledOnce()
      expect(mockWaitForRestart).toHaveBeenCalledOnce()
      expect(host.textContent).toContain('正在重启后端…')
    } finally {
      vi.useRealTimers()
    }
  })
})
