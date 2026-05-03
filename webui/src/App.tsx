import { Suspense, lazy, useEffect } from 'react'
import { Route, Routes } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { SidebarNav } from '@/components/SidebarNav'
import { DialogHost } from '@/components/DialogHost'
import { CommandPalette } from '@/components/CommandPalette'
import { useAgentStore } from '@/stores/agentStore'
import { useChatStore } from '@/stores/chatStore'
import { useDocumentTitle } from '@/utils/useDocumentTitle'
import { useDesktopNotifyEffects } from '@/utils/useDesktopNotifyEffects'
import { api } from '@/api/client'
import { Dashboard } from '@/pages/Dashboard'
import { LiveChat } from '@/pages/LiveChat'
import { WechatBot } from '@/pages/WechatBot'
import { Conversations } from '@/pages/Conversations'
import { Memory } from '@/pages/Memory'
import { Skills } from '@/pages/Skills'
import { Llms } from '@/pages/Llms'
import { MyKey } from '@/pages/MyKey'
import { Settings } from '@/pages/Settings'

// Autonomous page pulls in cron-parser + cronstrue (~60KB gzipped).
// Lazy-load it so visitors who never open /autonomous don't pay for it.
const Autonomous = lazy(() =>
  import('@/pages/Autonomous').then((m) => ({ default: m.Autonomous })),
)

export default function App() {
  const start = useAgentStore((s) => s.start)
  const stop = useAgentStore((s) => s.stop)
  const chatStart = useChatStore((s) => s.start)
  const chatStop = useChatStore((s) => s.stop)

  // Reflect agent / chat state in the browser tab title.
  useDocumentTitle()

  // Fire OS notifications when streams finish / wechat msgs arrive (opt-in).
  useDesktopNotifyEffects()

  // Probe setup status — if backend has no GA_ROOT, force the Settings page
  const { data: setup, isLoading } = useQuery({
    queryKey: ['setup'],
    queryFn: api.setupStatus,
    refetchInterval: (query) => {
      const configured = (query.state.data as { configured?: boolean } | undefined)?.configured
      return configured ? false : 5000
    },
  })

  useEffect(() => {
    if (setup?.configured) {
      start()
      chatStart()
      return () => {
        stop()
        chatStop()
      }
    }
  }, [setup?.configured, start, stop, chatStart, chatStop])

  if (isLoading) {
    return (
      <div className="flex h-screen w-screen items-center justify-center text-slate-500 text-sm">
        正在连接后端…
      </div>
    )
  }

  // Setup mode: backend has no GA_ROOT yet. Show only the Settings page.
  if (!setup?.configured) {
    return (
      <div className="flex h-screen w-screen overflow-hidden">
        <main className="flex-1 min-w-0 bg-bg">
          <Settings initialMode="setup" />
        </main>
        <DialogHost />
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <SidebarNav />
      <main className="flex-1 min-w-0 bg-bg">
        <Suspense fallback={<div className="h-full flex items-center justify-center text-slate-500 text-sm">载入中…</div>}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/chat" element={<LiveChat />} />
            <Route path="/wechat" element={<WechatBot />} />
            <Route path="/conversations" element={<Conversations />} />
            <Route path="/conversations/:id" element={<Conversations />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/llms" element={<Llms />} />
            <Route path="/mykey" element={<MyKey />} />
            <Route path="/autonomous" element={<Autonomous />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </Suspense>
      </main>
      <DialogHost />
      <CommandPalette />
    </div>
  )
}
