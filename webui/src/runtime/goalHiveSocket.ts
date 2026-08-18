import type { GoalHiveMessage } from '@/stores/goalhiveStore'
import {
  ManagedJsonSocket,
  type ManagedJsonSocketOptions,
  type ManagedSocketState,
} from './managedJsonSocket'

export type GoalHiveCommand =
  | {
      type: 'submit'
      text: string
      mode: 'goal' | 'hive'
      llm_index: number | null
      subagent_llm_index: number | null
    }
  | { type: 'abort' }
  | { type: 'reset' }

type GoalHiveFrame = {
  type?: unknown
  messages?: unknown
}

type GoalHiveSocketOptions = Pick<ManagedJsonSocketOptions, 'createWebSocket'>

/** GoalHive protocol adapter over the shared managed JSON transport. */
export class GoalHiveSocket {
  private readonly transport: ManagedJsonSocket<unknown, GoalHiveCommand>
  onMessages: (messages: GoalHiveMessage[]) => void = () => {}
  onState: (state: ManagedSocketState) => void = () => {}

  constructor(options: GoalHiveSocketOptions = {}) {
    this.transport = new ManagedJsonSocket({
      path: '/ws/goalhive',
      // Preserve GoalHive's existing fixed two-second reconnect cadence.
      reconnectDelayMs: () => 2_000,
      createWebSocket: options.createWebSocket,
    })
    this.transport.onMessage = (message) => this.handleMessage(message)
    this.transport.onState = (state) => this.onState(state)
  }

  get ws(): WebSocket | undefined {
    return this.transport.ws
  }

  open(): void {
    this.transport.open()
  }

  close(): void {
    this.transport.close()
  }

  send(command: GoalHiveCommand): boolean {
    return this.transport.send(command)
  }

  private handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const frame = message as GoalHiveFrame
    if (frame.type !== 'snapshot' && frame.type !== 'update') return
    this.onMessages(Array.isArray(frame.messages) ? frame.messages as GoalHiveMessage[] : [])
  }
}
