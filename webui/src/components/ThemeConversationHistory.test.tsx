import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { SessionMessagesResponse } from '@/api/types'
import { ThemeConversationHistory } from './ThemeConversationHistory'

vi.mock('@/api/client', () => ({ api: { getSessionMessages: vi.fn() } }))
vi.mock('@/runtime/chatSocket', () => ({ ChatSocket: class { open() {} close() {} } }))
vi.mock('./MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <div data-conclusion>{content}</div> }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('theme archive conclusions', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it.each([null, 'archive-run'])('uses the final trusted turn with run_id=%s', async runId => {
    const turns = ['Intermediate prose, not the conclusion.\n', 'Final answer.']
    vi.mocked(api.getSessionMessages).mockResolvedValue({
      items: [
        { id: 'question', ordinal: 0, role: 'user', content: 'Question' },
        { id: 'answer', ordinal: 1, role: 'assistant', content: turns.join(''), turn_segs: turns, run_id: runId },
      ],
      total: 2, has_more: false, next_before: null,
    } as unknown as SessionMessagesResponse)
    await act(async () => { root.render(<ThemeConversationHistory sessionId="synthetic" enabled />) })
    expect(host.querySelector('[data-conclusion]')?.textContent).toBe('Final answer.')
    expect(host.textContent).not.toContain('Intermediate prose')
  })
})
