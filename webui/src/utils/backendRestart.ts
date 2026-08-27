/**
 * Wait for the sidecar respawn requested via `restart_backend` to finish.
 *
 * Readiness is the Tauri lifecycle state (`desktop_backend_ready`), not an
 * HTTP probe: the command returns while the OLD process is still serving
 * during its graceful-stop window, so `/api/setup` would answer `configured`
 * immediately and make us reload into a backend that is about to die. The
 * lifecycle state machine returns false through Stopping/Spawning/Running
 * and flips to true only after the NEW process passes the HTTP readiness
 * probe, so it can never mistake the old instance for the new one. A
 * rejected probe means the respawn failed terminally — surface that error
 * instead of polling on.
 */
import { queryDesktopBackendReadiness } from '@/runtime/desktopBootstrap'

/** Mirrors READY_TIMEOUT in src-tauri/src/main.rs: cold Python starts on
 * slow machines can outlive a short frontend deadline, which used to
 * produce a false "restart failed" toast while the backend was still up. */
const BACKEND_READY_TIMEOUT_MS = 120_000

export interface WaitForRestartOptions {
  timeoutMs?: number
  intervalMs?: number
  delay?: (ms: number) => Promise<void>
  fetchReady?: () => Promise<boolean>
}

export async function waitForDesktopRestart(opts: WaitForRestartOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? BACKEND_READY_TIMEOUT_MS
  const intervalMs = opts.intervalMs ?? 500
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetchReady = opts.fetchReady ?? (() => queryDesktopBackendReadiness())
  const deadline = Date.now() + timeoutMs

  for (;;) {
    if (await fetchReady()) return
    if (Date.now() >= deadline) {
      throw new Error(`等待后端重启超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    await delay(intervalMs)
  }
}
