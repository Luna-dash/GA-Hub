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

  it('guards all async actions against same-tick rapid double-clicks and unlocks cleanly on rejection', async () => {
    const withDownloadable: FontSettings = {
      active_pack: 'lxgw',
      bold_style: 'restrained',
      packs: [
        ...baseSettings.packs.map((p) => ({ ...p, active: true })),
        {
          id: 'maple',
          name: 'Maple Mono',
          license: 'OFL-1.1',
          mode: 'mono',
          summary: '等宽字体',
          installed: false,
          active: false,
          removable: false,
          installed_bytes: 0,
          approx_bytes: 1_500_000,
        },
      ],
      download: null,
    }
    fontApiMock.settings.mockResolvedValue(withDownloadable)

    let rejectActivate!: (err: Error) => void
    let rejectDelete!: (err: Error) => void
    let rejectDownload!: (err: Error) => void
    let rejectBold!: (err: Error) => void
    let resolveImport!: (next: FontSettings) => void
    fontApiMock.activate.mockImplementation(() => new Promise((_, reject) => { rejectActivate = reject }))
    fontApiMock.deletePack.mockImplementation(() => new Promise((_, reject) => { rejectDelete = reject }))
    fontApiMock.download.mockImplementation(() => new Promise((_, reject) => { rejectDownload = reject }))
    fontApiMock.updatePreferences.mockImplementation(() => new Promise((_, reject) => { rejectBold = reject }))
    fontApiMock.importFile.mockImplementation(() => new Promise<FontSettings>((resolve) => { resolveImport = resolve }))

    await renderPanel()

    // 1. handleActivate same-tick double-click + disables 导入本地字体… + rejection unlocks
    const sysBtn = button('切回系统默认')
    await act(async () => {
      sysBtn.click()
      sysBtn.click()
    })
    expect(fontApiMock.activate).toHaveBeenCalledTimes(1)
    expect(button('导入本地字体…').disabled).toBe(true)
    await act(async () => { rejectActivate(new Error('activate fail')); await Promise.resolve() })
    expect(button('导入本地字体…').disabled).toBe(false)

    // 2. handleDelete same-tick double-click + rejection unlocks
    const delBtn = button('移除')
    await act(async () => {
      delBtn.click()
      delBtn.click()
    })
    expect(fontApiMock.deletePack).toHaveBeenCalledTimes(1)
    expect(button('导入本地字体…').disabled).toBe(true)
    await act(async () => { rejectDelete(new Error('delete fail')); await Promise.resolve() })
    expect(button('导入本地字体…').disabled).toBe(false)

    // 3. handleDownload same-tick double-click + rejection unlocks
    const dlBtn = button('下载并启用')
    await act(async () => {
      dlBtn.click()
      dlBtn.click()
    })
    expect(fontApiMock.download).toHaveBeenCalledTimes(1)
    expect(button('导入本地字体…').disabled).toBe(true)
    await act(async () => { rejectDownload(new Error('download fail')); await Promise.resolve() })
    expect(button('导入本地字体…').disabled).toBe(false)

    // 4. handleBoldStyle same-tick double-click + rejection unlocks
    const boldBtn = button('原生标准粗体')
    await act(async () => {
      boldBtn.click()
      boldBtn.click()
    })
    expect(fontApiMock.updatePreferences).toHaveBeenCalledTimes(1)
    expect(button('导入本地字体…').disabled).toBe(true)
    await act(async () => { rejectBold(new Error('bold fail')); await Promise.resolve() })
    expect(button('导入本地字体…').disabled).toBe(false)

    // 5. handleImportChange disables pack and bold buttons while importing
    const fileInput = host.querySelector<HTMLInputElement>('input[type="file"]')!
    const fontFile = new File(['font'], 'custom.woff2', { type: 'font/woff2' })
    Object.defineProperty(fileInput, 'files', { value: [fontFile], configurable: true })
    await act(async () => {
      fileInput.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(fontApiMock.importFile).toHaveBeenCalledTimes(1)
    expect(button('导入中…').disabled).toBe(true)
    expect(button('原生标准粗体').disabled).toBe(true)
    expect(button('下载并启用').disabled).toBe(true)
    expect(button('移除').disabled).toBe(true)
    expect(button('切回系统默认').disabled).toBe(true)
    await act(async () => { resolveImport(withDownloadable); await Promise.resolve() })
    expect(button('导入本地字体…').disabled).toBe(false)
    expect(button('原生标准粗体').disabled).toBe(false)
  })
})
