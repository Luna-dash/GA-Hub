import { Suspense, lazy, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SidebarNav } from '@/components/SidebarNav'
import { DialogHost } from '@/components/DialogHost'
import { ToastHost } from '@/components/ToastHost'
import { CommandPalette } from '@/components/CommandPalette'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAgentStore } from '@/stores/agentStore'
import { useDocumentTitle } from '@/utils/useDocumentTitle'
import { useDesktopNotifyEffects } from '@/utils/useDesktopNotifyEffects'
import { hydrateNavPreferences } from '@/config/navigation'
import { api } from '@/api/client'

const routeFallback = (
  <div className="h-full flex items-center justify-center text-slate-500 text-sm">载入中…</div>
)

// Keep route pages out of the startup bundle. The shell (stores, sockets,
// sidebar, command palette) loads first; individual feature pages load on demand.
const Dashboard = lazy(() => import('@/pages/Dashboard'))
const LiveChat = lazy(() => import('@/pages/LiveChat'))
const FeishuBot = lazy(() => import('@/pages/FeishuBot'))
const Conversations = lazy(() => import('@/pages/Conversations'))
const Memory = lazy(() => import('@/pages/Memory'))
const GoalHive = lazy(() => import('@/pages/GoalHive'))
const Conductor = lazy(() => import('@/pages/Conductor'))
const MyKey = lazy(() => import('@/pages/MyKey'))
const Settings = lazy(() => import('@/pages/Settings'))
const Tasks = lazy(() => import('@/pages/Tasks'))
const Autonomous = lazy(() => import('@/pages/Autonomous'))
const TokenStats = lazy(() => import('@/pages/TokenStats'))

export default function App() {
  const start = useAgentStore((s) => s.start)
  const stop = useAgentStore((s) => s.stop)

  // Reflect agent / chat state in the browser tab title.
  useDocumentTitle()

  // Fire OS notifications when streams finish / bot messages arrive (opt-in).
  useDesktopNotifyEffects()

  // Probe setup status — if backend has no GA_ROOT, force the Settings page
  const { data: setup, isLoading, isError, error, refetch, failureCount } = useQuery({
    queryKey: ['setup'],
    queryFn: api.setupStatus,
    refetchInterval: (query) => {
      const configured = (query.state.data as { configured?: boolean } | undefined)?.configured
      return configured ? false : 5000
    },
  })

  useEffect(() => {
    if (setup?.configured) {
      void hydrateNavPreferences()
      start()
      return () => {
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
          <div className="text-rose-400 text-base font-medium">无法连接后端</div>
          <div className="text-slate-400 text-sm break-all whitespace-pre-wrap font-mono bg-bg-card border border-line rounded-lg p-3">
            {msg}
          </div>
          <div className="text-slate-500 text-xs">
            已尝试 {failureCount} 次。后端可能仍在启动，或某个路由抛了异常。
          </div>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm hover:brightness-110"
          >
            重试
          </button>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center text-slate-500 text-sm">
        <div className="flex flex-col items-center gap-3">
          <div className="w-6 h-6 rounded-full border-2 border-slate-600 border-t-accent animate-spin" />
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
          <Suspense fallback={routeFallback}>
            <Settings initialMode="setup" />
          </Suspense>
        </main>
        <DialogHost />
      </div>
    )
  }

  return (
    <div className="app-aurora flex h-screen w-screen overflow-hidden">
      <SidebarNav />
      <main className="flex-1 min-w-0 bg-transparent">
        <ErrorBoundary>
          <Suspense fallback={<div className="h-full flex items-center justify-center text-slate-500 text-sm">载入中…</div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/chat" element={<LiveChat />} />
              <Route path="/feishu" element={<FeishuBot />} />
              <Route path="/conversations" element={<Conversations />} />
              <Route path="/conversations/:id" element={<Conversations />} />
              <Route path="/memory" element={<Memory />} />
              <Route path="/goal-hive" element={<GoalHive />} />
              <Route path="/conductor" element={<Conductor />} />
              <Route path="/mykey" element={<MyKey />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/autonomous" element={<Autonomous />} />
              <Route path="/tokens" element={<TokenStats />} />
              <Route path="/settings" element={<Settings />} />
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
