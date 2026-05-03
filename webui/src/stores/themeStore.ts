// Theme store — controls dark/light mode via the <html> class.
//
// Default behaviour: respect localStorage if set, else respect the user's
// OS preference (prefers-color-scheme). Persisted in localStorage so a
// reload doesn't flash the wrong theme. main.tsx applies the theme to
// <html> *before* React mounts (see main.tsx) so there's no FOUC.

import { create } from 'zustand'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'ga-admin.theme'

function detectSystem(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function loadInitialTheme(): Theme {
  if (typeof localStorage === 'undefined') return detectSystem()
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'light' || v === 'dark') return v
  return detectSystem()
}

export function applyTheme(t: Theme): void {
  const el = document.documentElement
  el.classList.toggle('light', t === 'light')
  el.classList.toggle('dark', t === 'dark')
}

interface ThemeState {
  theme: Theme
  setTheme: (t: Theme) => void
  toggle: () => void
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: loadInitialTheme(),

  setTheme: (t) => {
    applyTheme(t)
    try { localStorage.setItem(STORAGE_KEY, t) } catch {}
    set({ theme: t })
  },

  toggle: () => {
    const next: Theme = get().theme === 'dark' ? 'light' : 'dark'
    get().setTheme(next)
  },
}))
