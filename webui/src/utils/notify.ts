// One themed notification entry; no OS plugin or backend notification fallback.
import { create } from 'zustand'
import { requestDialog } from '@/stores/dialogStore'
import { storageKeys } from '@/config/storageKeys'

const LS_KEY = storageKeys.desktopNotifications
function readOptIn(): boolean {
  try { return localStorage.getItem(LS_KEY) !== '0' } catch { return true }
}
interface NotifyStore {
  optedIn: boolean
  backendName: string
  setOptIn: (v: boolean) => void
  refresh: () => Promise<void>
}
export const useNotifyStore = create<NotifyStore>((set) => ({
  optedIn: readOptIn(),
  backendName: '主题消息窗',
  refresh: async () => { set({ optedIn: readOptIn(), backendName: '主题消息窗' }) },
  setOptIn: (v) => {
    try { localStorage.setItem(LS_KEY, v ? '1' : '0') } catch { /* storage unavailable */ }
    set({ optedIn: v })
  },
}))
// Per-event throttling: simultaneous completions of different sessions are retained.
const lastByTag = new Map<string, number>()
export async function notify(
  title: string,
  opts: { body?: string; tag?: string; force?: boolean; onOpen?: () => void } = {},
): Promise<boolean> {
  if (!useNotifyStore.getState().optedIn) return false
  if (!opts.force && document.visibilityState === 'visible' && document.hasFocus()) return false
  const tag = opts.tag ?? title
  const now = Date.now()
  if (!opts.force && now - (lastByTag.get(tag) ?? -Infinity) < 800) return false
  lastByTag.set(tag, now)
  for (const [key, time] of lastByTag) if (now - time > 60_000) lastByTag.delete(key)
  const opened = await requestDialog<boolean | null>({
    kind: 'notification', title: title.slice(0, 100), message: opts.body,
    confirmText: opts.onOpen ? '查看会话' : '知道了', cancelText: '稍后',
  })
  if (opened && opts.onOpen) opts.onOpen()
  return true
}
