export type NavIconName =
  | 'dashboard' | 'chat' | 'feishu' | 'conversations' | 'memory'
  | 'conductor' | 'goalHive' | 'mykey' | 'tasks' | 'autonomous' | 'tokens' | 'settings'

export interface NavItem { id: string; to: string; label: string; icon: NavIconName }
export interface NavPreference { id: string; visible: boolean }

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', to: '/dashboard', label: '状态面板', icon: 'dashboard' },
  { id: 'chat', to: '/chat', label: '实时聊天', icon: 'chat' },
  { id: 'conductor', to: '/conductor', label: '指挥模式', icon: 'conductor' },
  { id: 'goal-hive', to: '/goal-hive', label: 'Goal模式', icon: 'goalHive' },
  { id: 'feishu', to: '/feishu', label: '飞书BOT', icon: 'feishu' },
  { id: 'conversations', to: '/conversations', label: '历史对话', icon: 'conversations' },
  { id: 'memory', to: '/memory', label: '记忆体系', icon: 'memory' },
  { id: 'mykey', to: '/mykey', label: 'LLM管理', icon: 'mykey' },
  { id: 'tasks', to: '/tasks', label: '定时任务', icon: 'tasks' },
  { id: 'autonomous', to: '/autonomous', label: '自主进化', icon: 'autonomous' },
  { id: 'tokens', to: '/tokens', label: '用量统计', icon: 'tokens' },
]

export const NAV_PREFERENCES_EVENT = 'gahub:nav-preferences'
const STORAGE_KEY = 'gahub.nav.preferences.v1'

export const defaultNavPreferences = (): NavPreference[] => NAV_ITEMS.map(({ id }) => ({ id, visible: true }))

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
  for (const { id } of NAV_ITEMS) if (!result.some((item) => item.id === id)) result.push({ id, visible: true })
  return result
}

export function getNavPreferences(): NavPreference[] {
  try { return normalizeNavPreferences(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')) }
  catch { return defaultNavPreferences() }
}

export function setNavPreferences(value: NavPreference[]): NavPreference[] {
  const normalized = normalizeNavPreferences(value)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  window.dispatchEvent(new CustomEvent(NAV_PREFERENCES_EVENT, { detail: normalized }))
  return normalized
}

export function getVisibleNavItems(preferences = getNavPreferences()): NavItem[] {
  const byId = new Map(NAV_ITEMS.map((item) => [item.id, item]))
  return preferences.flatMap(({ id, visible }) => {
    const item = byId.get(id)
    return visible && item ? [item] : []
  })
}
