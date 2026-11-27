// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FontAppearancePanel } from './FontAppearancePanel'
import type { FontSettings } from '@/api/client'

const fontApiMock = vi.hoisted(() => ({
  settings: vi.fn(),
  download: vi.fn(),
  activate: vi.fn(),
  deletePack: vi.fn(),
  updatePreferences: vi.fn(),
  importFile: vi.fn(),
}))

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return { ...actual, fontApi: fontApiMock }
})
vi.mock('@/utils/fontLoader', () => ({ applyFontSettings: vi.fn(async () => {}) }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseSettings: FontSettings = {
  active_pack: 'system',
  bold_style: 'restrained',
  packs: [
    {
      id: 'lxgw',
      name: '霞鹜文楷',
      license: 'OFL-1.1',
      mode: 'ui',
      summary: '清晰易读',
      installed: true,
      active: false,
      removable: true,
      installed_bytes: 2_000_000,
      approx_bytes: 2_000_000,
    },
  ],
  download: null,
}

describe('FontAppearancePanel loading feedback', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    fontApiMock.settings.mockResolvedValue(baseSettings)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
  })

  const renderPanel = async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FontAppearancePanel />
        </QueryClientProvider>,
      )
    })
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  }

  const button = (text: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)!

  it('shows 启用中… and 移除中… loading states and disables sibling actions while busy', async () => {
    let resolveActivate!: (next: FontSettings) => void
    let resolveDelete!: (next: FontSettings) => void
    fontApiMock.activate.mockImplementation(() => new Promise<FontSettings>((resolve) => { resolveActivate = resolve }))
    fontApiMock.deletePack.mockImplementation(() => new Promise<FontSettings>((resolve) => { resolveDelete = resolve }))

    await renderPanel()

    await act(async () => { button('启用').click() })
    expect(fontApiMock.activate).toHaveBeenCalledTimes(1)
    expect(button('启用中…').disabled).toBe(true)
    expect(button('移除').disabled).toBe(true)

    await act(async () => { resolveActivate(baseSettings); await Promise.resolve() })
    expect(button('启用').disabled).toBe(false)

    await act(async () => { button('移除').click() })
    expect(fontApiMock.deletePack).toHaveBeenCalledTimes(1)
    expect(button('移除中…').disabled).toBe(true)
    expect(button('启用').disabled).toBe(true)

    await act(async () => { resolveDelete({ ...baseSettings, packs: [] }); await Promise.resolve() })
  })
})
