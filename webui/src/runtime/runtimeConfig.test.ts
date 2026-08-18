import { afterEach, describe, expect, it } from 'vitest'
import {
  desktopRuntimeConfigError,
  getRuntimeConfig,
  resolveApiUrl,
  resolveWsUrl,
} from './runtimeConfig'

describe('runtimeConfig', () => {
  afterEach(() => {
    delete window.__GA_HUB_RUNTIME__
    delete window.__TAURI_INTERNALS__
  })

  it('preserves relative API paths in the current same-origin runtime', () => {
    expect(getRuntimeConfig()).toEqual({
      apiOrigin: '', wsOrigin: '', desktop: false, instanceToken: '',
    })
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
      desktop: false,
      instanceToken: '',
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

    expect(getRuntimeConfig()).toEqual({
      apiOrigin: '', wsOrigin: '', desktop: false, instanceToken: '',
    })
  })

  it('accepts a complete desktop runtime identity', () => {
    window.__TAURI_INTERNALS__ = {}
    window.__GA_HUB_RUNTIME__ = {
      apiOrigin: 'http://127.0.0.1:43123',
      wsOrigin: 'ws://127.0.0.1:43123',
      desktop: true,
      instanceToken: 'instance-123',
    }

    expect(desktopRuntimeConfigError()).toBeNull()
    expect(getRuntimeConfig()).toMatchObject({
      desktop: true,
      instanceToken: 'instance-123',
    })
  })

  it('fails closed when Tauri starts without an injected runtime', () => {
    window.__TAURI_INTERNALS__ = {}

    expect(desktopRuntimeConfigError()).toBe('桌面运行配置未注入')
  })
})
