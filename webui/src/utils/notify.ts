// Desktop / OS notifications — opt-in only, throttled, and silent when the
// app window currently has focus (no point firing OS notifs the user is
// staring at).
//
// We're inside a PyWebView shell, so the browser ``Notification`` API is
// unusable (WKWebView/WebView2 pin permission to "denied"). Instead we POST
// to the backend, which shells out to the native notifier (macOS osascript /
// Windows PowerShell / Linux notify-send). See ``server/services/notify_service.py``.
//
// The OPT-IN flag still lives in localStorage — the toggle on the Settings
// page just flips that bit; there's no permission state to track.

import { create } from 'zustand'
import { api } from '@/api/client'

const LS_KEY = 'ga.desktopNotifications.v1'

function readOptIn(): boolean {
  try {
    const v = localStorage.getItem(LS_KEY)
    // Default to ON if user never set it (null). They can turn it off in Settings.
    return v === null ? true : v === '1'
  } catch {
    return true  // Default to enabled if localStorage unavailable
  }
}
function writeOptIn(v: boolean) {
  try { v ? localStorage.setItem(LS_KEY, '1') : localStorage.removeItem(LS_KEY) } catch {}
}

interface NotifyStore {
  optedIn: boolean
  backendName: string             // e.g. "macOS · osascript"
  setOptIn: (v: boolean) => void
  refresh: () => Promise<void>    // re-fetches backend info
}

export const useNotifyStore = create<NotifyStore>((set) => ({
  optedIn: readOptIn(),
  backendName: '',

  refresh: async () => {
    set({ optedIn: readOptIn() })
    try {
      const info = await api.notifyInfo()
      set({ backendName: info.backend })
    } catch {
      set({ backendName: '后端不可用' })
    }
  },

  setOptIn: (v: boolean): void => {
    writeOptIn(v)
    set({ optedIn: v })
  },
}))

let lastNotifyAt = 0       // simple per-window throttle so we don't spam

export function notify(
  title: string,
  opts: { body?: string; tag?: string; force?: boolean } = {},
): void {
  if (!useNotifyStore.getState().optedIn) return
  // Don't disturb the user when they're already looking at the window,
  // unless caller explicitly forces it (e.g. error toasts).
  if (!opts.force) {
    if (document.visibilityState === 'visible' && document.hasFocus()) return
  }
  const now = Date.now()
  if (now - lastNotifyAt < 800) return    // 800ms throttle, plenty for our use
  lastNotifyAt = now

  // Fire-and-forget — backend has its own throttle and never raises.
  api.notify(title, opts.body || '').catch(() => { /* swallow */ })
}
