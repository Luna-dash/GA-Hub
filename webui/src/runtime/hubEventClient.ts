import type { BusEvent } from '@/api/types'
import { ManagedJsonSocket, type ManagedSocketState } from './managedJsonSocket'

export const CONTROL_EVENT_PREFIXES = [
  'agent:',
  'session:',
  'wechat:',
  'feishu:',
  'conductor:',
  'autonomous:',
  'task:',
] as const

export type HubEventConnectionState = ManagedSocketState
type EventHandler = (event: BusEvent) => void
type StateHandler = (state: HubEventConnectionState) => void

export class HubEventClient {
  private readonly transport: ManagedJsonSocket<BusEvent, never>
  private nextSubscriberId = 1
  private state: HubEventConnectionState = 'closed'
  private readonly eventHandlers = new Map<number, { prefix: string; handler: EventHandler }>()
  private readonly stateHandlers = new Map<number, StateHandler>()

  constructor(private readonly prefixes: readonly string[] = CONTROL_EVENT_PREFIXES) {
    const query = new URLSearchParams()
    for (const prefix of this.prefixes) query.append('prefix', prefix)
    query.set('replay', '0')
    this.transport = new ManagedJsonSocket({ path: `/ws/events?${query.toString()}` })
    this.transport.onMessage = (event) => this.dispatch(event)
    this.transport.onState = (state) => this.setState(state)
  }

  start(): void {
    this.transport.start()
  }

  stop(): void {
    this.transport.stop()
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

  private dispatch(event: BusEvent): void {
    if (!event || typeof event.topic !== 'string') return
    for (const { prefix, handler } of this.eventHandlers.values()) {
      if (!event.topic.startsWith(prefix)) continue
      try { handler(event) } catch {}
    }
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
