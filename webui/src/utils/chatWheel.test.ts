// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { routeChatWheel } from './chatWheel'

function setup() {
  const scroller = document.createElement('div')
  const inner = document.createElement('div'); scroller.append(inner)
  const rail = document.createElement('aside')
  Object.defineProperties(scroller, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200, configurable: true } })
  scroller.scrollTop = 300
  const gesture = vi.fn()
  function wheel(target: Element = rail, options: WheelEventInit = {}) {
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true, ...options })
    Object.defineProperty(event, 'target', { value: target })
    routeChatWheel(event, scroller, gesture)
    return event
  }
  return { scroller, inner, rail, gesture, wheel }
}

describe('chat utility rail wheel routing', () => {
  it.each([0, 200, 500])('never intercepts transcript readers at scrollTop %s', top => {
    const { scroller, inner, gesture, wheel } = setup()
    inner.style.overflowY = 'auto'; inner.scrollTop = top
    Object.defineProperties(inner, { scrollHeight: { value: 600 }, clientHeight: { value: 100 } })
    for (const deltaY of [-100, 100]) {
      expect(wheel(inner, { deltaY }).defaultPrevented).toBe(false)
      expect(scroller.scrollTop).toBe(300); expect(inner.scrollTop).toBe(top)
    }
    expect(gesture).not.toHaveBeenCalled()
  })
  it('leaves ordinary transcript content native without reading layout', () => {
    const { scroller, inner, gesture, wheel } = setup()
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => { throw new Error('native path must not read layout') }, configurable: true },
      clientHeight: { get: () => { throw new Error('native path must not read layout') }, configurable: true },
    })
    const style = vi.spyOn(window, 'getComputedStyle')
    try {
      expect(wheel(inner).defaultPrevented).toBe(false)
      expect(wheel(scroller).defaultPrevented).toBe(false)
      expect(scroller.scrollTop).toBe(300)
      expect(style).not.toHaveBeenCalled(); expect(gesture).not.toHaveBeenCalled()
    } finally { style.mockRestore() }
  })
  it('scrolls from sibling navigation buttons and empty rail space', () => {
    const { scroller, rail, gesture, wheel } = setup()
    const button = document.createElement('button'); rail.append(button)
    expect(wheel(button).defaultPrevented).toBe(true)
    expect(scroller.scrollTop).toBe(400)
    wheel(rail, { deltaY: -80 }); expect(scroller.scrollTop).toBe(320)
    expect(gesture).toHaveBeenCalledTimes(2)
  })
  it('contains the rail at conversation boundaries without invoking gesture', () => {
    const { scroller, gesture, wheel } = setup(); scroller.scrollTop = 800
    expect(wheel().defaultPrevented).toBe(true)
    scroller.scrollTop = 0
    expect(wheel(undefined, { deltaY: -100 }).defaultPrevented).toBe(true)
    expect(gesture).not.toHaveBeenCalled()
  })
  it('clamps overshoot and translates line/page deltas on the rail', () => {
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
  it.each(['textarea', 'input', 'select', 'editable', 'schedule'])('keeps %s independent within the rail', type => {
    const { scroller, rail, wheel } = setup()
    const parent = document.createElement(['editable', 'schedule'].includes(type) ? 'div' : type)
    if (type === 'editable') parent.setAttribute('contenteditable', 'true')
    if (type === 'schedule') parent.setAttribute('data-chat-wheel-independent', '')
    const child = document.createElement('span'); parent.append(child); rail.append(parent)
    expect(wheel(child).defaultPrevented).toBe(false); expect(scroller.scrollTop).toBe(300)
  })
  it('does not override previously consumed rail gestures', () => {
    const { scroller, rail, gesture } = setup()
    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true })
    Object.defineProperty(event, 'target', { value: rail }); event.preventDefault()
    routeChatWheel(event, scroller, gesture)
    expect(scroller.scrollTop).toBe(300); expect(gesture).not.toHaveBeenCalled()
  })
})
