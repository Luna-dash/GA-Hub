// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { focusChatScrollFromUtilityRail } from './utilityRailFocus'

function pointerEvent(target: EventTarget, button = 0) {
  return { button, target, preventDefault: vi.fn() }
}

describe('focusChatScrollFromUtilityRail', () => {
  it('moves focus to the chat scroller when the rail blank area is pressed', () => {
    const blank = document.createElement('div')
    const scroller = document.createElement('div')
    const focus = vi.spyOn(scroller, 'focus')
    const event = pointerEvent(blank)

    focusChatScrollFromUtilityRail(event, scroller)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('leaves utility buttons interactive, including presses on nested button content', () => {
    const button = document.createElement('button')
    const icon = document.createElement('span')
    button.appendChild(icon)
    const scroller = document.createElement('div')
    const focus = vi.spyOn(scroller, 'focus')
    const event = pointerEvent(icon)

    focusChatScrollFromUtilityRail(event, scroller)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not capture non-primary pointer presses', () => {
    const blank = document.createElement('div')
    const scroller = document.createElement('div')
    const focus = vi.spyOn(scroller, 'focus')
    const event = pointerEvent(blank, 2)

    focusChatScrollFromUtilityRail(event, scroller)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
  })
})
