import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({
  navigationPreferences: vi.fn(),
  saveNavigationPreferences: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))

import {
  defaultNavPreferences,
  getNavPreferences,
  hydrateNavPreferences,
  setNavPreferences,
} from './navigation'

const customized = () => {
  const value = defaultNavPreferences().reverse()
  value[1] = { ...value[1], visible: false }
  return value
}

const flushQueue = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('navigation preference persistence', () => {
  beforeEach(async () => {
    localStorage.clear()
    apiMock.navigationPreferences.mockReset()
    apiMock.saveNavigationPreferences.mockReset()
    apiMock.saveNavigationPreferences.mockResolvedValue({ configured: true, preferences: [] })
    await flushQueue()
  })

  it('hydrates browser state from the persistent server copy', async () => {
    const remote = customized()
    apiMock.navigationPreferences.mockResolvedValue({ configured: true, preferences: remote })

    await expect(hydrateNavPreferences()).resolves.toEqual(remote)

    expect(getNavPreferences()).toEqual(remote)
    expect(apiMock.saveNavigationPreferences).not.toHaveBeenCalled()
  })

  it('drops the retired Feishu page from saved navigation preferences', async () => {
    const current = defaultNavPreferences()
    const legacy = [
      ...current.slice(0, 2),
      { id: 'feishu', visible: true },
      ...current.slice(2),
    ]
    apiMock.navigationPreferences.mockResolvedValue({ configured: true, preferences: legacy })

    await expect(hydrateNavPreferences()).resolves.toEqual(current)
    await flushQueue()

    expect(getNavPreferences()).toEqual(current)
    expect(apiMock.saveNavigationPreferences).toHaveBeenCalledWith(current)
  })

  it('migrates existing local preferences when the server has no copy yet', async () => {
    const local = setNavPreferences(customized())
    await flushQueue()
    apiMock.saveNavigationPreferences.mockClear()
    apiMock.navigationPreferences.mockResolvedValue({ configured: false, preferences: [] })

    await expect(hydrateNavPreferences()).resolves.toEqual(local)
    await flushQueue()

    expect(apiMock.saveNavigationPreferences).toHaveBeenCalledWith(local)
  })

  it('does not let a slow startup response overwrite a newer user change', async () => {
    let resolveRemote!: (value: { configured: boolean; preferences: ReturnType<typeof customized> }) => void
    apiMock.navigationPreferences.mockReturnValue(new Promise((resolve) => { resolveRemote = resolve }))
    const hydrating = hydrateNavPreferences()
    const newer = setNavPreferences(customized())

    resolveRemote({ configured: true, preferences: defaultNavPreferences() })
    await expect(hydrating).resolves.toEqual(newer)

    expect(getNavPreferences()).toEqual(newer)
  })
})
