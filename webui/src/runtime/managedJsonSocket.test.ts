import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RECONNECT_DELAY_MS, ManagedJsonSocket } from './managedJsonSocket'

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  readonly url: string
  readyState = 0
  sent: string[] = []
  throwOnSend = false
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
    if (this.throwOnSend) throw new Error('send failed')
    this.sent.push(value)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }

  remoteClose(): void {
    this.readyState = 3
    this.onclose?.(new CloseEvent('close'))
  }

  error(): void {
    this.onerror?.(new Event('error'))
  }

  rawMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  message(value: unknown): void {
    this.rawMessage(JSON.stringify(value))
  }
}

const createWebSocket = (url: string): WebSocket =>
  new FakeWebSocket(url) as unknown as WebSocket

describe('ManagedJsonSocket', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    delete window.__GA_HUB_RUNTIME__
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete window.__GA_HUB_RUNTIME__
  })

  it('opens idempotently and keeps malformed or failing handlers isolated', () => {
    const socket = new ManagedJsonSocket<{ value: number }, never>({
      path: '/ws/test',
      createWebSocket,
    })
    const states: string[] = []
    const messages = vi.fn()
      .mockImplementationOnce(() => { throw new Error('consumer failed') })
    socket.onState = (state) => states.push(state)
    socket.onMessage = messages

    socket.open()
    socket.start()
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(states).toEqual(['connecting'])

    const current = FakeWebSocket.instances[0]
    current.open()
    current.rawMessage('{broken')
    current.rawMessage(new Blob(['{}']))
    current.message({ value: 1 })
    current.message({ value: 2 })

    expect(states).toEqual(['connecting', 'open'])
    expect(messages).toHaveBeenCalledTimes(2)
    expect(messages.mock.calls[1][0]).toEqual({ value: 2 })
    expect(socket.connectionState).toBe('open')
  })

  it('sends only on the open socket and contains serialization or send failures', () => {
    const socket = new ManagedJsonSocket<never, unknown>({
      path: '/ws/test',
      createWebSocket,
    })
    socket.open()
    const current = FakeWebSocket.instances[0]

    expect(socket.send({ type: 'before-open' })).toBe(false)
    current.open()
    expect(socket.send({ type: 'ping' })).toBe(true)
    expect(current.sent).toEqual(['{"type":"ping"}'])

    const circular: { self?: unknown } = {}
    circular.self = circular
    expect(() => socket.send(circular)).not.toThrow()
    expect(socket.send(circular)).toBe(false)
    expect(socket.send({ value: BigInt(1) })).toBe(false)

    current.throwOnSend = true
    expect(socket.send({ type: 'send-error' })).toBe(false)
    socket.close()
    expect(socket.send({ type: 'after-close' })).toBe(false)
  })

  it('retries constructor failures with exponential backoff and resets after open', async () => {
    vi.useFakeTimers()
    let failures = 2
    const factory = vi.fn((url: string) => {
      if (failures-- > 0) throw new Error('constructor failed')
      return createWebSocket(url)
    })
    const socket = new ManagedJsonSocket({ path: '/ws/test', createWebSocket: factory })

    socket.open()
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(factory).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(3)

    FakeWebSocket.instances[0].open()
    FakeWebSocket.instances[0].remoteClose()
    await vi.advanceTimersByTimeAsync(999)
    expect(factory).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(factory).toHaveBeenCalledTimes(4)
    socket.close()

    expect(DEFAULT_RECONNECT_DELAY_MS(0)).toBe(1_000)
    expect(DEFAULT_RECONNECT_DELAY_MS(1)).toBe(2_000)
    expect(DEFAULT_RECONNECT_DELAY_MS(5)).toBe(30_000)
    expect(DEFAULT_RECONNECT_DELAY_MS(100)).toBe(30_000)
  })

  it('clears a pending reconnect and ignores callbacks from an old generation', async () => {
    vi.useFakeTimers()
    const socket = new ManagedJsonSocket<{ generation: string }, never>({
      path: '/ws/test',
      createWebSocket,
    })
    const states: string[] = []
    const messages = vi.fn()
    socket.onState = (state) => states.push(state)
    socket.onMessage = messages

    socket.open()
    const old = FakeWebSocket.instances[0]
    old.open()
    old.remoteClose()
    socket.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(FakeWebSocket.instances).toHaveLength(1)

    socket.start()
    const current = FakeWebSocket.instances[1]
    old.onopen?.(new Event('open'))
    old.message({ generation: 'old' })
    old.onclose?.(new CloseEvent('close'))
    current.open()
    current.message({ generation: 'current' })
    await vi.advanceTimersByTimeAsync(60_000)

    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(messages).toHaveBeenCalledOnce()
    expect(messages).toHaveBeenCalledWith({ generation: 'current' })
    expect(states.at(-1)).toBe('open')
    socket.close()
  })

  it('coalesces error and close into one reconnect', async () => {
    vi.useFakeTimers()
    const socket = new ManagedJsonSocket({ path: '/ws/test', createWebSocket })
    socket.open()
    const failed = FakeWebSocket.instances[0]
    failed.open()
    failed.error()
    failed.onclose?.(new CloseEvent('close'))

    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
    socket.close()
  })

  it('re-evaluates a dynamic path before reconnecting', async () => {
    vi.useFakeTimers()
    let cursor = 'first'
    const socket = new ManagedJsonSocket({
      path: () => `/ws/session?cursor=${cursor}`,
      createWebSocket,
    })
    socket.open()
    expect(FakeWebSocket.instances[0].url).toContain('cursor=first')

    FakeWebSocket.instances[0].open()
    cursor = 'second'
    FakeWebSocket.instances[0].remoteClose()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(FakeWebSocket.instances[1].url).toContain('cursor=second')
    socket.close()
  })

  it('clears reconnect timer id zero on stop', () => {
    let scheduled: TimerHandler | undefined
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout').mockImplementation((handler) => {
      scheduled = handler
      return 0
    })
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout').mockImplementation(() => {})
    const socket = new ManagedJsonSocket({ path: '/ws/test', createWebSocket })
    socket.open()
    FakeWebSocket.instances[0].remoteClose()
    expect(setTimeoutSpy).toHaveBeenCalledOnce()

    socket.stop()
    expect(clearTimeoutSpy).toHaveBeenCalledWith(0)
    if (typeof scheduled === 'function') scheduled()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
