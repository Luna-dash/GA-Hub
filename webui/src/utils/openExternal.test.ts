import { afterEach, describe, expect, it } from 'vitest'
import { isAppInternalUrl, isHttpUrl } from './openExternal'

describe('desktop link classification', () => {
  afterEach(() => {
    delete window.__GA_HUB_RUNTIME__
  })

  it('keeps SPA routes internal while treating a separate backend as external', () => {
    window.__GA_HUB_RUNTIME__ = { apiOrigin: 'http://127.0.0.1:43123' }

    expect(isAppInternalUrl('/chat')).toBe(true)
    expect(isAppInternalUrl('http://127.0.0.1:43123/api/files/report.pdf')).toBe(false)
    expect(isAppInternalUrl('https://example.com/docs')).toBe(false)
  })

  it('only classifies HTTP transports as browser-openable links', () => {
    expect(isHttpUrl('/api/files/report.pdf')).toBe(true)
    expect(isHttpUrl('https://example.com/docs')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('file:///C:/report.pdf')).toBe(false)
  })
})
