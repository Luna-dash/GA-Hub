import type { BusEvent } from '@/api/types'
import { resolveWsUrl } from './runtimeConfig'

export const CONTROL_EVENT_PREFIXES = [
  'agent:',
  'session:',
  'wechat:',
  'feishu:',
  'conductor:',
  'autonomous:',
  'task:',
] as const

export type HubEventConnectionState = 'closed' | 'connecting' | 'open'
type EventHandler = (event: BusEvent) => void
type StateHandler = (state: HubEventConnectionState) => void

export class HubEventClient {
  private ws?: WebSocket
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private running = false
  private generation = 0
  private nextSubscriberId = 1
  private state: HubEventConnectionState = 'closed'
  private readonly eventHandlers = new Map<number, { prefix: string; handler: EventHandler }>()
  private readonly stateHandlers = new Map<number, StateHandler>()

  constructor(private readonly prefixes: readonly string[] = CONTROL_EVENT_PREFIXES) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.reconnectAttempts = 0
    const generation = ++this.generation
    this.connect(generation)
  }

  stop(): void {
    if (!this.running && !this.ws && this.reconnectTimer === undefined) return
    this.running = false
    ++this.generation
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const ws = this.ws
    this.ws = undefined
    try { ws?.close() } catch {}
    this.reconnectAttempts = 0
    this.setState('closed')
  }

  subscribe(prefix: string, handler: EventHandler): () => void {
    const id = this.nextSubscriberId++
    this.eventHandlers.set(id, { prefix, handler })
    return () => {
      this.eventHandlers.delete(id)
    }
  }

  subscribeState(handler: StateHandler): () => void {
    const id = this.nextSubscriberId++
    this.stateHandlers.set(id, handler)
    try { handler(this.state) } catch {}
    return () => {
      this.stateHandlers.delete(id)
    }
  }

  private connect(generation: number): void {
    if (!this.running || generation !== this.generation) return
    this.setState('connecting')

    const query = new URLSearchParams()
    for (const prefix of this.prefixes) query.append('prefix', prefix)
    query.set('replay', '0')

    let ws: WebSocket
    try {
      ws = new WebSocket(resolveWsUrl(`/ws/events?${query.toString()}`))
    } catch {
      this.scheduleReconnect(generation)
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (!this.isCurrent(ws, generation)) return
      this.reconnectAttempts = 0
      this.setState('open')
    }
    ws.onmessage = (message) => {
      if (!this.isCurrent(ws, generation)) return
      let event: BusEvent
      try {
        event = JSON.parse(message.data) as BusEvent
      } catch {
        return
      }
      if (!event || typeof event.topic !== 'string') return
      for (const { prefix, handler } of this.eventHandlers.values()) {
        if (!event.topic.startsWith(prefix)) continue
        try { handler(event) } catch {}
      }
    }
    ws.onclose = () => {
      if (!this.isCurrent(ws, generation)) return
      this.ws = undefined
      this.setState('closed')
      this.scheduleReconnect(generation)
    }
    ws.onerror = () => {
      try { ws.close() } catch {}
    }
  }

  private isCurrent(ws: WebSocket, generation: number): boolean {
    return this.running && generation === this.generation && this.ws === ws
  }

  private scheduleReconnect(generation: number): void {
    if (!this.running || generation !== this.generation || this.reconnectTimer !== undefined) return
    this.setState('closed')
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000)
    this.reconnectAttempts++
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect(generation)
    }, delay)
  }

  private setState(state: HubEventConnectionState): void {
    if (this.state === state) return
    this.state = state
    for (const handler of this.stateHandlers.values()) {
      try { handler(state) } catch {}
    }
  }
}

export const hubEventClient = new HubEventClient()
