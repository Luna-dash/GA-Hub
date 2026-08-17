// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  collectChatPerformanceSample,
  publishChatPerformanceSample,
  type ChatPerformanceBuffer,
} from './chatPerformance'

describe('chat performance probe', () => {
  it('captures the rendered window instead of reporting all logical messages as DOM rows', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <div data-chat-virtual-list data-virtualized="true">
        <div data-chat-message><span>one</span></div>
        <div data-chat-message><span>two</span></div>
      </div>
    `
    const sample = collectChatPerformanceSample(root, {
      sessionId: 'session-a',
      historyStatus: 'ready',
      totalMessages: 120,
      totalCharacters: 42_000,
      streaming: false,
      readyMs: 18,
    })

    expect(sample).toMatchObject({
      sessionId: 'session-a',
      totalMessages: 120,
      renderedMessages: 2,
      virtualized: true,
      readyMs: 18,
    })
    expect(sample.domNodes).toBe(5)
  })

  it('keeps a bounded global sample buffer', () => {
    window.__GA_HUB_PERF__ = undefined
    for (let index = 0; index < 100; index += 1) {
      publishChatPerformanceSample({
        at: index,
        sessionId: null,
        historyStatus: 'ready',
        totalMessages: index,
        renderedMessages: 0,
        totalCharacters: 0,
        domNodes: 0,
        virtualized: false,
        streaming: false,
        readyMs: null,
        heapBytes: null,
      })
    }

    const buffer = window.__GA_HUB_PERF__ as ChatPerformanceBuffer | undefined
    expect(buffer?.samples).toHaveLength(80)
    expect(buffer?.latest?.totalMessages).toBe(99)
  })
})
