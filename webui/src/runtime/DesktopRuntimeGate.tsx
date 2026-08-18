import { type ReactNode, useEffect, useState } from 'react'
import { queryDesktopBackendReadiness } from './desktopBootstrap'
import { isTauriRuntime } from './runtimeConfig'

const READY_POLL_MS = 150

type BootstrapState =
  | { phase: 'starting' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: string }

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const tauri = isTauriRuntime()
  const [state, setState] = useState<BootstrapState>(
    tauri ? { phase: 'starting' } : { phase: 'ready' },
  )

  useEffect(() => {
    if (!tauri) return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const ready = await queryDesktopBackendReadiness()
        if (cancelled) return
        if (ready) {
          setState({ phase: 'ready' })
          return
        }
        timer = window.setTimeout(poll, READY_POLL_MS)
      } catch (error) {
        if (!cancelled) setState({ phase: 'failed', error: errorMessage(error) })
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [tauri])

  if (state.phase === 'ready') return children

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg">
      <div className="max-w-md text-center space-y-4 px-6">
        {state.phase === 'starting' ? (
          <>
            <div className="mx-auto w-7 h-7 rounded-full border-2 border-slate-600 border-t-accent animate-spin" />
            <div className="text-slate-300 text-sm">正在启动本地服务…</div>
          </>
        ) : (
          <>
            <div className="text-rose-400 text-base font-medium">桌面后端启动失败</div>
            <div className="text-slate-400 text-sm break-all whitespace-pre-wrap font-mono bg-bg-card border border-line rounded-lg p-3">
              {state.error}
            </div>
            <div className="text-slate-500 text-xs">请关闭并重新启动 GA-Hub。</div>
          </>
        )}
      </div>
    </div>
  )
}
