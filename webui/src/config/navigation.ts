import { APP_PAGES, type NavIconName } from '@/config/pages'

export type { NavIconName }

export interface NavItem { id: string; to: string; label: string; icon: NavIconName }
export interface NavPreference { id: string; visible: boolean }

export const NAV_ITEMS: NavItem[] = APP_PAGES
  .filter((page) => page.inNav)
  .map(({ id, to, label, navIcon }) => ({ id, to, label, icon: navIcon }))

const DEFAULT_VISIBLE = new Map(APP_PAGES.map((page) => [page.id, page.defaultVisible !== false]))

export const NAV_PREFERENCES_EVENT = 'gahub:nav-preferences'

export const defaultNavPreferences = (): NavPreference[] =>
  NAV_ITEMS.map(({ id }) => ({ id, visible: DEFAULT_VISIBLE.get(id) ?? true }))

export function normalizeNavPreferences(value: unknown): NavPreference[] {
  const known = new Set(NAV_ITEMS.map(({ id }) => id))
  const result: NavPreference[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const { id, visible } = entry as { id?: unknown; visible?: unknown }
      if (typeof id !== 'string' || !known.has(id) || result.some((item) => item.id === id)) continue
      result.push({ id, visible: visible !== false })
    }
  }
  const savedIds = new Set(result.map(item => item.id))
  for (const { id } of NAV_ITEMS) if (!savedIds.has(id)) result.push({ id, visible: DEFAULT_VISIBLE.get(id) ?? true })
  // Move only newly added pages; keep the saved order and visibility intact.
  const placeMissingAfter = (id: string, anchor: string) => {
    if (savedIds.has(id)) return
    const [item] = result.splice(result.findIndex(item => item.id === id), 1)
    result.splice(result.findIndex(item => item.id === anchor) + 1, 0, item)
  }
  placeMissingAfter('anti', 'chat')
  const chatIndex = result.findIndex(item => item.id === 'chat')
  placeMissingAfter('theme-tasks', result[chatIndex + 1]?.id === 'anti' ? 'anti' : 'chat')
  return result
}

// Stateful half (localStorage + server sync + change events) lives in
// stores/navPreferenceStore.ts — config stays a leaf of pure constants.
