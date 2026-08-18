import type { BusEvent, HubEventControl, HubEventMessage } from '@/api/types'
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
type ControlHandler = (control: HubEventControl) => void
type EventCursor = { event_id: number; epoch: string }

function isControlEvent(message: HubEventMessage): message is HubEventControl {
  return 'type' in message && (
    message.type === 'replay_done' || message.type === 'resync_required'
  )
}

function hasCursorMetadata(event: BusEvent): event is BusEvent & EventCursor {
  return Number.isSafeInteger(event.event_id)
    && (event.event_id ?? -1) >= 0
    && typeof event.epoch === 'string'
    && event.epoch.length > 0
}

export class HubEventClient {
  private readonly transport: ManagedJsonSocket<HubEventMessage, never>
  private nextSubscriberId = 1
  private state: HubEventConnectionState = 'closed'
  private cursor?: EventCursor
  private acceptingEvents = false
  private readonly eventHandlers = new Map<number, { prefix: string; handler: EventHandler }>()
  private readonly stateHandlers = new Map<number, StateHandler>()
  private readonly controlHandlers = new Map<number, ControlHandler>()

  constructor(private readonly prefixes: readonly string[] = CONTROL_EVENT_PREFIXES) {
    this.transport = new ManagedJsonSocket({ path: () => this.connectionPath() })
    this.transport.onMessage = (message) => this.handleMessage(message)
    this.transport.onState = (state) => this.handleTransportState(state)
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

  subscribeControl(handler: ControlHandler): () => void {
    const id = this.nextSubscriberId++
    this.controlHandlers.set(id, handler)
    return () => {
      this.controlHandlers.delete(id)
    }
  }

  private connectionPath(): string {
    const query = new URLSearchParams()
    for (const prefix of this.prefixes) query.append('prefix', prefix)
    query.set('cursor', '1')
    query.set('replay', '0')
    if (this.cursor) {
      query.set('after_event_id', String(this.cursor.event_id))
      query.set('epoch', this.cursor.epoch)
    }
    return `/ws/events?${query.toString()}`
  }

  private handleMessage(message: HubEventMessage): void {
    if (!message || typeof message !== 'object') return
    if (isControlEvent(message)) {
      for (const handler of this.controlHandlers.values()) {
        try { handler(message) } catch {}
      }
      if (message.type === 'resync_required') {
        this.cursor = undefined
        this.acceptingEvents = false
        this.setState('connecting')
        return
      }
      if (
        Number.isSafeInteger(message.event_id)
        && message.event_id >= 0
        && message.epoch
      ) {
        this.advanceCursor(message.event_id, message.epoch)
        this.acceptingEvents = true
        this.setState('open')
      }
      return
    }

    if (typeof message.topic !== 'string') return
    if (hasCursorMetadata(message)) {
      if (!this.acceptingEvents && this.cursor === undefined) return
      if (!this.advanceCursor(message.event_id, message.epoch)) return
    } else if (this.transport.connectionState === 'open') {
      // Older servers have no replay barrier; their first valid frame is the
      // only available signal that the control stream is ready.
      this.acceptingEvents = true
      this.setState('open')
    }
    this.dispatch(message)
  }

  private advanceCursor(eventId: number, epoch: string): boolean {
    if (this.cursor?.epoch === epoch && eventId <= this.cursor.event_id) return false
    this.cursor = { event_id: eventId, epoch }
    return true
  }

  private dispatch(event: BusEvent): void {
    if (!event || typeof event.topic !== 'string') return
    for (const { prefix, handler } of this.eventHandlers.values()) {
      if (!event.topic.startsWith(prefix)) continue
      try { handler(event) } catch {}
    }
  }

  private handleTransportState(state: HubEventConnectionState): void {
    if (state === 'open') {
      this.acceptingEvents = this.cursor !== undefined
      return
    }
    this.acceptingEvents = false
    this.setState(state)
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
