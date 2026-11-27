import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast, useToastStore } from './toastStore'

describe('toastStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
  })

  afterEach(() => {
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    vi.useRealTimers()
  })

  it('deduplicates active (kind, message) bursts by refreshing duration instead of stacking', () => {
    const firstId = toast.error('保存失败', 5000)
    vi.advanceTimersByTime(3000)
    const secondId = toast.error('保存失败', 5000)

    expect(secondId).toBe(firstId)
    expect(useToastStore.getState().items).toHaveLength(1)

    // Original timer would have expired at 5000ms; refreshed timer should keep it alive past +2500ms
    vi.advanceTimersByTime(2500)
    expect(useToastStore.getState().items).toHaveLength(1)

    // Expires after full refreshed duration
    vi.advanceTimersByTime(2600)
    expect(useToastStore.getState().items).toHaveLength(0)

    // Different kind with same message is NOT collapsed
    toast.success('保存失败', 2000)
    toast.error('保存失败', 2000)
    expect(useToastStore.getState().items).toHaveLength(2)
  })

  it('pauses and resumes remaining duration safely, including against dismiss races', () => {
    const id = toast.info('正在同步', 3000)
    vi.advanceTimersByTime(1000)
    useToastStore.getState().pause(id)

    // Even if time advances past 3000ms while paused, toast remains visible
    vi.advanceTimersByTime(5000)
    expect(useToastStore.getState().items).toHaveLength(1)

    useToastStore.getState().resume(id)
    vi.advanceTimersByTime(1900)
    expect(useToastStore.getState().items).toHaveLength(1)
    vi.advanceTimersByTime(200)
    expect(useToastStore.getState().items).toHaveLength(0)

    // Race check: dismiss while paused must not be resurrected by resume
    const id2 = toast.error('网络异常', 4000)
    vi.advanceTimersByTime(500)
    useToastStore.getState().pause(id2)
    useToastStore.getState().dismiss(id2)
    useToastStore.getState().resume(id2)
    vi.advanceTimersByTime(10000)
    expect(useToastStore.getState().items).toHaveLength(0)
  })
})
