import { resolveWsUrl } from './runtimeConfig'

export type ManagedSocketState = 'closed' | 'connecting' | 'open'

export interface ManagedJsonSocketOptions {
  /** Relative API path (or a factory re-evaluated before every reconnect). */
  path: string | (() => string)
  /** Return the delay for a failed connection attempt. */
  reconnectDelayMs?: (attempt: number) => number
  /** Injectable for deterministic transport tests. */
  createWebSocket?: (url: string) => WebSocket
}

export const DEFAULT_RECONNECT_DELAY_MS = (attempt: number): number =>
  Math.min(1_000 * Math.pow(2, attempt), 30_000)

/**
 * Small, protocol-neutral JSON WebSocket lifecycle.
 *
 * It deliberately does not queue outbound messages or interpret message
 * shapes.  Chat, control events, and GoalHive each have different replay and
 * ordering rules; this class only makes their transport lifetime safe.
 */
export class ManagedJsonSocket<TIncoming = unknown, TOutgoing = unknown> {
  ws?: WebSocket
  onMessage: (message: TIncoming) => void = () => {}
  onState: (state: ManagedSocketState) => void = () => {}

  private readonly path: string | (() => string)
  private readonly reconnectDelayMs: (attempt: number) => number
  private readonly createWebSocket: (url: string) => WebSocket
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private running = false
  private generation = 0
  private state: ManagedSocketState = 'closed'

  constructor(options: ManagedJsonSocketOptions) {
    this.path = options.path
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url))
  }

  get connectionState(): ManagedSocketState {
    return this.state
  }

  /** Start the socket; repeated calls while running are harmless. */
  open(): void {
    if (this.running) return
    this.running = true
    this.reconnectAttempts = 0
    const generation = ++this.generation
    this.connect(generation)
  }

  /** Alias used by the shared control-plane client. */
  start(): void {
    this.open()
  }

  /** Stop permanently until open/start is called again. */
  close(): void {
    if (
      !this.running
      && !this.ws
      && this.reconnectTimer === undefined
      && this.state === 'closed'
    ) return

    this.running = false
    ++this.generation
    if (this.reconnectTimer !== undefined) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const ws = this.ws
    this.ws = undefined
    this.reconnectAttempts = 0
    try { ws?.close() } catch {}
    this.setState('closed')
  }

  /** Alias used by the shared control-plane client. */
  stop(): void {
    this.close()
  }

  /**
   * Send one JSON frame if the current socket is open.
   * There is intentionally no queue: replaying a stale submit/abort/reset
   * after a reconnect would be more dangerous than dropping it.
   */
  send(value: TOutgoing): boolean {
    const ws = this.ws
    // WebSocket.OPEN is the portable browser value 1.  Keeping the numeric
    // check also makes the transport usable with tiny test doubles that do
    // not expose the static constant.
    if (!ws || ws.readyState !== 1) return false
    try {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) return false
      ws.send(encoded)
      return true
    } catch {
      return false
    }
  }

  private connect(generation: number): void {
    if (!this.running || generation !== this.generation) return
    this.setState('connecting')

    let ws: WebSocket
    try {
      const path = typeof this.path === 'function' ? this.path() : this.path
      ws = this.createWebSocket(resolveWsUrl(path))
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
    ws.onmessage = (event) => {
      if (!this.isCurrent(ws, generation) || typeof event.data !== 'string') return
      let message: TIncoming
      try {
        message = JSON.parse(event.data) as TIncoming
      } catch {
        return
      }
      try { this.onMessage(message) } catch {}
    }
    ws.onclose = () => {
      this.handleDisconnect(ws, generation)
    }
    ws.onerror = () => {
      // Some test doubles and broken browser implementations do not emit a
      // close event after error. Invalidate first, then close, so either path
      // schedules exactly one reconnect.
      this.handleDisconnect(ws, generation)
    }
  }

  private handleDisconnect(ws: WebSocket, generation: number): void {
    if (!this.isCurrent(ws, generation)) return
    this.ws = undefined
    try { ws.close() } catch {}
    this.setState('closed')
    this.scheduleReconnect(generation)
  }

  private isCurrent(ws: WebSocket, generation: number): boolean {
    return this.running && generation === this.generation && this.ws === ws
  }

  private scheduleReconnect(generation: number): void {
    if (!this.running || generation !== this.generation || this.reconnectTimer !== undefined) return
    let delay: number
    try {
      delay = Math.max(0, this.reconnectDelayMs(this.reconnectAttempts))
    } catch {
      delay = DEFAULT_RECONNECT_DELAY_MS(this.reconnectAttempts)
    }
    this.reconnectAttempts++
    this.setState('closed')
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect(generation)
    }, delay)
  }

  private setState(state: ManagedSocketState): void {
    if (this.state === state) return
    this.state = state
    try { this.onState(state) } catch {}
  }
}
