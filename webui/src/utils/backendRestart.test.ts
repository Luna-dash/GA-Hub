import { describe, expect, it, vi } from 'vitest'
import { waitForDesktopRestart } from './backendRestart'

const noDelay = () => Promise.resolve()

describe('waitForDesktopRestart', () => {
  it('resolves as soon as the sidecar lifecycle reports ready', async () => {
    const fetchReady = vi.fn().mockResolvedValue(true)
    await expect(waitForDesktopRestart({ delay: noDelay, fetchReady })).resolves.toBeUndefined()
    expect(fetchReady).toHaveBeenCalledOnce()
  })

  it('keeps polling through ready=false while the sidecar stops and respawns', async () => {
    const fetchReady = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    await expect(waitForDesktopRestart({ delay: noDelay, fetchReady })).resolves.toBeUndefined()
    expect(fetchReady).toHaveBeenCalledTimes(3)
  })

  it('surfaces a terminal respawn failure instead of polling on', async () => {
    const fetchReady = vi.fn().mockRejectedValue(new Error('GA-Hub desktop restart: boom'))
    await expect(waitForDesktopRestart({ delay: noDelay, fetchReady })).rejects.toThrow('boom')
    expect(fetchReady).toHaveBeenCalledOnce()
  })

  it('throws once the deadline passes without a ready sidecar', async () => {
    const fetchReady = vi.fn().mockResolvedValue(false)
    await expect(
      waitForDesktopRestart({
        delay: noDelay,
        fetchReady,
        timeoutMs: 0,
      }),
    ).rejects.toThrow('超时')
    expect(fetchReady).toHaveBeenCalledOnce()
  })

  it('reports the configured deadline in the timeout message', async () => {
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValue(10_000)
    const fetchReady = vi.fn().mockResolvedValue(false)
    try {
      await expect(
        waitForDesktopRestart({ delay: noDelay, fetchReady, timeoutMs: 5_000 }),
      ).rejects.toThrow('超时（5s）')
    } finally {
      nowSpy.mockRestore()
    }
  })
})
