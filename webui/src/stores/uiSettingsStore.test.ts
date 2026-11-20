// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  uiPreferences: vi.fn(),
  saveUiPreferences: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))

import { storageKeys } from '@/config/storageKeys'
import {
  hydrateUiSettings,
  syncUiSetting,
  UI_SETTINGS_HYDRATED_EVENT,
} from './uiSettingsStore'

const flushQueue = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('durable UI settings persistence', () => {
  beforeEach(async () => {
    localStorage.clear()
    apiMock.uiPreferences.mockReset()
    apiMock.saveUiPreferences.mockReset()
    apiMock.saveUiPreferences.mockResolvedValue({ configured: true, settings: {} })
    await flushQueue()
  })

  it('hydrates local storage from archived server settings and emits hydration event', async () => {
    apiMock.uiPreferences.mockResolvedValue({
      configured: true,
      settings: {
        [storageKeys.chatFontScaleRelative]: '125',
        [storageKeys.sidebarCollapsed]: '1',
      },
    })
    const events: string[] = []
    const onHydrated = () => events.push(UI_SETTINGS_HYDRATED_EVENT)
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, onHydrated)
    try {
      await hydrateUiSettings()
      expect(localStorage.getItem(storageKeys.chatFontScaleRelative)).toBe('125')
      expect(localStorage.getItem(storageKeys.sidebarCollapsed)).toBe('1')
      expect(events).toEqual([UI_SETTINGS_HYDRATED_EVENT])
      expect(apiMock.saveUiPreferences).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, onHydrated)
    }
  })

  it('migrates local settings to the server archive when unconfigured', async () => {
    localStorage.setItem(storageKeys.chatFontScaleRelative, '110')
    localStorage.setItem(storageKeys.mykeyShowUpload, '1')
    apiMock.uiPreferences.mockResolvedValue({ configured: false, settings: {} })

    await hydrateUiSettings()
    await flushQueue()

    expect(apiMock.saveUiPreferences).toHaveBeenCalledWith({
      [storageKeys.chatFontScaleRelative]: '110',
      [storageKeys.mykeyShowUpload]: '1',
    })
  })

  it('does not let slow boot hydration overwrite a newer local update', async () => {
    let resolveRemote!: (value: { configured: boolean; settings: Record<string, string> }) => void
    apiMock.uiPreferences.mockReturnValue(new Promise((resolve) => { resolveRemote = resolve }))

    const hydrating = hydrateUiSettings()
    localStorage.setItem(storageKeys.chatFontScaleRelative, '140')
    syncUiSetting(storageKeys.chatFontScaleRelative, '140')

    resolveRemote({
      configured: true,
      settings: { [storageKeys.chatFontScaleRelative]: '100' },
    })
    await hydrating
    await flushQueue()

    expect(localStorage.getItem(storageKeys.chatFontScaleRelative)).toBe('140')
    expect(apiMock.saveUiPreferences).toHaveBeenCalledWith({
      [storageKeys.chatFontScaleRelative]: '140',
    })
  })
})
