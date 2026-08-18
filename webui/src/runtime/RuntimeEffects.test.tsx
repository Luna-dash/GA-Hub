// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeEffects } from './RuntimeEffects'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  subscribeState: vi.fn(),
}))

vi.mock('@/runtime/hubEventClient', () => ({
  hubEventClient: {
    subscribeState: mocks.subscribeState,
  },
}))

vi.mock('@/utils/useDesktopNotifyEffects', () => ({
  useDesktopNotifyEffects: vi.fn(),
}))

vi.mock('@/utils/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}))

describe('RuntimeEffects', () => {
  let root: Root | undefined
  let host: HTMLDivElement

  beforeEach(() => {
    mocks.subscribeState.mockReset()
    mocks.subscribeState.mockImplementation(() => () => {})
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  it('refreshes active queries once after a reconnect, not on the initial open', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries').mockResolvedValue(undefined)
    const mountedRoot = createRoot(host)
    root = mountedRoot
    act(() => mountedRoot.render(
      <QueryClientProvider client={queryClient}>
        <RuntimeEffects />
      </QueryClientProvider>,
    ))

    const onState = mocks.subscribeState.mock.calls[0][0] as (state: string) => void
    onState('connecting')
    onState('open')
    expect(invalidate).not.toHaveBeenCalled()

    onState('closed')
    onState('connecting')
    onState('open')
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' })
  })
})
