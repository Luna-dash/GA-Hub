import { describe, expect, it, vi } from 'vitest'
import { createRafScheduler } from './rafScheduler'

describe('createRafScheduler', () => {
  it('coalesces repeated scheduling into one callback per animation frame', () => {
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const cancelFrame = vi.fn()
    const callback = vi.fn()
    const scheduler = createRafScheduler(callback, requestFrame, cancelFrame)

    scheduler.schedule()
    scheduler.schedule()
    scheduler.schedule()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()

    frames[0](16)
    expect(callback).toHaveBeenCalledTimes(1)

    scheduler.schedule()
    expect(requestFrame).toHaveBeenCalledTimes(2)
  })

  it('cancels a pending frame and prevents its callback from running', () => {
    let pending: FrameRequestCallback | undefined
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      pending = callback
      return 42
    })
    const cancelFrame = vi.fn()
    const callback = vi.fn()
    const scheduler = createRafScheduler(callback, requestFrame, cancelFrame)

    scheduler.schedule()
    scheduler.cancel()
    pending?.(16)

    expect(cancelFrame).toHaveBeenCalledWith(42)
    expect(callback).not.toHaveBeenCalled()
  })
})
