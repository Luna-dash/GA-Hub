import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { queryDesktopBackendReadiness } from './desktopBootstrap'
import { isTauriRuntime } from './runtimeConfig'
import { waitForDesktopRestart } from '@/utils/backendRestart'
import { restartDesktopBackend } from '@/utils/desktop'
import { Z_LAYERS } from '@/config/zLayers'

/** Boot cadence: the loader overlay is up while the sidecar is still extracting. */
export const BOOT_POLL_MS = 150
/**
 * Steady-state liveness cadence. The shell's own watchdog turns a dead sidecar
 * into a failed phase within ~250 ms; this only decides how fast the SPA notices,
 * so it stays cheap — one `invoke` per tick and no HTTP traffic.
 */
export const LIVENESS_POLL_MS = 3000

type GateState =
  | { phase: 'starting' }
  | { phase: 'ready' }
  /**
   * The backend reached readiness and then failed. Children stay mounted
   * underneath a full-screen overlay: the SPA cannot do useful work against a
   * dead backend, but keeping it alive preserves state for the restart path.
   */
  | { phase: 'lost'; error: string }
  /** Never reached readiness, so there is nothing worth keeping mounted. */
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

interface GatePanelProps {
  title: string
  message: string
  hint: string
  restarting: boolean
  onRestart: () => void
}

function GatePanel({ title, message, hint, restarting, onRestart }: GatePanelProps) {
  return (
    <div className="max-w-md space-y-4 px-6 text-center">
      <div className="text-status-danger text-base font-medium">{title}</div>
      <div className="text-slate-400 text-sm break-all whitespace-pre-wrap font-mono bg-bg-card border border-line rounded-lg p-3">
        {message}
      </div>
      <button
        type="button"
        onClick={onRestart}
        disabled={restarting}
        className="px-4 py-2 rounded-lg bg-accent text-white text-sm hover:brightness-110 disabled:opacity-40"
      >
        {restarting ? '正在重启后端…' : '重启后端'}
      </button>
      <div className="text-slate-500 text-xs">{hint}</div>
    </div>
  )
}

export function DesktopRuntimeGate({ children }: { children: ReactNode }) {
  const tauri = isTauriRuntime()
  const [state, setState] = useState<GateState>(
    tauri ? { phase: 'starting' } : { phase: 'ready' },
  )
  const [restarting, setRestarting] = useState(false)
  const hideLoaderRef = useRef(() => {
    // The overlay lives outside React (index.html + gahub-loader.js).
    try { window.__GA_HUB_HIDE_LOADING__?.() } catch { /* loader absent */ }
  })

  const restart = useCallback(async () => {
    setRestarting(true)
    try {
      await restartDesktopBackend()
      // Readiness — not an HTTP probe — proves the NEW process is live: the
      // command returns while the old one is still inside its stop window.
      await waitForDesktopRestart()
      window.location.reload()
    } catch (error) {
      setRestarting(false)
      const message = `重启后端失败：${errorMessage(error)}`
      setState(prev => (
        prev.phase === 'failed' ? { phase: 'failed', error: message } : { phase: 'lost', error: message }
      ))
    }
  }, [])

  // Boot: poll until the shell reports a live sidecar, or surface why it cannot.
  useEffect(() => {
    if (!tauri || state.phase !== 'starting') return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      try {
        if (await queryDesktopBackendReadiness()) {
          if (cancelled) return
          hideLoaderRef.current()
          setState({ phase: 'ready' })
          return
        }
      } catch (error) {
        if (!cancelled) {
          hideLoaderRef.current()
          setState({ phase: 'failed', error: errorMessage(error) })
        }
        return
      }
      if (!cancelled) timer = window.setTimeout(poll, BOOT_POLL_MS)
    }

    void poll()
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [tauri, state.phase])

  // Liveness: the shell owns the sidecar for the whole session, so the gate keeps
  // asking. Without this the SPA only ever checked readiness at boot, which made a
  // post-ready crash indistinguishable from a healthy backend — the shell knew,
  // nobody displayed it, and every request just failed.
  useEffect(() => {
    if (!tauri || state.phase !== 'ready') return
    let cancelled = false
    let timer: number | undefined

    const tick = async () => {
      try {
        // `true` keeps everything as-is; `false` means the shell is moving the
        // backend (Stopping/Spawning/Running — a restart in progress, with its own
        // progress UI), so it must NOT be reported as a failure. Only a rejected
        // probe is evidence of a terminal failure.
        await queryDesktopBackendReadiness()
      } catch (error) {
        if (cancelled) return
        setState({ phase: 'lost', error: errorMessage(error) })
        return
      }
      if (!cancelled) timer = window.setTimeout(tick, LIVENESS_POLL_MS)
    }

    timer = window.setTimeout(tick, LIVENESS_POLL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [tauri, state.phase])

  if (state.phase === 'starting') return null

  if (state.phase === 'failed') {
    return (
      <div className="relative flex h-screen w-screen items-center justify-center bg-bg" style={{ zIndex: Z_LAYERS.gate }}>
        <GatePanel
          title="桌面后端启动失败"
          message={state.error}
          hint="也可以关闭并重新启动 GA-Hub。"
          restarting={restarting}
          onRestart={() => void restart()}
        />
      </div>
    )
  }

  return (
    <>
      {children}
      {state.phase === 'lost' && (
        <div
          role="alertdialog"
          aria-modal="true"
          className="fixed inset-0 flex items-center justify-center bg-bg"
          style={{ zIndex: Z_LAYERS.gate }}
        >
          <GatePanel
            title="后端已断开"
            message={state.error}
            hint="重启只影响后端进程：端口与会话不变，界面会自动重新加载。"
            restarting={restarting}
            onRestart={() => void restart()}
          />
        </div>
      )}
    </>
  )
}
