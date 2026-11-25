// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'

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

  it('hides step diffs, tightens thought paragraphs, and deduplicates redundant file-action details', async () => {
    const events: AntiEvent[] = [
      { seq: 1, type: 'step.update', step: { index: 1, kind: 'thought', state: 'DONE', text_delta: '第一段\n\n\n第二段' } },
      {
        seq: 2,
        type: 'step.update',
        step: {
          index: 2,
          kind: 'tool_call',
          tool: 'Edit D:\\demo\\app.tsx',
          state: 'DONE',
          detail: 'D:\\demo\\app.tsx',
          diff: '--- a/app.tsx\n+++ b/app.tsx\n@@ -1 +1 @@\n-old line\n+new line',
        },
      },
      {
        seq: 3,
        type: 'step.update',
        step: {
          index: 3,
          kind: 'tool_call',
          tool: 'Edit app.tsx',
          state: 'DONE',
          detail: 'D:\\demo\\app.tsx',
        },
      },
      {
        seq: 4,
        type: 'step.update',
        step: {
          index: 4,
          kind: 'tool_call',
          tool: 'replace_file_content',
          state: 'DONE',
          detail: 'D:/demo/other.ts',
        },
      },
      {
        seq: 5,
        type: 'step.update',
        step: {
          index: 5,
          kind: 'tool_call',
          tool: 'run_command',
          state: 'DONE',
          command: 'npm test',
          output: 'all passed',
        },
      },
    ]

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiTaskProgress
            active={false}
            runKey="sid-1/run-clean"
            loadEvents={() => Promise.resolve(events)}
            onEventsChanged={() => {}}
          >
            {() => <div data-testid="reply">完成</div>}
          </AntiTaskProgress>
        </QueryClientProvider>,
      )
    })

    const details = host.querySelector('details')!
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })
    await vi.waitFor(() => {
      expect(host.querySelectorAll('ol li')).toHaveLength(5)
    })

    expect(host.textContent).not.toContain('-old line')
    expect(host.textContent).not.toContain('+new line')
    expect(host.textContent).not.toContain('@@ -1 +1 @@')
    expect(host.textContent).toContain('all passed')

    const thoughtDesc = host.querySelector('[data-step-description]')!
    expect(thoughtDesc.className).toContain('space-y-1')
    expect(thoughtDesc.className).toContain('leading-snug')
    const paragraphs = thoughtDesc.querySelectorAll('p')
    expect(paragraphs).toHaveLength(2)
    expect(paragraphs[0].textContent).toBe('第一段')
    expect(paragraphs[1].textContent).toBe('第二段')

    const detailRows = host.querySelectorAll('[data-step-detail]')
    expect(detailRows).toHaveLength(1)
    expect(detailRows[0].textContent).toBe('D:/demo/other.ts')

    const steps = host.querySelectorAll('ol li')
    expect(steps[1].querySelector('span')?.getAttribute('title')).toBe('D:\\demo\\app.tsx')
    expect(steps[2].querySelector('span')?.getAttribute('title')).toBe('D:\\demo\\app.tsx')
  })

  it('splits live message.delta segments into progressMessages and trailing partial without demoting on late tool updates', async () => {
    const events: AntiEvent[] = [
      { seq: 1, type: 'message.delta', text: '第一段阶段说明', step: { index: 0, kind: 'agent_response', state: 'ACTIVE' } },
      { seq: 2, type: 'step.update', step: { index: 1, kind: 'tool_call', tool: 'view_file', state: 'ACTIVE' } },
      { seq: 3, type: 'message.delta', text: '第二段', step: { index: 2, kind: 'agent_response', state: 'ACTIVE' } },
      { seq: 4, type: 'message.delta', text: '阶段输出', step: { index: 2, kind: 'agent_response', state: 'ACTIVE' } },
      { seq: 5, type: 'step.update', step: { index: 3, kind: 'thought', state: 'ACTIVE', text_delta: '整理思路' } },
      { seq: 6, type: 'message.delta', text: '最终结论正文', step: { index: 4, kind: 'agent_response', state: 'ACTIVE' } },
      { seq: 7, type: 'step.update', step: { index: 1, kind: 'tool_call', state: 'DONE' } },
    ]

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiTaskProgress
            active
            runKey="sid-1/run-split"
            loadEvents={() => Promise.resolve(events)}
            onEventsChanged={() => {}}
          >
            {(partial, progressMessages) => (
              <div>
                <ul data-testid="progress">{progressMessages.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
                <div data-testid="final">{partial}</div>
              </div>
            )}
          </AntiTaskProgress>
        </QueryClientProvider>,
      )
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="final"]')?.textContent).toBe('最终结论正文')
    })
    const items = [...host.querySelectorAll('[data-testid="progress"] li')].map(el => el.textContent)
    expect(items).toEqual(['第一段阶段说明', '第二段阶段输出'])
  })

  it('splits pre-steer output on user_steer and flags active terminal output as streaming', async () => {
    const events: AntiEvent[] = [
      { seq: 1, type: 'message.delta', text: '纠偏前汇报', step: { index: 0, kind: 'agent_response', state: 'ACTIVE' } },
      { seq: 2, type: 'step.update', step: { index: 1, kind: 'user_steer', state: 'DONE', tool: 'user_steer', detail: '请只改 backend', text_delta: '请只改 backend' } },
      { seq: 3, type: 'step.update', step: { index: 2, kind: 'tool_call', tool: 'run_command', state: 'ACTIVE', command: 'pytest', output: 'line1\nline2\n' } },
      { seq: 4, type: 'message.delta', text: '纠偏后结论', step: { index: 3, kind: 'agent_response', state: 'ACTIVE' } },
    ]

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <AntiTaskProgress
            active
            runKey="sid-1/run-steer"
            loadEvents={() => Promise.resolve(events)}
            onEventsChanged={() => {}}
          >
            {(partial, progressMessages) => (
              <div>
                <ul data-testid="progress">{progressMessages.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
                <div data-testid="final">{partial}</div>
              </div>
            )}
          </AntiTaskProgress>
        </QueryClientProvider>,
      )
    })

    const details = host.querySelector('details')!
    await act(async () => {
      details.open = true
      details.dispatchEvent(new Event('toggle'))
    })

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="final"]')?.textContent).toBe('纠偏后结论')
    })
    expect([...host.querySelectorAll('[data-testid="progress"] li')].map(el => el.textContent)).toEqual(['纠偏前汇报'])
    const steerItem = host.querySelector('li[data-step-kind="user_steer"]')
    expect(steerItem?.textContent).toContain('运行中插话纠偏')
    expect(steerItem?.textContent).toContain('请只改 backend')
    expect(host.querySelector('[data-live-terminal-output="streaming"]')?.textContent).toContain('line2')
    expect(host.textContent).toContain('实时输出')
  })
})
