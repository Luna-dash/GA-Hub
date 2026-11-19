import { fontApi, type FontPackManifest, type FontSettings } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

export type FontPackMode = 'system' | 'latin-enhanced' | 'enhanced'
export type BoldStyle = 'restrained' | 'standard'

interface CachedFontAppearance {
  activePack: string
  mode: FontPackMode
  boldStyle: BoldStyle
}

const registeredFaces = new Set<FontFace>()
let loadedPackKey = ''
let syncInFlight: Promise<void> | null = null

function readCache(): CachedFontAppearance {
  try {
    const raw = localStorage.getItem(storageKeys.fontAppearanceCache)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<CachedFontAppearance>
      const mode: FontPackMode =
        parsed.mode === 'enhanced' || parsed.mode === 'latin-enhanced' ? parsed.mode : 'system'
      const boldStyle: BoldStyle = parsed.boldStyle === 'standard' ? 'standard' : 'restrained'
      return {
        activePack: typeof parsed.activePack === 'string' && parsed.activePack ? parsed.activePack : 'system',
        mode,
        boldStyle,
      }
    }
  } catch { /* ignore broken cache */ }
  return { activePack: 'system', mode: 'system', boldStyle: 'restrained' }
}

function writeCache(next: CachedFontAppearance): void {
  try {
    localStorage.setItem(storageKeys.fontAppearanceCache, JSON.stringify(next))
  } catch { /* ignore storage quota errors */ }
}

function applyRootAttributes(mode: FontPackMode, boldStyle: BoldStyle): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.fontPack = mode
  document.documentElement.dataset.boldStyle = boldStyle
}

function clearRegisteredFaces(): void {
  if (typeof document === 'undefined' || !document.fonts) {
    registeredFaces.clear()
    loadedPackKey = ''
    return
  }
  for (const face of registeredFaces) {
    try { document.fonts.delete(face) } catch { /* ignore */ }
  }
  registeredFaces.clear()
  loadedPackKey = ''
}

function registerManifest(manifest: FontPackManifest): void {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined' || !document.fonts) return
  if (loadedPackKey === manifest.pack_id && registeredFaces.size > 0) return
  clearRegisteredFaces()
  for (const entry of manifest.faces) {
    const url = resolveApiUrl(
      `/api/appearance/fonts/packs/${encodeURIComponent(manifest.pack_id)}/files/${encodeURIComponent(entry.file)}`,
    )
    const descriptors: FontFaceDescriptors = {
      weight: entry.weight,
      style: entry.style,
      display: 'swap',
      ...(entry.unicodeRange ? { unicodeRange: entry.unicodeRange } : {}),
    }
    const face = new FontFace(entry.family, `url("${url}") format("${entry.format}")`, descriptors)
    document.fonts.add(face)
    registeredFaces.add(face)
  }
  loadedPackKey = manifest.pack_id
}

export function initFontAppearance(): void {
  const cached = readCache()
  applyRootAttributes(cached.mode, cached.boldStyle)
}

export async function applyFontSettings(settings: FontSettings): Promise<void> {
  const boldStyle: BoldStyle = settings.bold_style === 'standard' ? 'standard' : 'restrained'
  const active = settings.active_pack || 'system'
  if (active === 'system') {
    clearRegisteredFaces()
    applyRootAttributes('system', boldStyle)
    writeCache({ activePack: 'system', mode: 'system', boldStyle })
    return
  }
  const packInfo = settings.packs.find((item) => item.id === active && item.installed)
  if (!packInfo) {
    clearRegisteredFaces()
    applyRootAttributes('system', boldStyle)
    writeCache({ activePack: 'system', mode: 'system', boldStyle })
    return
  }
  const mode: FontPackMode = packInfo.mode === 'latin-enhanced' ? 'latin-enhanced' : 'enhanced'
  try {
    const manifest = await fontApi.manifest(active)
    registerManifest(manifest)
    applyRootAttributes(mode, boldStyle)
    writeCache({ activePack: active, mode, boldStyle })
  } catch {
    clearRegisteredFaces()
    applyRootAttributes('system', boldStyle)
  }
}

export async function syncFontAppearance(): Promise<void> {
  let fetchSettings: typeof fontApi.settings | undefined
  try {
    fetchSettings = fontApi?.settings
  } catch {
    return
  }
  if (typeof fetchSettings !== 'function') return
  if (syncInFlight) return syncInFlight
  syncInFlight = (async () => {
    try {
      const settings = await fetchSettings()
      await applyFontSettings(settings)
    } catch {
      /* keep current attributes cleanly when backend is starting or offline */
    } finally {
      syncInFlight = null
    }
  })()
  return syncInFlight
}
