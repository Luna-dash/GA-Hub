import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSocket } from './chatSocket'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  sent: string[] = []
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  open(): void {
    this.readyState = 1
    this.onopen?.(new Event('open'))
  }

  send(value: string): void {
    this.sent.push(value)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }

  remoteClose(): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }

  message(value: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}

describe('ChatSocket adapter', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    delete window.__GA_HUB_RUNTIME__
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    delete window.__GA_HUB_RUNTIME__
  })

  it('preserves typed receive frames and dynamic session paths across reconnects', async () => {
    vi.useFakeTimers()
    let cursor = ''
    const socket = new ChatSocket(() => `/ws/sessions/session-a${cursor}`)
    const states: string[] = []
    const messages: unknown[] = []
    socket.onState = (state) => states.push(state)
    socket.onMessage = (message) => messages.push(message)

    socket.open()
    socket.open()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(FakeWebSocket.instances[0].url).toContain('/ws/sessions/session-a')
    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].message({ type: 'snapshot', streams: [] })
    expect(messages).toEqual([{ type: 'snapshot', streams: [] }])

    cursor = '?after_event_id=42&epoch=epoch-a'
    FakeWebSocket.instances[0].remoteClose()
    await vi.advanceTimersByTimeAsync(999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(FakeWebSocket.instances[1].url).toContain('after_event_id=42')
    expect(FakeWebSocket.instances[1].url).toContain('epoch=epoch-a')
    expect(states).toEqual(['connecting', 'open', 'closed', 'connecting'])
    socket.close()
  })

  it('keeps receive-only callers safe while disconnected and serializes commands when open', () => {
    const socket = new ChatSocket('/ws/chat')
    socket.send({ type: 'ping' })
    socket.open()
    const current = FakeWebSocket.instances[0]
    current.open()
    socket.send({ type: 'ping' })
    expect(current.sent).toEqual(['{"type":"ping"}'])
    current.remoteClose()
    socket.send({ type: 'abort' })
    expect(current.sent).toEqual(['{"type":"ping"}'])
    socket.close()
  })

  it('cancels pending reconnect on explicit close', async () => {
    vi.useFakeTimers()
    const socket = new ChatSocket('/ws/chat')
    socket.open()
    FakeWebSocket.instances[0].remoteClose()
    socket.close()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
