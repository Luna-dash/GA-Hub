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
  function click(text: string) {
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!
    expect(button).toBeTruthy()
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

  it('saves button-to-tail immediately and restores the bottom after switching mid-scroll', () => {
    mount()
    click('底部')
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
    click('上节')
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
})
