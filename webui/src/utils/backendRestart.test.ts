import { describe, expect, it, vi } from 'vitest'
import { waitForBackendReady } from './backendRestart'

const noDelay = () => Promise.resolve()

describe('waitForBackendReady', () => {
  it('resolves as soon as the backend reports configured', async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ configured: true })
    await expect(waitForBackendReady({ delay: noDelay, fetchStatus })).resolves.toBeUndefined()
    expect(fetchStatus).toHaveBeenCalledOnce()
  })

  it('keeps polling through transport failures while the sidecar restarts', async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ configured: false })
      .mockResolvedValue({ configured: true })
    await expect(waitable()).resolves.toBeUndefined()
    async function waitable() {
      await waitForBackendReady({ delay: noDelay, fetchStatus })
    }
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })

  it('throws once the deadline passes without a configured backend', async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ configured: false })
    await expect(
      waitForBackendReady({
        delay: noDelay,
        fetchStatus,
        timeoutMs: 0,
      }),
    ).rejects.toThrow('超时')
  })
})
