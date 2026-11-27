// @vitest-environment jsdom
import { act, createRef, forwardRef, useImperativeHandle } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore, type ChatMsg } from '@/stores/chatStore'
import { readPageState, resetPageState, writePageState } from '@/utils/pageState'
import { markProgrammaticScroll } from '@/utils/programmaticScroll'
import { LiveChatTranscript, type LiveChatTranscriptHandle } from './LiveChatTranscript'

const layout = vi.hoisted(() => ({ first: 2, scrollToIndex: vi.fn() }))
vi.mock('./MessageBubble', () => ({ MessageBubble: () => null }))
vi.mock('./ConversationCollapse', () => ({
  ConversationCollapseProvider: ({ children }: any) => children,
  ConversationCollapseControl: () => null,
}))
vi.mock('./VirtualMessageList', () => ({
  VirtualMessageList: forwardRef(function List(_props, ref) {
    useImperativeHandle(ref, () => ({
      prepareForPrepend: () => false,
      hasPrependAnchor: () => false,
      releasePrependAnchor: () => {},
      scrollToIndex: layout.scrollToIndex,
      getFirstVisibleIndex: () => layout.first,
    }))
    return null
  }),
}))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const messages: ChatMsg[] = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 ? 'assistant' : 'user', content: `message ${i}`,
  runId: `r${Math.floor(i / 2)}`, streamId: `m${i}`,
}))
const key = (i: number) => `r${Math.floor(i / 2)}:${i % 2 ? 'assistant' : 'user'}:m${i}`
type Position = { key: string; stuck: boolean }
const saved = () => readPageState<Record<string, Position>>('liveChat.scrollPositions', {})

describe('LiveChatTranscript reading intent', () => {
  let host: HTMLDivElement
  let root: Root
  const handle = createRef<LiveChatTranscriptHandle>()
  let frames: FrameRequestCallback[]
  function flushFrames() {
    act(() => {
      // Run only the currently queued batch, preserving browser frame boundaries.
      const current = frames.splice(0)
      current.forEach((callback) => callback(performance.now()))
    })
  }
  function mount(session = 'A', ready = true, policy: 'restore-position' | 'follow-latest' = 'restore-position') {
    act(() => {
      useChatStore.setState({ sessionId: session, msgs: messages, streaming: false,
        resumePolicy: policy, projectionReady: ready, historyStatus: 'ready',
        historyHasMore: false, olderHistoryStatus: 'idle' })
      root.render(<LiveChatTranscript key={session} ref={handle} sessionId={session}
        sessionError="" scheduledChats={[]} scheduleNow={0}
        onCancelSchedule={() => {}} onRewind={() => {}} />)
    })
    const el = host.querySelector('[data-live-chat-scroll]') as HTMLDivElement
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 4000 },
      clientHeight: { configurable: true, value: 500 },
    })
    el.scrollTo = vi.fn()
    return el
  }
  function click(label: string) {
    const button = [...host.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.includes(label) || b.textContent?.includes(label))!
    expect(button).toBeTruthy()
    expect(button.textContent?.trim()).toBe('')
    act(() => button.click())
  }
  beforeEach(() => {
    vi.useFakeTimers()
    resetPageState()
    layout.first = 2
    layout.scrollToIndex.mockReset()
    frames = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    // Consume fresh-launch landing before seeding a returning reader's position.
    mount('warmup')
    act(() => root.render(null))
    frames = []
    writePageState('liveChat.scrollPositions', { A: { key: key(2), stuck: false } })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows the remaining time on the animated clock without opening details', () => {
    const task = {
      id: 'task-1', session_id: 'A', text: 'send later', images: [],
      scheduled_for: 180, created_at: 0, status: 'pending' as const,
      sent_at: null, cancelled_at: null, last_error: null, retry_at: null,
    }
    const onCancelSchedule = vi.fn()
    const renderAt = (scheduleNow: number) => act(() => root.render(
      <LiveChatTranscript sessionId="A" sessionError="" scheduledChats={[task]} scheduleNow={scheduleNow}
        onCancelSchedule={onCancelSchedule} onRewind={() => {}} />,
    ))

    renderAt(0)
    const button = host.querySelector<HTMLButtonElement>('[aria-label="待发送定时消息"] button')!
    expect(button.textContent?.trim()).toBe('3分')
    expect(button.querySelector('[data-schedule-clock] [data-schedule-flow-border]')).not.toBeNull()
    expect(host.querySelector('[data-schedule-tooltip]')).toBeNull()

    renderAt(60_000)
    expect(button.textContent?.trim()).toBe('2分')
    expect(button.getAttribute('aria-label')).toContain('2分后发送')
    act(() => button.click())
    expect(onCancelSchedule).toHaveBeenCalledWith(task)
  })

  it('saves button-to-tail immediately and restores the bottom after switching mid-scroll', () => {
    mount()
    click('跳到底部')
    expect(saved().A).toEqual({ key: key(7), stuck: true })
    mount('B')
    mount('A')
    flushFrames(); flushFrames()
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(7, { behavior: 'auto', align: 'end' })
    expect(saved().A.stuck).toBe(true)
  })

  it('send pinning invalidates pending anchor verification and persists follow-tail', () => {
    mount()
    layout.scrollToIndex.mockClear()
    act(() => handle.current!.pinToBottom())
    flushFrames(); flushFrames()
    act(() => vi.advanceTimersByTime(1600))
    expect(layout.scrollToIndex).not.toHaveBeenCalled()
    expect(saved().A).toEqual({ key: key(7), stuck: true })
  })

  it('saves section navigation synchronously and cancels old restoration', () => {
    mount()
    click('上一节')
    const destination = saved().A
    expect(destination.stuck).toBe(false)
    expect(destination.key).not.toBe(key(2))
    const calls = layout.scrollToIndex.mock.calls.length
    flushFrames(); flushFrames()
    act(() => vi.advanceTimersByTime(1600))
    expect(layout.scrollToIndex).toHaveBeenCalledTimes(calls)
    mount('B'); mount('A')
    const index = messages.findIndex((_, i) => key(i) === destination.key)
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(index, { behavior: 'auto', align: 'start' })
  })

  it('keeps genuine historical reading and ignores later internal scrolling', () => {
    const el = mount()
    act(() => el.dispatchEvent(new Event('wheel')))
    act(() => el.dispatchEvent(new Event('scroll')))
    flushFrames()
    expect(saved().A).toEqual({ key: key(2), stuck: false })
    layout.first = 6
    markProgrammaticScroll()
    act(() => el.dispatchEvent(new Event('scroll')))
    flushFrames()
    expect(saved().A.key).toBe(key(2))
    mount('B'); mount('A')
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(2, { behavior: 'auto', align: 'start' })
  })

  it('does not let a late projection landing undo an explicit navigation', () => {
    mount('A', false)
    act(() => handle.current!.pinToBottom())
    layout.scrollToIndex.mockClear()
    act(() => useChatStore.setState({ projectionReady: true }))
    flushFrames(); flushFrames()
    expect(layout.scrollToIndex).not.toHaveBeenCalled()
    expect(saved().A.stuck).toBe(true)
  })

  it('follow-latest ignores the older saved anchor and lands at the tail', () => {
    mount('A', true, 'follow-latest')
    flushFrames(); flushFrames()
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(7, { behavior: 'auto', align: 'end' })
  })

  it('does not show the empty-state welcome alongside a session initialization error', () => {
    act(() => {
      useChatStore.setState({
        sessionId: null,
        msgs: [],
        streaming: false,
        projectionReady: false,
        historyStatus: 'idle',
      })
      root.render(<LiveChatTranscript sessionId={null}
        sessionError="network error" scheduledChats={[]} scheduleNow={0}
        onCancelSchedule={() => {}} onRewind={() => {}} />)
    })
    expect(host.textContent).toContain('会话初始化失败：network error')
    expect(host.textContent).not.toContain('开始一段对话')
  })

  it('renders the multi-turn minimap selector and jumps to the clicked round', () => {
    mount()
    const minimapButtons = host.querySelectorAll<HTMLButtonElement>('[aria-label="多轮会话选择器"] button')
    expect(minimapButtons).toHaveLength(4)
    minimapButtons.forEach((button) => {
      expect(button.className).toContain('h-4')
    })
    act(() => minimapButtons[0].click())
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(0, { behavior: 'smooth', align: 'start' })
    expect(saved().A).toEqual({ key: key(0), stuck: false })
  })

  it('steps across multiple turns on rapid prev clicks without stale activeTurn', () => {
    const el = mount()
    Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: 500 })
    layout.first = 6
    act(() => {
      el.dispatchEvent(new Event('wheel'))
      el.dispatchEvent(new Event('scroll'))
    })
    flushFrames()
    const prevBtn = () => host.querySelector<HTMLButtonElement>('button[aria-label="上一节"]')!
    expect(prevBtn()).not.toBeNull()
    layout.scrollToIndex.mockClear()
    act(() => {
      prevBtn().click()
      prevBtn().click()
    })
    expect(layout.scrollToIndex).toHaveBeenNthCalledWith(1, 4, { behavior: 'smooth', align: 'start' })
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(2, { behavior: 'smooth', align: 'start' })
  })

  it('does not yank scrollTop when manual scrolling enters bottom zone and keeps dock hidden while jumpToBottom animates', () => {
    const el = mount()
    let scrollTop = 500
    const scrollTopSetter = vi.fn((next: number) => { scrollTop = next })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: scrollTopSetter,
    })

    // Manual scroll enters bottom 80px zone (4000 - 3450 - 500 = 50 < 80).
    scrollTop = 3450
    scrollTopSetter.mockClear()
    act(() => {
      el.dispatchEvent(new Event('wheel'))
      el.dispatchEvent(new Event('scroll'))
      flushFrames()
    })
    expect(scrollTopSetter).not.toHaveBeenCalled()

    // Scroll away, then click jumpToBottom; mid-animation scroll events must not re-show dock.
    scrollTop = 400
    act(() => {
      el.dispatchEvent(new Event('wheel'))
      el.dispatchEvent(new Event('scroll'))
      flushFrames()
    })
    expect(host.querySelector('[aria-label="对话位置导航"]')).not.toBeNull()
    click('跳到底部')
    expect(layout.scrollToIndex).toHaveBeenLastCalledWith(7, { behavior: 'auto', align: 'end' })
    expect(scrollTopSetter).toHaveBeenCalledWith(4000)
    expect(host.querySelector('[aria-label="对话位置导航"]')).toBeNull()
    act(() => {
      el.dispatchEvent(new Event('scroll'))
      flushFrames()
    })
    expect(host.querySelector('[aria-label="对话位置导航"]')).toBeNull()
  })

  it('does not slam scrollTop before projectionReady on open-latest and stops retrying once bottom-clamped', () => {
    resetPageState()
    layout.first = 2
    layout.scrollToIndex.mockReset()
    const policyMessages: ChatMsg[] = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `msg ${i}`,
      runId: `run-${Math.floor(i / 2)}`,
      streamId: `s-${i}`,
    }))
    let scrollTop = 0
    const scrollTopSetter = vi.fn((next: number) => { scrollTop = next })
    act(() => {
      useChatStore.setState({
        sessionId: 'open-latest-sess',
        msgs: policyMessages,
        streaming: false,
        resumePolicy: 'open-latest',
        projectionReady: false,
        historyStatus: 'ready',
        historyHasMore: false,
        olderHistoryStatus: 'idle',
      })
      root.render(
        <LiveChatTranscript
          key="open-latest-sess"
          ref={handle}
          sessionId="open-latest-sess"
          sessionError=""
          scheduledChats={[]}
          scheduleNow={0}
          onCancelSchedule={() => {}}
          onRewind={() => {}}
        />,
      )
    })
    const el = host.querySelector('[data-live-chat-scroll]') as HTMLDivElement
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, value: 4000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, get: () => scrollTop, set: scrollTopSetter },
    })
    el.scrollTo = vi.fn()

    // While projectionReady is false, a msgs update must not pre-slam scrollTop to bottom.
    act(() => {
      useChatStore.setState({ msgs: [...policyMessages] })
    })
    expect(scrollTopSetter).not.toHaveBeenCalled()

    // Once projectionReady becomes true, open-latest targets last user turn (index 6).
    // Simulate a short final turn that clamps at maxScrollTop (3500) with first visible = 4 (< 6).
    layout.first = 4
    layout.scrollToIndex.mockImplementation(() => { scrollTop = 3500 })
    act(() => {
      useChatStore.setState({ projectionReady: true })
    })
    flushFrames(); flushFrames()
    // First verification sees attempt=0 bottom-clamp and schedules one follow-up pass;
    // the follow-up pass (attempt=1) confirms bottom-clamp and stops instead of looping 12 times.
    flushFrames(); flushFrames()
    const callsAfterSettle = layout.scrollToIndex.mock.calls.length
    expect(callsAfterSettle).toBe(2)
    act(() => vi.advanceTimersByTime(1000))
    expect(layout.scrollToIndex).toHaveBeenCalledTimes(callsAfterSettle)
  })

  it('stays pinned at bottom when tail content grows >= 80px after jumpToBottom', () => {
    const el = mount()
    let scrollTop = 400
    let scrollHeight = 4000
    const scrollTopSetter = vi.fn((next: number) => { scrollTop = next })
    Object.defineProperties(el, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, get: () => scrollTop, set: scrollTopSetter },
    })

    act(() => {
      el.dispatchEvent(new Event('wheel'))
      el.dispatchEvent(new Event('scroll'))
      flushFrames()
    })
    click('跳到底部')
    expect(host.querySelector('[aria-label="对话位置导航"]')).toBeNull()

    // Advance past the 900ms jumpToBottom window, then expand tail height by > 80px (e.g. image/markdown load).
    act(() => vi.advanceTimersByTime(1500))
    scrollHeight = 4240
    scrollTopSetter.mockClear()
    act(() => {
      el.dispatchEvent(new Event('scroll'))
      flushFrames()
    })
    expect(scrollTopSetter).toHaveBeenCalledWith(4240)
    expect(host.querySelector('[aria-label="对话位置导航"]')).toBeNull()
    expect(saved().A.stuck).toBe(true)
  })
})
