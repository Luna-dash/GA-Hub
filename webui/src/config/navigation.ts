import { storageKeys } from '@/config/storageKeys'

export type NavIconName =
  | 'dashboard' | 'chat' | 'anti' | 'conversations' | 'memory'
  | 'conductor' | 'goalHive' | 'mykey' | 'themeTasks' | 'tasks' | 'autonomous' | 'tokens' | 'settings'

export interface NavItem { id: string; to: string; label: string; icon: NavIconName }
export interface NavPreference { id: string; visible: boolean }

export const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', to: '/dashboard', label: '状态面板', icon: 'dashboard' },
  { id: 'chat', to: '/chat', label: '实时聊天', icon: 'chat' },
  { id: 'anti', to: '/anti', label: 'Anti 聊天', icon: 'anti' },
  { id: 'theme-tasks', to: '/theme-tasks', label: '主题任务', icon: 'themeTasks' },
  { id: 'conductor', to: '/conductor', label: '指挥模式', icon: 'conductor' },
  { id: 'goal-hive', to: '/goal-hive', label: 'Goal模式', icon: 'goalHive' },
  { id: 'conversations', to: '/conversations', label: '历史对话', icon: 'conversations' },
  { id: 'memory', to: '/memory', label: '记忆体系', icon: 'memory' },
  { id: 'mykey', to: '/mykey', label: 'LLM管理', icon: 'mykey' },
  { id: 'tasks', to: '/tasks', label: '定时任务', icon: 'tasks' },
  { id: 'autonomous', to: '/autonomous', label: '自主进化', icon: 'autonomous' },
  { id: 'tokens', to: '/tokens', label: '用量统计', icon: 'tokens' },
]

export const NAV_PREFERENCES_EVENT = 'gahub:nav-preferences'

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
  const savedIds = new Set(result.map(item => item.id))
  for (const { id } of NAV_ITEMS) if (!savedIds.has(id)) result.push({ id, visible: true })
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
