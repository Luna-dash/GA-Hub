import { afterEach, describe, expect, it } from 'vitest'
import {
  getRuntimeConfig,
  resolveApiUrl,
  resolveWsUrl,
} from './runtimeConfig'

describe('runtimeConfig', () => {
  afterEach(() => {
    delete window.__GA_HUB_RUNTIME__
  })

  it('preserves relative API paths in the current same-origin runtime', () => {
    expect(getRuntimeConfig()).toEqual({ apiOrigin: '', wsOrigin: '' })
    expect(resolveApiUrl('/api/status?full=true')).toBe('/api/status?full=true')

    const expected = new URL('/ws/chat', window.location.href)
    expected.protocol = expected.protocol === 'https:' ? 'wss:' : 'ws:'
    expect(resolveWsUrl('/ws/chat')).toBe(expected.href)
  })

  it('routes HTTP, file, and WebSocket paths through an injected backend', () => {
    window.__GA_HUB_RUNTIME__ = { apiOrigin: 'http://127.0.0.1:43123/' }

    expect(getRuntimeConfig()).toEqual({
      apiOrigin: 'http://127.0.0.1:43123',
      wsOrigin: 'ws://127.0.0.1:43123',
    })
    expect(resolveApiUrl('/api/files/a%20b.png?download=1')).toBe(
      'http://127.0.0.1:43123/api/files/a%20b.png?download=1',
    )
    expect(resolveWsUrl('/ws/events?prefix=agent%3A')).toBe(
      'ws://127.0.0.1:43123/ws/events?prefix=agent%3A',
    )
  })

  it('ignores malformed or credential-bearing injected origins', () => {
    window.__GA_HUB_RUNTIME__ = {
      apiOrigin: 'http://user:secret@127.0.0.1:43123',
      wsOrigin: 'not a URL',
    }

    expect(getRuntimeConfig()).toEqual({ apiOrigin: '', wsOrigin: '' })
  })
})
