import { type ReactNode, useEffect, useRef, useState } from 'react'
import { queryDesktopBackendReadiness } from './desktopBootstrap'
import { isTauriRuntime } from './runtimeConfig'

const READY_POLL_MS = 150

type BootstrapState =
  | { phase: 'starting' }
  | { phase: 'ready' }
  | { phase: 'failed'; error: string }

/** Boot-loader overlay protocol (public/gahub-loader.js). */
declare global {
  interface Window {
    __GA_HUB_HIDE_LOADING__?: () => void
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const tauri = isTauriRuntime()
  const [state, setState] = useState<BootstrapState>(
    tauri ? { phase: 'starting' } : { phase: 'ready' },
  )
  const hideLoaderRef = useRef(() => {
    // The overlay lives outside React (index.html + gahub-loader.js).
    try { window.__GA_HUB_HIDE_LOADING__?.() } catch { /* loader absent */ }
  })

  useEffect(() => {
    if (!tauri) return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        const ready = await queryDesktopBackendReadiness()
        if (cancelled) return
        if (ready) {
          hideLoaderRef.current()
          setState({ phase: 'ready' })
          return
        }
        timer = window.setTimeout(poll, READY_POLL_MS)
      } catch (error) {
        if (!cancelled) {
          hideLoaderRef.current()
          setState({ phase: 'failed', error: errorMessage(error) })
        }
      }
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [tauri])

  if (state.phase === 'starting') return null

  if (state.phase === 'failed') {
    return (
      <div className="relative z-[10001] flex h-screen w-screen items-center justify-center bg-bg">
        <div className="max-w-md text-center space-y-4 px-6">
          <div className="text-rose-400 text-base font-medium">桌面后端启动失败</div>
          <div className="text-slate-400 text-sm break-all whitespace-pre-wrap font-mono bg-bg-card border border-line rounded-lg p-3">
            {state.error}
          </div>
          <div className="text-slate-500 text-xs">请关闭并重新启动 GA-Hub。</div>
        </div>
      </div>
    )
  }

  return children
}
