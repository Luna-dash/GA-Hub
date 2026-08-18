import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  agentStatus: vi.fn(),
  subscribe: vi.fn(),
  subscribeState: vi.fn(),
  unsubscribe: vi.fn(),
  unsubscribeState: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: { agentStatus: mocks.agentStatus },
}))

vi.mock('@/runtime/hubEventClient', () => ({
  hubEventClient: {
    subscribe: mocks.subscribe,
    subscribeState: mocks.subscribeState,
  },
}))

import { useAgentStore } from './agentStore'

describe('agentStore event refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.agentStatus.mockResolvedValue({ running: false })
    mocks.subscribe.mockReturnValue(mocks.unsubscribe)
    mocks.subscribeState.mockImplementation((handler) => {
      handler('closed')
      return mocks.unsubscribeState
    })
  })

  afterEach(() => {
    useAgentStore.getState().stop()
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('subscribes once and coalesces an event burst into one status request', async () => {
    useAgentStore.getState().start()
    useAgentStore.getState().start()
    expect(mocks.subscribe).toHaveBeenCalledTimes(1)
    expect(mocks.subscribe).toHaveBeenCalledWith('agent:', expect.any(Function))
    expect(mocks.subscribeState).toHaveBeenCalledTimes(1)
    expect(mocks.agentStatus).toHaveBeenCalledTimes(1)
    const onHubState = mocks.subscribeState.mock.calls[0][0]
    onHubState('open')
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.agentStatus).toHaveBeenCalledTimes(2)

    const onAgentEvent = mocks.subscribe.mock.calls[0][1]
    onAgentEvent()
    onAgentEvent()
    onAgentEvent()
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(100)
    expect(mocks.agentStatus).toHaveBeenCalledTimes(3)
  })

  it('unsubscribes and cancels a queued refresh on stop', async () => {
    useAgentStore.getState().start()
    const onAgentEvent = mocks.subscribe.mock.calls[0][1]
    onAgentEvent()

    useAgentStore.getState().stop()
    await vi.advanceTimersByTimeAsync(100)

    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
    expect(mocks.unsubscribeState).toHaveBeenCalledTimes(1)
    expect(mocks.agentStatus).toHaveBeenCalledTimes(1)
  })

  it('refreshes the authoritative status after every reconnect', async () => {
    useAgentStore.getState().start()
    const onHubState = mocks.subscribeState.mock.calls[0][0]

    onHubState('open')
    await vi.advanceTimersByTimeAsync(0)
    onHubState('closed')
    onHubState('open')
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.agentStatus).toHaveBeenCalledTimes(3)
  })
})
