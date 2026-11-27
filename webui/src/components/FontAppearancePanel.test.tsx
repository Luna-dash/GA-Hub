// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fontApi } from '@/api/client'
import { FontAppearancePanel } from './FontAppearancePanel'

vi.mock('@/api/client', () => ({
  fontApi: {
    settings: vi.fn(),
    download: vi.fn(),
    activate: vi.fn(),
    updatePreferences: vi.fn(),
    deletePack: vi.fn(),
    importFile: vi.fn(),
  },
}))
vi.mock('@/utils/fontLoader', () => ({
  applyFontSettings: vi.fn().mockResolvedValue(undefined),
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('FontAppearancePanel', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
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

  it('renders QueryLoadState with retry on fontsQuery error and recovers on click', async () => {
    vi.mocked(fontApi.settings).mockRejectedValueOnce({ body: { detail: '字体目录未挂载' } })

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FontAppearancePanel />
        </QueryClientProvider>,
      )
    })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('字体列表加载失败：字体目录未挂载')
    const retryBtn = Array.from(host.querySelectorAll('button')).find(b => b.textContent === '重试')!
    expect(retryBtn.type).toBe('button')

    vi.mocked(fontApi.settings).mockResolvedValueOnce({
      active_pack: 'system',
      bold_style: 'restrained',
      packs: [{
        id: 'harmonyos-sans-sc',
        name: 'HarmonyOS Sans SC',
        summary: 'test pack',
        license: 'OSS',
        mode: 'enhanced',
        approx_bytes: 1024,
        installed: false,
        installed_bytes: 0,
        active: false,
        removable: false,
      }],
      download: null,
    } as never)

    await act(async () => { retryBtn.click(); await new Promise(r => setTimeout(r, 20)) })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).toContain('HarmonyOS Sans SC')
  })
})
