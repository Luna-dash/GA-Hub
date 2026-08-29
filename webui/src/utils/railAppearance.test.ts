import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RAIL_TITLE_SCALE_DEFAULT,
  RAIL_TITLE_SCALE_EVENT,
  RAIL_TITLE_SCALE_KEY,
  clampRailTitleScale,
  getRailTitleScale,
  setRailTitleScale,
} from './railAppearance'

describe('railAppearance', () => {
  afterEach(() => {
    localStorage.removeItem(RAIL_TITLE_SCALE_KEY)
  })

  it('clamps and rounds the scale to supported steps', () => {
    expect(clampRailTitleScale(72)).toBe(75)
    expect(clampRailTitleScale(103)).toBe(105)
    expect(clampRailTitleScale(153)).toBe(150)
    expect(clampRailTitleScale(Number.NaN)).toBe(RAIL_TITLE_SCALE_DEFAULT)
  })

  it('persists updates and notifies mounted rail views', () => {
    const listener = vi.fn()
    window.addEventListener(RAIL_TITLE_SCALE_EVENT, listener)

    expect(setRailTitleScale(123)).toBe(125)
    expect(getRailTitleScale()).toBe(125)
    expect(localStorage.getItem(RAIL_TITLE_SCALE_KEY)).toBe('125')
    expect(listener).toHaveBeenCalledOnce()

    window.removeEventListener(RAIL_TITLE_SCALE_EVENT, listener)
  })
})
