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

  function Harness({ rows = items, threshold = 5, overscan = 0 }: { rows?: string[]; threshold?: number; overscan?: number } = {}) {
    const scrollRef = useRef<HTMLDivElement>(null)
    return (
      <div ref={scrollRef}>
        <VirtualMessageList
          ref={(value) => { handle = value }}
          items={rows}
          scrollRef={scrollRef}
          virtualizationThreshold={threshold}
          overscanPx={overscan}
          itemKey={(item) => item}
          estimateSize={() => 100}
          renderItem={(item) => <div>{item}</div>}
        />
      </div>
    )
  }

  it('retains the visible key and offset when a large prepend turns on virtualization', () => {
    const prior = items.slice(60, 65)
    const resized = items.slice(0, 65)
    // jsdom doesn't lay out rows: model both normal-flow and absolute positions.
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect
    const getRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatKey) {
        const top = this.style.position === 'absolute' ? Number.parseFloat(this.style.top) : Number(this.dataset.virtualIndex) * 100
        return rect(top - (host.firstElementChild as HTMLElement).scrollTop, this.dataset.chatKey === items[59] ? 140 : 100)
      }
      return rect(0, 640)
    })
    try {
      act(() => root.render(<Harness rows={prior} threshold={80} />))
      const scroller = host.firstElementChild as HTMLElement
      Object.defineProperty(scroller, 'clientHeight', { value: 640 })
      scroller.scrollTop = 35
      expect(handle?.prepareForPrepend()).toBe(true)
      act(() => root.render(<Harness rows={resized} threshold={80} overscan={120} />))
      const list = host.querySelector<HTMLElement>('[data-chat-virtual-list]')!
      const oldRow = list.querySelector<HTMLElement>(`[data-chat-key="${prior[0]}"]`)
      expect(list.dataset.virtualized).toBe('true')
      expect(Number(list.dataset.renderedCount)).toBeLessThan(15)
      expect(oldRow?.getBoundingClientRect().top).toBe(-35)
      expect(scroller.scrollTop).toBe(6075)
    } finally {
      getRect.mockRestore()
    }
  })

  it('reserves scroll space when a short prepend would otherwise clamp the anchor', () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height }) as DOMRect
    act(() => root.render(<Harness rows={items.slice(1, 3)} threshold={80} />))
    const scroller = host.firstElementChild as HTMLElement
    const spacer = scroller.lastElementChild as HTMLElement
    const naturalHeight = () => scroller.querySelectorAll('[data-chat-message]').length * 100
    let scrollTop = 0
    Object.defineProperties(scroller, {
      clientHeight: { value: 640 },
      scrollTop: {
        get: () => scrollTop,
        set: (top: number) => {
          scrollTop = Math.max(0, Math.min(top, naturalHeight() + (parseFloat(spacer.style.height) || 0) - 640))
        },
      },
    })
    const getRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === spacer) return rect(naturalHeight() - scrollTop, parseFloat(spacer.style.height) || 0)
      if (this.dataset.chatKey) return rect(Number(this.dataset.virtualIndex) * 100 - scrollTop, 100)
      return rect(0, 640)
    })
    try {
      expect(handle?.prepareForPrepend()).toBe(true)
      act(() => root.render(<Harness rows={items.slice(0, 3)} threshold={80} />))
      expect(scroller.scrollTop).toBe(100)
      expect(spacer.style.height).toBe('440px')
      expect(scroller.querySelector('[data-virtual-index="1"]')?.getBoundingClientRect().top).toBe(0)
    } finally {
      getRect.mockRestore()
    }
  })

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

  it('downgrades smooth jump to auto for far unmounted rows and pauses above-viewport jolt compensation', () => {
    const callbacks: Array<() => void> = []
    class FakeResizeObserver {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    act(() => root.render(<Harness rows={items} threshold={5} overscan={0} />))
    const scroller = host.firstElementChild as HTMLDivElement
    const scrollToSpy = vi.fn((opts: { top?: number }) => {
      if (typeof opts?.top === 'number') scroller.scrollTop = opts.top
    })
    Object.defineProperty(scroller, 'scrollTo', { value: scrollToSpy, configurable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true })

    act(() => handle?.scrollToIndex(80, { behavior: 'smooth', align: 'start' }))
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 7_984, behavior: 'auto' })

    // Triggering a row resize above the active target must not jolt scrollTop.
    const row0 = host.querySelector<HTMLElement>('[data-virtual-index="0"]')
    if (row0) Object.defineProperty(row0, 'offsetHeight', { value: 180, configurable: true })
    const before = scroller.scrollTop
    act(() => callbacks.forEach((cb) => cb()))
    expect(scroller.scrollTop).toBe(before)
  })

  it('mounts unmounted tail rows and re-pins to the true bottom in one scrollToIndex click', () => {
    const callbacks: Array<() => void> = []
    class FakeResizeObserver {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    act(() => root.render(<Harness rows={items} threshold={5} overscan={200} />))
    const scroller = host.firstElementChild as HTMLDivElement
    const list = host.querySelector<HTMLElement>('[data-chat-virtual-list]')!
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(scroller, 'scrollHeight', {
      get: () => Number.parseFloat(list.style.height || '0'),
      configurable: true,
    })
    Object.defineProperty(scroller, 'scrollTo', { value: undefined, configurable: true })

    act(() => handle?.scrollToIndex(items.length - 1, { behavior: 'auto', align: 'end' }))
    expect(host.querySelector('[data-virtual-index="99"]')).not.toBeNull()
    expect(scroller.scrollTop).toBe(10_000)

    // Simulate mounted tail rows measuring much taller than their 100px estimate.
    for (let idx = 95; idx < 100; idx += 1) {
      const row = host.querySelector<HTMLElement>(`[data-virtual-index="${idx}"]`)
      if (row) Object.defineProperty(row, 'offsetHeight', { value: 260, configurable: true })
    }
    act(() => callbacks.forEach((cb) => cb()))
    expect(scroller.scrollTop).toBe(10_800)
  })
})
