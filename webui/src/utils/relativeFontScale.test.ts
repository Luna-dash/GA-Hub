import { afterEach, describe, expect, it, vi } from 'vitest'
import { storageKeys } from '@/config/storageKeys'
import { chatFontPercent, getChatFontScale, setChatFontScale } from './chatAppearance'
import { getRailTitleScale, railTitlePercent, setRailTitleScale } from './railAppearance'

afterEach(() => {
  for (const key of [storageKeys.chatFontScale, storageKeys.chatFontScaleRelative,
    storageKeys.railTitleScale, storageKeys.railTitleScaleRelative]) localStorage.removeItem(key)
  vi.restoreAllMocks()
})

describe('desktop font baseline', () => {
  it('defaults to captured desktop sizes with relative controls at 100%', () => {
    expect(getChatFontScale()).toBe(100)
    expect(getRailTitleScale()).toBe(100)
    expect(chatFontPercent(100)).toBe(90)
    expect(railTitlePercent(100)).toBe(60)
  })

  it('migrates desktop preferences without changing their visual size or old keys', () => {
    localStorage.setItem(storageKeys.chatFontScale, '90')
    localStorage.setItem(storageKeys.railTitleScale, '60')
    expect(getChatFontScale()).toBe(100)
    expect(getRailTitleScale()).toBe(100)
    expect(localStorage.getItem(storageKeys.chatFontScaleRelative)).toBe('100')
    expect(localStorage.getItem(storageKeys.railTitleScaleRelative)).toBe('100')
    expect(localStorage.getItem(storageKeys.chatFontScale)).toBe('90')
    expect(localStorage.getItem(storageKeys.railTitleScale)).toBe('60')
  })

  it('preserves non-default legacy preferences exactly, without slider rounding', () => {
    localStorage.setItem(storageKeys.chatFontScale, '100')
    localStorage.setItem(storageKeys.railTitleScale, '100')
    expect(chatFontPercent(getChatFontScale())).toBeCloseTo(100)
    expect(railTitlePercent(getRailTitleScale())).toBeCloseTo(100)
  })

  it('preserves the full legacy range after rebasing', () => {
    localStorage.setItem(storageKeys.chatFontScale, '150')
    localStorage.setItem(storageKeys.railTitleScale, '120')
    expect(chatFontPercent(getChatFontScale())).toBeCloseTo(150)
    expect(railTitlePercent(getRailTitleScale())).toBe(120)
  })

  it('supports smaller/larger sizes and restores the captured default', () => {
    expect(chatFontPercent(setChatFontScale(75))).toBe(67.5)
    expect(chatFontPercent(setChatFontScale(150))).toBe(135)
    expect(railTitlePercent(setRailTitleScale(75))).toBe(45)
    expect(railTitlePercent(setRailTitleScale(200))).toBe(120)
    setChatFontScale(100)
    setRailTitleScale(100)
    expect(chatFontPercent(getChatFontScale())).toBe(90)
    expect(railTitlePercent(getRailTitleScale())).toBe(60)
  })

  it('gives v2 settings priority over legacy settings on reload', () => {
    localStorage.setItem(storageKeys.chatFontScale, '90')
    localStorage.setItem(storageKeys.railTitleScale, '60')
    setChatFontScale(115)
    setRailTitleScale(125)
    expect(getChatFontScale()).toBe(115)
    expect(getRailTitleScale()).toBe(125)
  })

  it('handles invalid values and unavailable storage safely', () => {
    localStorage.setItem(storageKeys.chatFontScaleRelative, 'NaN')
    localStorage.setItem(storageKeys.railTitleScale, 'bad')
    expect(getChatFontScale()).toBe(100)
    expect(getRailTitleScale()).toBe(100)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw Error('blocked') })
    expect(getChatFontScale()).toBe(100)
    expect(getRailTitleScale()).toBe(100)
  })
})
