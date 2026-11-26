// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installExternalLinkInterceptor, isAppInternalUrl, isHttpUrl } from './openExternal'

const mocks = vi.hoisted(() => ({
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./desktop', () => ({
  openExternalUrl: mocks.openExternalUrl,
}))

describe('desktop link classification', () => {
  afterEach(() => {
    delete window.__GA_HUB_RUNTIME__
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    mocks.openExternalUrl.mockClear()
  })

  it('keeps SPA routes internal while treating a separate backend as external', () => {
    window.__GA_HUB_RUNTIME__ = { apiOrigin: 'http://127.0.0.1:43123' }

    expect(isAppInternalUrl('/chat')).toBe(true)
    expect(isAppInternalUrl('/conversations/session-1')).toBe(true)
    expect(isAppInternalUrl('http://127.0.0.1:43123/api/files/report.pdf')).toBe(false)
    expect(isAppInternalUrl('https://example.com/docs')).toBe(false)
  })

  it('only classifies HTTP transports as browser-openable links', () => {
    expect(isHttpUrl('/api/files/report.pdf')).toBe(true)
    expect(isHttpUrl('https://example.com/docs')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('file:///C:/report.pdf')).toBe(false)
  })

  it('traps modifier and middle auxclicks in Tauri desktop while preserving them in browser mode', async () => {
    const link = document.createElement('a')
    link.href = 'https://example.com/docs'
    document.body.appendChild(link)
    // Prevent jsdom from attempting real navigation when a browser-mode click is not intercepted.
    let interceptorPreventedBrowserClick: boolean | null = null
    const cancelUninterceptedNav = (ev: MouseEvent) => {
      if (!('__TAURI_INTERNALS__' in window)) {
        interceptorPreventedBrowserClick = ev.defaultPrevented
        ev.preventDefault()
      }
    }
    link.addEventListener('click', cancelUninterceptedNav)
    const dispose = installExternalLinkInterceptor()

    try {
      const browserCtrl = new MouseEvent('click', { button: 0, ctrlKey: true, bubbles: true, cancelable: true })
      link.dispatchEvent(browserCtrl)
      expect(interceptorPreventedBrowserClick).toBe(false)
      expect(mocks.openExternalUrl).not.toHaveBeenCalled()

      const browserAux = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
      link.dispatchEvent(browserAux)
      expect(browserAux.defaultPrevented).toBe(false)

      ;(window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}

      const desktopCtrl = new MouseEvent('click', { button: 0, ctrlKey: true, bubbles: true, cancelable: true })
      link.dispatchEvent(desktopCtrl)
      expect(desktopCtrl.defaultPrevented).toBe(true)

      const desktopAux = new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })
      link.dispatchEvent(desktopAux)
      expect(desktopAux.defaultPrevented).toBe(true)

      await vi.waitFor(() => expect(mocks.openExternalUrl).toHaveBeenCalledTimes(2))
      expect(mocks.openExternalUrl).toHaveBeenCalledWith('https://example.com/docs')
    } finally {
      dispose()
      link.removeEventListener('click', cancelUninterceptedNav)
      link.remove()
    }
  })
})
