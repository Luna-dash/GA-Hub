// @vitest-environment jsdom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VirtualMessageList, type VirtualMessageListHandle } from './VirtualMessageList'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const items = Array.from({ length: 100 }, (_, index) => `message-${index}`)

describe('VirtualMessageList', () => {
  let host: HTMLDivElement
  let root: Root
  let handle: VirtualMessageListHandle | null

  beforeEach(() => {
    handle = null
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  function Harness() {
    const scrollRef = useRef<HTMLDivElement>(null)
    return (
      <div ref={scrollRef}>
        <VirtualMessageList
          ref={(value) => { handle = value }}
          items={items}
          scrollRef={scrollRef}
          virtualizationThreshold={5}
          overscanPx={0}
          itemKey={(item) => item}
          estimateSize={() => 100}
          renderItem={(item) => <div>{item}</div>}
        />
      </div>
    )
  }

  it('keeps the logical transcript while mounting only the visible window', () => {
    act(() => root.render(<Harness />))

    const list = host.querySelector('[data-chat-virtual-list]') as HTMLElement
    expect(list.dataset.virtualized).toBe('true')
    expect(list.dataset.totalCount).toBe('100')
    expect(Number(list.dataset.renderedCount)).toBeLessThan(10)
    expect(host.querySelectorAll('[data-chat-message]').length).toBeLessThan(10)
    expect(list.style.height).toBe('10000px')
  })

  it.each([false, true])('omits trailing row spacing with virtualization=%s', (virtualized) => {
    function TailHarness() {
      const scrollRef = useRef<HTMLDivElement>(null)
      return (
        <div ref={scrollRef}>
          <VirtualMessageList
            items={['first', 'last']}
            scrollRef={scrollRef}
            virtualizationThreshold={virtualized ? 0 : 80}
            itemKey={(item) => item}
            estimateSize={() => 100}
            renderItem={(item) => <div>{item}</div>}
          />
        </div>
      )
    }
    act(() => root.render(<TailHarness />))
    const rows = host.querySelectorAll<HTMLElement>('[data-chat-message]')
    expect(rows).toHaveLength(2)
    expect(rows[0].style.paddingBottom).toBe('0.5rem')
    expect(rows[1].style.paddingBottom).toBe('0px')
    expect(host.querySelector<HTMLElement>('[data-chat-virtual-list]')?.dataset.virtualized).toBe(String(virtualized))
  })

  it('can navigate to an unmounted message using the estimated layout', () => {
    act(() => root.render(<Harness />))
    const scroller = host.firstElementChild as HTMLDivElement
    Object.defineProperty(scroller, 'scrollTo', { value: undefined, configurable: true })

    act(() => handle?.scrollToIndex(50, { behavior: 'auto' }))

    expect(scroller.scrollTop).toBe(4_984)
  })
})
