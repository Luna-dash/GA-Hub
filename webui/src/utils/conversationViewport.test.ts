import { describe, expect, it } from 'vitest'
import { decideViewportAction } from './conversationViewport'

describe('conversation viewport policy', () => {
  it('waits until the projection is final, even when cached messages exist', () => {
    expect(decideViewportAction({
      resumePolicy: 'follow-latest',
      hydration: 'replaying',
      hasMessages: true,
    })).toBe('wait')
  })

  it('follows the latest message for a session that was running', () => {
    expect(decideViewportAction({
      resumePolicy: 'follow-latest',
      hydration: 'ready',
      hasMessages: true,
    })).toBe('follow-latest')
  })

  it('restores a normal session position after hydration', () => {
    expect(decideViewportAction({
      resumePolicy: 'restore-position',
      hydration: 'ready',
      hasMessages: true,
    })).toBe('restore-position')
  })

  it('does not land an empty projection', () => {
    expect(decideViewportAction({
      resumePolicy: 'open-latest',
      hydration: 'ready',
      hasMessages: false,
    })).toBe('wait')
  })

  it('escapes to the cached view when the projection barrier failed', () => {
    // Degraded landing: the barrier never resolved (transport down), so the
    // policy still applies instead of stranding the reader at the top.
    expect(decideViewportAction({
      resumePolicy: 'restore-position',
      hydration: 'failed',
      hasMessages: true,
    })).toBe('restore-position')

    expect(decideViewportAction({
      resumePolicy: 'follow-latest',
      hydration: 'failed',
      hasMessages: true,
    })).toBe('follow-latest')

    expect(decideViewportAction({
      resumePolicy: 'follow-latest',
      hydration: 'failed',
      hasMessages: false,
    })).toBe('wait')
  })
})
