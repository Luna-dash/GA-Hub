import { Suspense, lazy, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SidebarNav } from '@/components/SidebarNav'
import { DialogHost } from '@/components/DialogHost'
import { ToastHost } from '@/components/ToastHost'
import { CommandPalette } from '@/components/CommandPalette'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAgentStore } from '@/stores/agentStore'
import { hydrateNavPreferences } from '@/stores/navPreferenceStore'
import { hydrateUiSettings } from '@/stores/uiSettingsStore'
import { api } from '@/api/client'
import { APP_PAGES } from '@/config/pages'
import { hubEventClient } from '@/runtime/hubEventClient'
import { queryKeys } from '@/queries/queryKeys'
import { RuntimeEffects } from '@/runtime/RuntimeEffects'
import { initFontAppearance, syncFontAppearance } from '@/utils/fontLoader'
import { initThemeAppearance } from '@/utils/themeAppearance'

const routeFallback = (
  <div className="h-full flex items-center justify-center text-ink-faint text-sm">载入中…</div>
)

// Keep route pages out of the startup bundle. The shell (stores, sockets,
// sidebar, command palette) loads first; individual feature pages load on demand.
const PAGE_ROUTES = APP_PAGES.map((page) => ({
  ...page,
  Component: lazy(page.loader),
}))
const ConversationsPage = PAGE_ROUTES.find((page) => page.id === 'conversations')!.Component
const SettingsPage = PAGE_ROUTES.find((page) => page.id === 'settings')!.Component

export default function App() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const start = useAgentStore((s) => s.start)
  const stop = useAgentStore((s) => s.stop)

  useEffect(() => {
    initThemeAppearance()
    initFontAppearance()
    void syncFontAppearance()
  }, [])

  // Probe setup status — if backend has no GA_ROOT, force the Settings page
  const { data: setup, isLoading, isError, error, refetch, failureCount } = useQuery({
    queryKey: queryKeys.setup,
    queryFn: api.setupStatus,
    refetchInterval: (query) => {
      const configured = (query.state.data as { configured?: boolean } | undefined)?.configured
      return configured ? false : 5000
    },
  })

  useEffect(() => {
    if (setup?.configured) {
      void hydrateNavPreferences()
      void hydrateUiSettings()
      start()
      hubEventClient.start()
      return () => {
        hubEventClient.stop()
        stop()
      }
    }
  }, [setup?.configured, start, stop])

  // Persistent backend error: show actionable fallback instead of an
  // infinite "正在连接后端…" spinner. retry: 1 in main.tsx means after
  // 2 attempts isLoading flips false; without this branch the SPA would
  // silently fall through to setup mode with no hint about what failed.
  if (isError && !setup) {
    const msg = (error as { message?: string } | null)?.message || String(error || 'unknown')
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-bg">
        <div className="max-w-md text-center space-y-4 px-6">
          <div className="text-status-danger text-base font-medium">无法连接后端</div>
          <div className="text-ink-muted text-sm break-all whitespace-pre-wrap font-mono bg-bg-card border border-line rounded-lg p-3">
            {msg}
          </div>
          <div className="text-ink-faint text-xs">
            已尝试 {failureCount} 次。后端可能仍在启动，或某个路由抛了异常。
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="ga-solid-primary px-4 py-2 rounded-lg text-sm"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center text-ink-faint text-sm">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 rounded-full border-2 border-line border-t-accent animate-spin" />
          <div>正在连接后端…</div>
        </div>
      </div>
    )
  }

  // Setup mode: backend has no GA_ROOT yet. Show only the Settings page.
  if (!setup?.configured) {
    return (
      <div className="app-aurora flex h-screen w-screen overflow-hidden">
        <main className="flex-1 min-w-0 bg-transparent">
          <ErrorBoundary resetKey="setup">
            <Suspense fallback={routeFallback}>
              <SettingsPage initialMode="setup" />
            </Suspense>
          </ErrorBoundary>
        </main>
        <DialogHost />
        <ToastHost />
      </div>
    )
  }

  return (
    <div className="app-aurora flex h-screen w-screen overflow-hidden">
      <RuntimeEffects />
      <SidebarNav />
      <main className="flex-1 min-w-0 bg-transparent">
        <ErrorBoundary resetKey={pathname} onNavigateHome={() => navigate('/chat')}>
          <Suspense fallback={<div className="h-full flex items-center justify-center text-ink-faint text-sm">载入中…</div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/chat" replace />} />
              {PAGE_ROUTES.map(({ id, to, Component }) => (
                <Route key={id} path={to} element={<Component />} />
              ))}
              <Route path="/conversations/:id" element={<ConversationsPage />} />
              <Route path="*" element={<Navigate to="/chat" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <DialogHost />
      <CommandPalette />
      <ToastHost />
    </div>
  )
}
