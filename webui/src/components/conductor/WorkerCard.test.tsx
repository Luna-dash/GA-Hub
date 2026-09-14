// @vitest-environment jsdom
//
// The memo on WorkerCard is load-bearing, not decoration: the page re-renders
// on every composer keystroke, and the worker queue is the longest list on it.
// What makes it work is the SHAPE of `onSelect` — a page-level handler with a
// stable identity, with the row passing its own id back — so this file pins
// both halves: stable prop ⇒ no re-render, per-row closure ⇒ re-render.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConductorSubagent } from '@/api/types'
import { WorkerCard } from './WorkerCard'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Counted through a presentation helper WorkerCard calls on every render:
// there is no public render counter to hang this on, and a wrapper component
// would replace the memo being tested.
const spies = vi.hoisted(() => ({ briefWorkerTitle: vi.fn() }))

vi.mock('./presentation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./presentation')>()
  return {
    ...actual,
    briefWorkerTitle: (sub: ConductorSubagent) => {
      spies.briefWorkerTitle()
      return actual.briefWorkerTitle(sub)
    },
  }
})

const sub = {
  id: 'w1', request_id: 'r1', prompt: '整理目录结构', status: 'running', stage: 'running',
  attempt: 1, review_status: 'pending', created_at: 1, updated_at: 1, archived: false,
} as unknown as ConductorSubagent

describe('WorkerCard memo', () => {
  let host: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
    spies.briefWorkerTitle.mockClear()
  })

  it('renders once for its own props and again only when they change', () => {
    const stableSelect = () => {}
    let bump: () => void = () => {}

    // `unstable` reproduces the shape this component used to receive: a fresh
    // closure per row per parent render.
    function Parent({ unstable }: { unstable: boolean }) {
      const [tick, setTick] = useState(0)
      bump = () => setTick((current) => current + 1)
      return (
        <div data-tick={tick}>
          <WorkerCard sub={sub} index={1} selected={false}
            onSelect={unstable ? (() => {}) : stableSelect} />
        </div>
      )
    }

    act(() => {
      root = createRoot(host)
      root.render(<Parent unstable={false} />)
    })
    expect(spies.briefWorkerTitle).toHaveBeenCalledTimes(1)

    // Same props, new parent render (a keystroke in the composer): the row
    // must not re-render at all.
    act(() => bump())
    expect(spies.briefWorkerTitle).toHaveBeenCalledTimes(1)

    // A per-row closure fails the shallow comparison, so every parent render
    // drags the whole queue through render again.
    act(() => root!.render(<Parent unstable />))
    expect(spies.briefWorkerTitle).toHaveBeenCalledTimes(2)
    act(() => bump())
    expect(spies.briefWorkerTitle).toHaveBeenCalledTimes(3)
  })

  it('hands its own id back to the page-level handler', () => {
    const onSelect = vi.fn()
    act(() => {
      root = createRoot(host)
      root.render(<WorkerCard sub={sub} index={1} selected={false} onSelect={onSelect} />)
    })

    const toggle = host.querySelector('.conductor-worker-toggle') as HTMLButtonElement
    act(() => toggle.click())
    expect(onSelect).toHaveBeenCalledWith('w1')
  })
})
