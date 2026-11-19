// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyFontSettings, initFontAppearance } from './fontLoader'
import { fontApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  fontApi: {
    settings: vi.fn(),
    manifest: vi.fn(),
  },
}))

class MockFontFace {
  family: string
  source: string
  weight?: string
  style?: string
  unicodeRange?: string
  constructor(family: string, source: string, descriptors?: FontFaceDescriptors) {
    this.family = family
    this.source = source
    this.weight = descriptors?.weight
    this.style = descriptors?.style
    this.unicodeRange = descriptors?.unicodeRange
  }
}

describe('fontLoader', () => {
  const added = new Set<unknown>()

  beforeEach(() => {
    localStorage.clear()
    added.clear()
    delete document.documentElement.dataset.fontPack
    delete document.documentElement.dataset.boldStyle
    vi.stubGlobal('FontFace', MockFontFace)
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: {
        add: (f: unknown) => { added.add(f) },
        delete: (f: unknown) => { added.delete(f) },
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetAllMocks()
  })

  it('defaults to system + restrained bold and hydrates from cache cleanly', () => {
    initFontAppearance()
    expect(document.documentElement.dataset.fontPack).toBe('system')
    expect(document.documentElement.dataset.boldStyle).toBe('restrained')
  })

  it('registers faces and switches data attributes for enhanced packs, then reverts cleanly', async () => {
    vi.mocked(fontApi.manifest).mockResolvedValue({
      pack_id: 'harmonyos-sans-sc',
      name: 'HarmonyOS Sans SC',
      mode: 'enhanced',
      faces: [
        { family: 'GA Latin Sans', file: 'inter.woff2', weight: '100 900', style: 'normal', format: 'woff2' },
        { family: 'GA CJK Sans', file: 'hmos.woff2', weight: '400', style: 'normal', format: 'woff2' },
      ],
    })

    await applyFontSettings({
      active_pack: 'harmonyos-sans-sc',
      bold_style: 'standard',
      download: null,
      packs: [{
        id: 'harmonyos-sans-sc',
        name: 'HarmonyOS Sans SC',
        summary: '',
        license: 'MIT',
        mode: 'enhanced',
        approx_bytes: 1000,
        installed: true,
        installed_bytes: 1000,
        active: true,
        removable: true,
      }],
    })

    expect(document.documentElement.dataset.fontPack).toBe('enhanced')
    expect(document.documentElement.dataset.boldStyle).toBe('standard')
    expect(added.size).toBe(2)

    await applyFontSettings({
      active_pack: 'system',
      bold_style: 'restrained',
      download: null,
      packs: [],
    })

    expect(document.documentElement.dataset.fontPack).toBe('system')
    expect(document.documentElement.dataset.boldStyle).toBe('restrained')
    expect(added.size).toBe(0)
  })
})
