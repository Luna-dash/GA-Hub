import type { ChatWSIn, ChatWSOut } from '@/api/types'
import { ManagedJsonSocket, type ManagedSocketState } from './managedJsonSocket'

/** Compatibility adapter for the session chat transport. */
export class ChatSocket {
  private readonly transport: ManagedJsonSocket<ChatWSOut, ChatWSIn>
  onMessage: (message: ChatWSOut) => void = () => {}
  onState: (state: ManagedSocketState) => void = () => {}

  constructor(path: string | (() => string) = '/ws/chat') {
    this.transport = new ManagedJsonSocket({ path })
    this.transport.onMessage = (message) => this.onMessage(message)
    this.transport.onState = (state) => this.onState(state)
  }

  get ws(): WebSocket | undefined {
    return this.transport.ws
  }

  open(): void {
    this.transport.open()
  }

  send(message: ChatWSIn): void {
    this.transport.send(message)
  }

  close(): void {
    this.transport.close()
  }
}
