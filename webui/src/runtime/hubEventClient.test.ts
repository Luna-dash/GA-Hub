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
    expect(url.searchParams.getAll('prefix')).not.toContain('feishu:')
    expect(url.searchParams.get('cursor')).toBe('1')
    expect(url.searchParams.get('replay')).toBe('0')
    expect(url.searchParams.has('after_event_id')).toBe(false)
    expect(url.searchParams.has('epoch')).toBe(false)

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

  it('reports open only after the replay barrier', () => {
    const client = new HubEventClient(['agent:'])
    const states: string[] = []
    client.subscribeState((state) => states.push(state))
    client.start()
    const socket = FakeWebSocket.instances[0]

    socket.open()
    expect(states).toEqual(['closed', 'connecting'])

    socket.message({ type: 'replay_done', event_id: 0, epoch: 'epoch-a' })
    expect(states).toEqual(['closed', 'connecting', 'open'])

    socket.message({ type: 'resync_required', reason: 'subscriber_overflow', epoch: 'epoch-a' })
    expect(states).toEqual(['closed', 'connecting', 'open', 'connecting'])
    client.stop()
  })

  it('notifies control subscribers without exposing control frames as events', () => {
    const client = new HubEventClient(['agent:'])
    const control = vi.fn()
    const event = vi.fn()
    client.subscribeControl(control)
    client.subscribe('', event)
    client.start()
    const socket = FakeWebSocket.instances[0]

    socket.message({ type: 'resync_required', reason: 'server_restarted', epoch: 'epoch-b' })
    socket.message({ type: 'replay_done', event_id: 3, epoch: 'epoch-b' })

    expect(control).toHaveBeenCalledTimes(2)
    expect(control.mock.calls[0][0]).toMatchObject({ type: 'resync_required' })
    expect(event).not.toHaveBeenCalled()
    client.stop()
  })

  it('resumes from the replay boundary after a disconnect', async () => {
    vi.useFakeTimers()
    const client = new HubEventClient(['agent:'])
    client.start()
    const firstSocket = FakeWebSocket.instances[0]

    firstSocket.message({ type: 'replay_done', event_id: 12, epoch: 'epoch-a' })
    firstSocket.close()
    await vi.advanceTimersByTimeAsync(1_000)

    const reconnectUrl = new URL(FakeWebSocket.instances[1].url)
    expect(reconnectUrl.searchParams.get('cursor')).toBe('1')
    expect(reconnectUrl.searchParams.get('replay')).toBe('0')
    expect(reconnectUrl.searchParams.get('after_event_id')).toBe('12')
    expect(reconnectUrl.searchParams.get('epoch')).toBe('epoch-a')
    client.stop()
  })

  it('deduplicates repeated and out-of-order cursor events', () => {
    const client = new HubEventClient(['agent:'])
    const handler = vi.fn()
    client.subscribe('agent:', handler)
    client.start()
    const socket = FakeWebSocket.instances[0]

    socket.message({ type: 'replay_done', event_id: 4, epoch: 'epoch-a' })
    socket.message({ topic: 'agent:status', payload: { id: 5 }, ts: 5, event_id: 5, epoch: 'epoch-a' })
    socket.message({ topic: 'agent:status', payload: { id: 5 }, ts: 5, event_id: 5, epoch: 'epoch-a' })
    socket.message({ topic: 'agent:status', payload: { id: 3 }, ts: 3, event_id: 3, epoch: 'epoch-a' })
    socket.message({ topic: 'agent:status', payload: { id: 6 }, ts: 6, event_id: 6, epoch: 'epoch-a' })

    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls.map(([event]) => event.event_id)).toEqual([5, 6])
    client.stop()
  })

  it('uses replay_done as the global resume boundary', async () => {
    vi.useFakeTimers()
    const client = new HubEventClient(['agent:'])
    client.start()
    const socket = FakeWebSocket.instances[0]

    socket.message({ topic: 'agent:status', payload: {}, ts: 2, event_id: 2, epoch: 'epoch-a' })
    socket.message({ type: 'replay_done', event_id: 8, epoch: 'epoch-a' })
    socket.close()
    await vi.advanceTimersByTimeAsync(1_000)

    const reconnectUrl = new URL(FakeWebSocket.instances[1].url)
    expect(reconnectUrl.searchParams.get('after_event_id')).toBe('8')
    expect(reconnectUrl.searchParams.get('epoch')).toBe('epoch-a')
    client.stop()
  })

  it('drops an old cursor on resync until the new replay barrier arrives', async () => {
    vi.useFakeTimers()
    const client = new HubEventClient(['agent:'])
    client.start()
    const firstSocket = FakeWebSocket.instances[0]
    firstSocket.open()
    firstSocket.message({ type: 'replay_done', event_id: 7, epoch: 'epoch-a' })
    firstSocket.close()
    await vi.advanceTimersByTimeAsync(1_000)

    const secondSocket = FakeWebSocket.instances[1]
    secondSocket.open()
    secondSocket.message({ type: 'resync_required', reason: 'server_restarted', epoch: 'epoch-b' })
    secondSocket.close()
    await vi.advanceTimersByTimeAsync(1_000)

    const thirdSocket = FakeWebSocket.instances[2]
    thirdSocket.open()
    const thirdUrl = new URL(thirdSocket.url)
    expect(thirdUrl.searchParams.has('after_event_id')).toBe(false)
    expect(thirdUrl.searchParams.has('epoch')).toBe(false)

    thirdSocket.message({ type: 'replay_done', event_id: 3, epoch: 'epoch-b' })
    thirdSocket.close()
    await vi.advanceTimersByTimeAsync(1_000)

    const fourthUrl = new URL(FakeWebSocket.instances[3].url)
    expect(fourthUrl.searchParams.get('after_event_id')).toBe('3')
    expect(fourthUrl.searchParams.get('epoch')).toBe('epoch-b')
    client.stop()
  })

  it('does not dispatch replay control frames to event subscribers', () => {
    const client = new HubEventClient(['agent:'])
    const handler = vi.fn()
    client.subscribe('', handler)
    client.start()
    const socket = FakeWebSocket.instances[0]

    socket.message({ type: 'resync_required', reason: 'overflow', epoch: 'epoch-b' })
    socket.message({ type: 'replay_done', event_id: 9, epoch: 'epoch-b' })
    socket.message({ topic: 'agent:status', payload: {}, ts: 10, event_id: 10, epoch: 'epoch-b' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].topic).toBe('agent:status')
    client.stop()
  })

  it('retains the committed cursor across an explicit stop and start', () => {
    const client = new HubEventClient(['agent:'])
    client.start()
    FakeWebSocket.instances[0].message({ type: 'replay_done', event_id: 21, epoch: 'epoch-a' })

    client.stop()
    client.start()

    const restartUrl = new URL(FakeWebSocket.instances[1].url)
    expect(restartUrl.searchParams.get('after_event_id')).toBe('21')
    expect(restartUrl.searchParams.get('epoch')).toBe('epoch-a')
    client.stop()
  })

  it('keeps legacy event frames without cursor metadata compatible', () => {
    const client = new HubEventClient(['agent:'])
    const handler = vi.fn()
    const states: string[] = []
    client.subscribe('agent:', handler)
    client.subscribeState((state) => states.push(state))
    client.start()
    FakeWebSocket.instances[0].open()

    FakeWebSocket.instances[0].message({
      topic: 'agent:status',
      payload: { status: 'running' },
      ts: 1,
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].payload).toEqual({ status: 'running' })
    expect(states).toEqual(['closed', 'connecting', 'open'])
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
