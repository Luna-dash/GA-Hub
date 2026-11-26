// Persistent non-navigation UI preferences: synchronous localStorage for
// zero-flicker reads plus atomic server archival in ADMIN_DATA/ui_preferences.json
// so binary updates never discard user settings.
import { api } from '@/api/client'
import { storageKeys } from '@/config/storageKeys'

export const DURABLE_UI_SETTING_KEYS = [
  storageKeys.sidebarCollapsed,
  storageKeys.conversationIndexCollapsed,
  storageKeys.conductorSubagentModelLocked,
  storageKeys.modelSelectionMainLlm,
  storageKeys.modelSelectionSubagentLlm,
  storageKeys.chatFontScaleRelative,
  storageKeys.railTitleScaleRelative,
  storageKeys.mykeyShowUpload,
  storageKeys.chatPerformance,
  storageKeys.desktopNotifications,
  storageKeys.uiTheme,
  storageKeys.uiPaperTexture,
] as const

export type DurableUiSettingKey = (typeof DURABLE_UI_SETTING_KEYS)[number]

export const UI_SETTINGS_HYDRATED_EVENT = 'gahub:ui-settings-hydrated'
const ALLOWED_KEYS = new Set<string>(DURABLE_UI_SETTING_KEYS)
const keyRevisions = new Map<string, number>()
let saveQueue = Promise.resolve()

function bumpRevision(key: string): number {
  const next = (keyRevisions.get(key) ?? 0) + 1
  keyRevisions.set(key, next)
  return next
}

function readLocal(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: server copy stays authoritative.
  }
}

function queuePatch(patch: Record<string, string | null>): void {
  if (Object.keys(patch).length === 0 || typeof api.saveUiPreferences !== 'function') return
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => api.saveUiPreferences(patch))
    .then(() => undefined)
    .catch(() => undefined)
}

export function syncUiSetting(key: DurableUiSettingKey, value: string | null): void {
  if (!ALLOWED_KEYS.has(key)) return
  bumpRevision(key)
  queuePatch({ [key]: value })
}

export async function hydrateUiSettings(): Promise<void> {
  if (typeof api.uiPreferences !== 'function') return
  const startRevisions = new Map<string, number>()
  for (const key of DURABLE_UI_SETTING_KEYS) {
    startRevisions.set(key, keyRevisions.get(key) ?? 0)
  }
  try {
    const remote = await api.uiPreferences()
    if (!remote) return
    const remoteSettings = remote.settings ?? {}
    if (remote.configured) {
      let applied = false
      const localExtras: Record<string, string> = {}
      for (const key of DURABLE_UI_SETTING_KEYS) {
        if ((keyRevisions.get(key) ?? 0) !== startRevisions.get(key)) continue
        const remoteVal = remoteSettings[key]
        if (typeof remoteVal === 'string') {
          if (readLocal(key) !== remoteVal) {
            writeLocal(key, remoteVal)
            applied = true
          }
        } else {
          const localVal = readLocal(key)
          if (localVal !== null) localExtras[key] = localVal
        }
      }
      if (Object.keys(localExtras).length > 0) queuePatch(localExtras)
      if (applied) {
        window.dispatchEvent(new CustomEvent(UI_SETTINGS_HYDRATED_EVENT))
      }
      return
    }
    const snapshot: Record<string, string> = {}
    for (const key of DURABLE_UI_SETTING_KEYS) {
      const localVal = readLocal(key)
      if (localVal !== null) snapshot[key] = localVal
    }
    if (Object.keys(snapshot).length > 0) queuePatch(snapshot)
  } catch {
    // Backend unavailable or mocked in tests: keep localStorage values.
  }
}
