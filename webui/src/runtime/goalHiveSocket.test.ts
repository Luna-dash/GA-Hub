import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GoalHiveSocket } from './goalHiveSocket'

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

  rawMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  message(value: unknown): void {
    this.rawMessage(JSON.stringify(value))
  }
}

describe('GoalHiveSocket adapter', () => {
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

  it('filters GoalHive frames and replaces messages for snapshots/updates', () => {
    const socket = new GoalHiveSocket()
    const states: string[] = []
    const messages: unknown[] = []
    socket.onState = (state) => states.push(state)
    socket.onMessages = (value) => messages.push(value)

    socket.open()
    const current = FakeWebSocket.instances[0]
    current.open()
    current.message({ type: 'snapshot', messages: [{ id: 'a' }] })
    current.message({ type: 'update', messages: [{ id: 'b' }] })
    current.message({ type: 'other', messages: [{ id: 'ignored' }] })
    current.rawMessage('{broken')
    current.message({ type: 'snapshot', messages: 'invalid' })

    expect(states).toEqual(['connecting', 'open'])
    expect(messages).toEqual([[{ id: 'a' }], [{ id: 'b' }], []])
    socket.close()
  })

  it('preserves command payloads and uses a fixed two-second reconnect cadence', async () => {
    vi.useFakeTimers()
    const socket = new GoalHiveSocket()
    socket.open()
    const current = FakeWebSocket.instances[0]
    expect(socket.send({ type: 'abort' })).toBe(false)
    current.open()

    expect(socket.send({
      type: 'submit',
      text: 'goal text\nconstraint',
      mode: 'hive',
      llm_index: 1,
      subagent_llm_index: 2,
    })).toBe(true)
    expect(socket.send({ type: 'abort' })).toBe(true)
    expect(socket.send({ type: 'reset' })).toBe(true)
    expect(current.sent).toEqual([
      '{"type":"submit","text":"goal text\\nconstraint","mode":"hive","llm_index":1,"subagent_llm_index":2}',
      '{"type":"abort"}',
      '{"type":"reset"}',
    ])

    current.remoteClose()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(FakeWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(FakeWebSocket.instances).toHaveLength(2)
    socket.close()
  })
})
