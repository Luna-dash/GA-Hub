// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'

const loaderModules = import.meta.glob('../../public/gahub-loader.js', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

describe('gahub-loader lifecycle teardown', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    const rootEl = document.getElementById('root')
    if (rootEl) rootEl.innerHTML = ''
    document.getElementById('ga-hub-boot')?.remove()
    document.querySelectorAll('head style').forEach((s) => {
      if (s.textContent?.includes('#ga-hub-boot')) s.remove()
    })
    document.documentElement.removeAttribute('data-boot-splash')
    delete window.__TAURI_INTERNALS__
    delete (window as typeof window & { __GA_HUB_HIDE_LOADING__?: unknown }).__GA_HUB_HIDE_LOADING__
    delete (window as typeof window & { __GA_HUB_LOADING_READY__?: unknown }).__GA_HUB_LOADING_READY__
  })

  it('removes resize and visibilitychange listeners and releases canvas memory after hide', () => {
    vi.useFakeTimers()
    if (!document.getElementById('root')) {
      const rootEl = document.createElement('div')
      rootEl.id = 'root'
      document.body.appendChild(rootEl)
    }
    window.__TAURI_INTERNALS__ = {}

    const setTransform = vi.fn()
    const ctxStub = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      shadowBlur: 0,
      shadowColor: '',
      setTransform,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      rotate: vi.fn(),
      scale: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      ellipse: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStub as never)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const removeDocListener = vi.spyOn(document, 'removeEventListener')

    const code = Object.values(loaderModules)[0]
    expect(typeof code).toBe('string')
    // eslint-disable-next-line no-new-func
    new Function(code)()

    const canvas = document.querySelector<HTMLCanvasElement>('#ga-hub-boot canvas')
    expect(canvas).not.toBeNull()
    expect(canvas!.width).toBeGreaterThan(0)
    expect(setTransform).toHaveBeenCalledTimes(1)

    ;(window as typeof window & { __GA_HUB_HIDE_LOADING__?: () => void }).__GA_HUB_HIDE_LOADING__?.()
    vi.advanceTimersByTime(4_000)

    expect(canvas!.width).toBe(0)
    expect(canvas!.height).toBe(0)
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeDocListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    setTransform.mockClear()
    window.dispatchEvent(new Event('resize'))
    vi.advanceTimersByTime(500)
    expect(setTransform).not.toHaveBeenCalled()
    expect(canvas!.width).toBe(0)
  })
})
