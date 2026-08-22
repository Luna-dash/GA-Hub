/**
 * Poll the backend until it answers a setup-status probe after a sidecar
 * restart. Transport failures are expected while the old process exits and
 * the new one binds, so they are swallowed until the deadline.
 */
import { api } from '@/api/client'

export interface WaitForBackendOptions {
  timeoutMs?: number
  intervalMs?: number
  delay?: (ms: number) => Promise<void>
  fetchStatus?: () => Promise<{ configured?: boolean } | null>
}

export async function waitForBackendReady(opts: WaitForBackendOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const intervalMs = opts.intervalMs ?? 500
  const delay = opts.delay ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetchStatus = opts.fetchStatus ?? (() => api.setupStatus())
  const deadline = Date.now() + timeoutMs

  for (;;) {
    try {
      const status = await fetchStatus()
      if (status?.configured) return
    } catch {
      // Backend is mid-restart — keep polling until the deadline.
    }
    if (Date.now() >= deadline) {
      throw new Error('等待后端重启超时（30s）')
    }
    await delay(intervalMs)
  }
}
