import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_FONT_SCALE_DEFAULT,
  CHAT_FONT_SCALE_EVENT,
  CHAT_FONT_SCALE_KEY,
  clampChatFontScale,
  getChatFontScale,
  setChatFontScale,
} from './chatAppearance'

describe('chatAppearance', () => {
  afterEach(() => {
    localStorage.removeItem(CHAT_FONT_SCALE_KEY)
  })

  it('clamps and rounds the scale to supported steps', () => {
    expect(clampChatFontScale(72)).toBe(75)
    expect(clampChatFontScale(103)).toBe(105)
    expect(clampChatFontScale(153)).toBe(150)
    expect(clampChatFontScale(Number.NaN)).toBe(CHAT_FONT_SCALE_DEFAULT)
  })

  it('persists updates and notifies mounted message views', () => {
    const listener = vi.fn()
    window.addEventListener(CHAT_FONT_SCALE_EVENT, listener)

    expect(setChatFontScale(123)).toBe(125)
    expect(getChatFontScale()).toBe(125)
    expect(localStorage.getItem(CHAT_FONT_SCALE_KEY)).toBe('125')
    expect(listener).toHaveBeenCalledOnce()

    window.removeEventListener(CHAT_FONT_SCALE_EVENT, listener)
  })
})
