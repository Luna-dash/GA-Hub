// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntiTaskProgress } from './AntiTaskProgress'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  private listeners = new Map<string, EventListener[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) })
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }

  close() {
    this.closed = true
  }
}

describe('AntiTaskProgress SSE stability', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  const originalEventSource = globalThis.EventSource

  beforeEach(() => {
    FakeEventSource.instances = []
    ;(globalThis as unknown as { EventSource: typeof FakeEventSource }).EventSource = FakeEventSource
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    client.clear()
    globalThis.EventSource = originalEventSource
  })

  it('keeps a single EventSource across parent re-renders with inline callbacks and calls the latest handler', async () => {
    const approvals: number[] = []
    let bumpParent!: () => void

    function Parent() {
      const [tick, setTick] = useState(0)
      bumpParent = () => setTick((v) => v + 1)
      return (
        <AntiTaskProgress
          active
          runKey="sid-1/run-1"
          streamUrl="/api/anti/sessions/sid-1/runs/run-1/events/stream"
          loadEvents={() => Promise.resolve([])}
          onEventsChanged={() => { /* fresh inline fn each render */ void tick }}
          onApprovalRequested={() => { approvals.push(tick) }}
        >
          {(partial) => <output>{partial}</output>}
        </AntiTaskProgress>
      )
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Parent />
        </QueryClientProvider>,
      )
    })

    expect(FakeEventSource.instances).toHaveLength(1)
    const source = FakeEventSource.instances[0]
    act(() => {
      source.onopen?.()
      source.emit('message.delta', { seq: 1, type: 'message.delta', text: '流式片段A' })
    })
    expect(host.querySelector('output')?.textContent).toBe('流式片段A')

    // Re-rendering Parent multiple times (e.g. typing/scrolling/polling) must NOT close or reset SSE!
    act(() => {
      bumpParent()
      bumpParent()
    })
    expect(FakeEventSource.instances).toHaveLength(1)
    expect(source.closed).toBe(false)
    expect(host.querySelector('output')?.textContent).toBe('流式片段A')

    act(() => {
      source.emit('approval.requested', { seq: 0, type: 'approval.requested' })
    })
    expect(approvals).toEqual([2])
  })
})
