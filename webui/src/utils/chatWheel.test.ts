// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { routeChatWheel } from './chatWheel'

function setup() {
  const scroller = document.createElement('div')
  const inner = document.createElement('div'); scroller.append(inner)
  Object.defineProperties(scroller, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 } })
  scroller.scrollTop = 300
  const gesture = vi.fn()
  function wheel(target: Element = inner, options: WheelEventInit = {}) {
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true, ...options })
    Object.defineProperty(event, 'target', { value: target })
    routeChatWheel(event, scroller, gesture)
    return event
  }
  return { scroller, inner, gesture, wheel }
}

function makeScrollable(inner: HTMLElement, overflowY = 'auto') {
  inner.style.overflowY = overflowY
  Object.defineProperties(inner, { scrollHeight: { value: 600 }, clientHeight: { value: 100 } })
  inner.scrollTop = 200
}

describe('chat vertical wheel routing', () => {
  it.each([100, -100])('preserves inner native reading in direction %s', deltaY => {
    const { scroller, inner, gesture, wheel } = setup(); makeScrollable(inner)
    expect(wheel(undefined, { deltaY }).defaultPrevented).toBe(false)
    expect(scroller.scrollTop).toBe(300); expect(inner.scrollTop).toBe(200)
    expect(gesture).toHaveBeenCalledTimes(1)
  })
  it.each([{ top: 0, delta: -100, outer: 200 }, { top: 500, delta: 100, outer: 400 }])(
    'hands off to the transcript at an inner directional edge: %j', ({ top, delta, outer }) => {
      const { scroller, inner, gesture, wheel } = setup(); makeScrollable(inner); inner.scrollTop = top
      expect(wheel(undefined, { deltaY: delta }).defaultPrevented).toBe(true)
      expect(scroller.scrollTop).toBe(outer); expect(inner.scrollTop).toBe(top)
      expect(gesture).toHaveBeenCalledTimes(1)
    })
  it('finds a scrollable ancestor of nested text or buttons', () => {
    const { scroller, inner, wheel } = setup(); makeScrollable(inner, 'scroll')
    const child = document.createElement('button'); inner.append(child)
    expect(wheel(child).defaultPrevented).toBe(false); expect(scroller.scrollTop).toBe(300)
  })
  it.each(['visible', 'hidden', 'clip'])('does not treat overflow-%s content as a native reader', overflowY => {
    const { scroller, inner, wheel } = setup(); makeScrollable(inner, overflowY)
    expect(wheel().defaultPrevented).toBe(true); expect(scroller.scrollTop).toBe(400)
  })
  it('checks higher readers when the closest reader is at its edge', () => {
    const { scroller, inner, wheel } = setup(); makeScrollable(inner); inner.scrollTop = 500
    const parent = document.createElement('div'); makeScrollable(parent)
    scroller.append(parent); parent.append(inner)
    expect(wheel().defaultPrevented).toBe(false); expect(scroller.scrollTop).toBe(300)
  })
  it('scrolls ordinary non-scrollable content once per gesture', () => {
    const { scroller, inner, gesture, wheel } = setup(); inner.scrollTop = 50
    expect(wheel().defaultPrevented).toBe(true)
    expect(scroller.scrollTop).toBe(400); expect(inner.scrollTop).toBe(50)
    expect(gesture).toHaveBeenCalledTimes(1)
  })
  it('scrolls from sibling navigation buttons and empty rail space', () => {
    const { scroller, wheel } = setup()
    expect(wheel(document.createElement('button')).defaultPrevented).toBe(true)
    expect(scroller.scrollTop).toBe(400)
    wheel(document.createElement('aside'), { deltaY: -80 }); expect(scroller.scrollTop).toBe(320)
  })
  it('allows inner native reading at the outer boundary but contains the rail', () => {
    const { scroller, gesture, wheel } = setup(); scroller.scrollTop = 800
    expect(wheel().defaultPrevented).toBe(false)
    expect(wheel(document.createElement('button')).defaultPrevented).toBe(true)
    expect(gesture).not.toHaveBeenCalled()
    scroller.scrollTop = 0; expect(wheel(undefined, { deltaY: -100 }).defaultPrevented).toBe(false)
  })
  it('clamps overshoot and translates line/page deltas', () => {
    const { scroller, wheel } = setup()
    wheel(undefined, { deltaMode: 1, deltaY: 2 }); expect(scroller.scrollTop).toBe(332)
    wheel(undefined, { deltaMode: 2, deltaY: 1 }); expect(scroller.scrollTop).toBe(532)
    wheel(undefined, { deltaY: 900 }); expect(scroller.scrollTop).toBe(800)
    wheel(undefined, { deltaY: -2000 }); expect(scroller.scrollTop).toBe(0)
  })
  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 200 }, { deltaY: 0 }, { cancelable: false }])('keeps zoom/horizontal/noncancelable gestures native: %j', options => {
    const { scroller, wheel, gesture } = setup()
    expect(wheel(undefined, options).defaultPrevented).toBe(false)
    expect(scroller.scrollTop).toBe(300); expect(gesture).not.toHaveBeenCalled()
  })
  it.each(['textarea', 'input', 'select', 'editable', 'schedule'])('keeps %s independent', type => {
    const { scroller, inner, wheel } = setup()
    const parent = document.createElement(['editable', 'schedule'].includes(type) ? 'div' : type)
    if (type === 'editable') parent.setAttribute('contenteditable', 'true')
    if (type === 'schedule') parent.setAttribute('data-chat-wheel-independent', '')
    parent.append(inner); scroller.append(parent)
    expect(wheel().defaultPrevented).toBe(false); expect(scroller.scrollTop).toBe(300)
  })
  it('does not override previously consumed gestures', () => {
    const { scroller, inner, gesture } = setup()
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
    Object.defineProperty(event, 'target', { value: inner }); event.preventDefault()
    routeChatWheel(event, scroller, gesture)
    expect(scroller.scrollTop).toBe(300); expect(gesture).not.toHaveBeenCalled()
  })
})
