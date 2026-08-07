// @vitest-environment jsdom

import { act, useCallback, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { markdownRender } = vi.hoisted(() => ({
  markdownRender: vi.fn(({ children }: { children?: string }) => <div>{children}</div>),
}))

vi.mock('./MarkdownView', () => ({
  MarkdownView: markdownRender,
}))

import { MessageBubble } from './MessageBubble'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function Harness() {
  const [unrelated, setUnrelated] = useState(0)
  return (
    <div>
      <button onClick={() => setUnrelated((value) => value + 1)}>refresh {unrelated}</button>
      <MessageBubble role="assistant" content="stable old message" streaming={false} />
    </div>
  )
}

function StreamingSiblingHarness() {
  const [chunk, setChunk] = useState('first chunk')
  const rewind = useCallback(() => undefined, [])
  return (
    <div>
      <button onClick={() => setChunk('first chunk plus second chunk')}>append chunk</button>
      <MessageBubble role="assistant" content="completed history" streaming={false} onRewind={rewind} />
      <MessageBubble role="assistant" content={chunk} streaming onRewind={rewind} />
    </div>
  )
}

describe('MessageBubble render isolation', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    markdownRender.mockClear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('does not rebuild a static markdown subtree for an unrelated parent update', () => {
    act(() => root.render(<Harness />))
    expect(markdownRender).toHaveBeenCalledTimes(1)

    act(() => (host.querySelector('button') as HTMLButtonElement).click())

    expect(host.textContent).toContain('refresh 1')
    expect(markdownRender).toHaveBeenCalledTimes(1)
  })

  it('only rebuilds the active bubble when a streaming sibling receives a chunk', () => {
    act(() => root.render(<StreamingSiblingHarness />))
    expect(markdownRender).toHaveBeenCalledTimes(2)

    act(() => (host.querySelector('button') as HTMLButtonElement).click())

    expect(host.textContent).toContain('first chunk plus second chunk')
    expect(markdownRender).toHaveBeenCalledTimes(3)
    expect(markdownRender.mock.calls.filter(([props]) => props.children === 'completed history')).toHaveLength(1)
  })
})
