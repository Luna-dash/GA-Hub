// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeMock = vi.hoisted(() => ({
  syncUiSetting: vi.fn(),
}))

vi.mock('@/stores/uiSettingsStore', () => ({
  syncUiSetting: storeMock.syncUiSetting,
  UI_SETTINGS_HYDRATED_EVENT: 'gahub:ui-settings-hydrated',
}))

import { storageKeys } from '@/config/storageKeys'
import {
  DEFAULT_PAPER_TEXTURE,
  DEFAULT_UI_THEME,
  getPaperTexture,
  getUiTheme,
  initThemeAppearance,
  setPaperTexture,
  setUiTheme,
  UI_THEME_CHANGED_EVENT,
  UI_THEME_PRESETS,
} from './themeAppearance'

describe('themeAppearance preferences', () => {
  beforeEach(() => {
    localStorage.clear()
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.paperTexture
    storeMock.syncUiSetting.mockReset()
  })

  it('defaults to crisp-green-soft theme and fiber paper texture, falling back on invalid values', () => {
    expect(getUiTheme()).toBe(DEFAULT_UI_THEME)
    expect(getPaperTexture()).toBe(DEFAULT_PAPER_TEXTURE)

    localStorage.setItem(storageKeys.uiTheme, 'non-existent-theme')
    localStorage.setItem(storageKeys.uiPaperTexture, 'bad-texture')
    expect(getUiTheme()).toBe('crisp-green-soft')
    expect(getPaperTexture()).toBe('fiber')

    initThemeAppearance()
    expect(document.documentElement.dataset.theme).toBe('crisp-green-soft')
    expect(document.documentElement.dataset.paperTexture).toBe('fiber')
  })

  it('persists selected theme and texture, updates DOM attributes, and syncs to uiSettingsStore', () => {
    expect(UI_THEME_PRESETS).toHaveLength(6)
    const received: Array<{ theme?: string; paperTexture?: string }> = []
    const onChanged = (event: Event) => {
      received.push((event as CustomEvent).detail)
    }
    window.addEventListener(UI_THEME_CHANGED_EVENT, onChanged)
    try {
      setUiTheme('warm-parchment')
      setPaperTexture('cotton')

      expect(localStorage.getItem(storageKeys.uiTheme)).toBe('warm-parchment')
      expect(localStorage.getItem(storageKeys.uiPaperTexture)).toBe('cotton')
      expect(document.documentElement.dataset.theme).toBe('warm-parchment')
      expect(document.documentElement.dataset.paperTexture).toBe('cotton')
      expect(storeMock.syncUiSetting).toHaveBeenCalledWith(storageKeys.uiTheme, 'warm-parchment')
      expect(storeMock.syncUiSetting).toHaveBeenCalledWith(storageKeys.uiPaperTexture, 'cotton')
      expect(received).toEqual([
        { theme: 'warm-parchment', paperTexture: 'fiber' },
        { theme: 'warm-parchment', paperTexture: 'cotton' },
      ])
    } finally {
      window.removeEventListener(UI_THEME_CHANGED_EVENT, onChanged)
    }
  })

  it('re-applies theme and texture when server UI preferences hydrate', () => {
    initThemeAppearance()
    localStorage.setItem(storageKeys.uiTheme, 'dark-forest')
    localStorage.setItem(storageKeys.uiPaperTexture, 'none')
    window.dispatchEvent(new CustomEvent('gahub:ui-settings-hydrated'))

    expect(document.documentElement.dataset.theme).toBe('dark-forest')
    expect(document.documentElement.dataset.paperTexture).toBe('none')
  })
})
