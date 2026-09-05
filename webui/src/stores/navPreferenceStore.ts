// Sidebar visibility preferences: localStorage truth, server sync, and a
// window event for same-tab listeners. Pure vocabulary (NAV_ITEMS, the
// normalizer) stays in config/navigation; this module owns everything that
// mutates or fetches.
import { api } from '@/api/client'
import {
  defaultNavPreferences,
  NAV_ITEMS,
  NAV_PREFERENCES_EVENT,
  normalizeNavPreferences,
  type NavItem,
  type NavPreference,
} from '@/config/navigation'
import { storageKeys } from '@/config/storageKeys'

const STORAGE_KEY = storageKeys.navPreferences

export function getNavPreferences(): NavPreference[] {
  try { return normalizeNavPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')) }
  catch { return defaultNavPreferences() }
}

let localRevision = 0
let saveQueue = Promise.resolve()

function applyNavPreferences(value: NavPreference[]): NavPreference[] {
  const normalized = normalizeNavPreferences(value)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent(NAV_PREFERENCES_EVENT, { detail: normalized }))
  return normalized
}

function queueServerSave(preferences: NavPreference[]): void {
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => api.saveNavigationPreferences(preferences))
    .then(() => undefined)
    .catch(() => undefined)
}

export function setNavPreferences(value: NavPreference[]): NavPreference[] {
  localRevision += 1
  const normalized = applyNavPreferences(value)
  queueServerSave(normalized)
  return normalized
}

export async function hydrateNavPreferences(): Promise<NavPreference[]> {
  const revisionAtStart = localRevision
  try {
    const remote = await api.navigationPreferences()
    if (localRevision !== revisionAtStart) return getNavPreferences()
    if (remote.configured) {
      const normalized = applyNavPreferences(remote.preferences)
      if (JSON.stringify(normalized) !== JSON.stringify(remote.preferences)) {
        queueServerSave(normalized)
      }
      return normalized
    }
    const local = getNavPreferences()
    queueServerSave(local)
    return local
  } catch {
    return getNavPreferences()
  }
}

export function getVisibleNavItems(preferences = getNavPreferences()): NavItem[] {
  const byId = new Map(NAV_ITEMS.map((item) => [item.id, item]))
  return preferences.flatMap(({ id, visible }) => {
    const item = byId.get(id)
    return visible && item ? [item] : []
  })
}
