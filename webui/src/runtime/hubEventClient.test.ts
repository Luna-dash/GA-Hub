import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONTROL_EVENT_PREFIXES, HubEventClient } from './hubEventClient'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    this.url = String(url)
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.onclose?.(new CloseEvent('close'))
  }

  open() {
    this.onopen?.(new Event('open'))
  }

  message(value: unknown) {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}

describe('HubEventClient', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('uses one control-plane socket for many subscribers and excludes chat', () => {
    const client = new HubEventClient()
    const agent = vi.fn()
    const wechat = vi.fn()
    client.subscribe('agent:', agent)
    client.subscribe('wechat:', wechat)

    client.start()
    client.start()

    expect(FakeWebSocket.instances).toHaveLength(1)
    const socket = FakeWebSocket.instances[0]
    const url = new URL(socket.url)
    expect(url.searchParams.getAll('prefix')).toEqual(CONTROL_EVENT_PREFIXES)
    expect(url.searchParams.getAll('prefix')).not.toContain('chat:')
    expect(url.searchParams.get('replay')).toBe('0')

    socket.open()
    socket.message({ topic: 'chat:next', payload: { content: 'excluded' }, ts: 1 })
    socket.message({ topic: 'wechat:message_in', payload: { text: 'hello' }, ts: 2 })

    expect(agent).not.toHaveBeenCalled()
    expect(wechat).toHaveBeenCalledTimes(1)
    client.stop()
  })

  it('isolates subscriber failures and leaves the transport running', () => {
    const client = new HubEventClient(['agent:'])
    const healthy = vi.fn()
    client.subscribe('agent:', () => { throw new Error('consumer failed') })
    client.subscribe('agent:', healthy)
    client.start()

    FakeWebSocket.instances[0].message({ topic: 'agent:status', payload: {}, ts: 1 })

    expect(healthy).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances).toHaveLength(1)
    client.stop()
  })

  it('reconnects with backoff while running', async () => {
    vi.useFakeTimers()
    const client = new HubEventClient(['agent:'])
    client.start()
    FakeWebSocket.instances[0].close()

    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    client.stop()
  })

  it('ignores callbacks from an old connection after stop and restart', () => {
    const client = new HubEventClient(['agent:'])
    const handler = vi.fn()
    client.subscribe('agent:', handler)
    client.start()
    const oldSocket = FakeWebSocket.instances[0]

    client.stop()
    client.start()
    const currentSocket = FakeWebSocket.instances[1]
    oldSocket.message({ topic: 'agent:status', payload: { stale: true }, ts: 1 })
    currentSocket.message({ topic: 'agent:status', payload: { stale: false }, ts: 2 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].payload).toEqual({ stale: false })
    client.stop()
  })
})
