import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryDesktopBackendReadiness } from './desktopBootstrap'

describe('desktop bootstrap readiness', () => {
  afterEach(() => {
    delete window.__GA_HUB_RUNTIME__
    delete window.__TAURI_INTERNALS__
  })

  it('does not invoke Tauri in browser/server mode', async () => {
    const invokeReady = vi.fn().mockResolvedValue(false)

    await expect(queryDesktopBackendReadiness(invokeReady)).resolves.toBe(true)
    expect(invokeReady).not.toHaveBeenCalled()
  })

  it('polls the native readiness state for a valid desktop identity', async () => {
    window.__TAURI_INTERNALS__ = {}
    window.__GA_HUB_RUNTIME__ = {
      apiOrigin: 'http://127.0.0.1:43123',
      wsOrigin: 'ws://127.0.0.1:43123',
      desktop: true,
      instanceToken: 'instance-123',
    }
    const invokeReady = vi.fn().mockResolvedValue(false)

    await expect(queryDesktopBackendReadiness(invokeReady)).resolves.toBe(false)
    expect(invokeReady).toHaveBeenCalledOnce()
  })

  it('rejects a Tauri page before any native call when injection is missing', async () => {
    window.__TAURI_INTERNALS__ = {}
    const invokeReady = vi.fn()

    await expect(queryDesktopBackendReadiness(invokeReady)).rejects.toThrow('桌面运行配置未注入')
    expect(invokeReady).not.toHaveBeenCalled()
  })
})
