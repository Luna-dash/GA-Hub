import { describe, expect, it } from 'vitest'
import {
  didGrowWhilePinnedAtBottom,
  isBottomClamped,
  isNearBottom,
  normalizeSavedScrollPosition,
  resolveActiveTurnIndex,
  trimScrollPositions,
} from './transcriptViewport'

describe('transcriptViewport pure helpers', () => {
  it('checks bottom proximity and bottom clamping accurately', () => {
    expect(isNearBottom(930, 1500, 500)).toBe(true)
    expect(isNearBottom(900, 1500, 500)).toBe(false)
    expect(isNearBottom(921, 1500, 500)).toBe(true)

    expect(isBottomClamped(0, 0, 500)).toBe(false)
    expect(isBottomClamped(998, 1500, 500)).toBe(true)
    expect(isBottomClamped(995, 1500, 500)).toBe(false)
  })

  it('distinguishes bottom layout growth from uninitialized mounts and upward scrolls', () => {
    expect(
      didGrowWhilePinnedAtBottom(
        { top: 0, height: 0, clientHeight: 0 },
        { top: 100, height: 2000, clientHeight: 500 },
      ),
    ).toBe(false)

    expect(
      didGrowWhilePinnedAtBottom(
        { top: 960, height: 1500, clientHeight: 500 },
        { top: 960, height: 1850, clientHeight: 500 },
      ),
    ).toBe(true)

    expect(
      didGrowWhilePinnedAtBottom(
        { top: 960, height: 1500, clientHeight: 500 },
        { top: 400, height: 1850, clientHeight: 500 },
      ),
    ).toBe(false)
  })

  it('normalizes both key-based and legacy pixel scroll persistence entries', () => {
    expect(normalizeSavedScrollPosition(null)).toBeNull()
    expect(normalizeSavedScrollPosition({})).toBeNull()
    expect(normalizeSavedScrollPosition({ key: 'turn-3', stuck: false })).toEqual({
      key: 'turn-3',
      stuck: false,
    })
    expect(normalizeSavedScrollPosition({ scrollTop: 420, stuck: false })).toEqual({
      key: '',
      stuck: false,
      scrollTop: 420,
    })
    expect(normalizeSavedScrollPosition({ scrollTop: Number.NaN, stuck: true })).toBeNull()
  })

  it('trims persisted positions to the newest entries', () => {
    const positions = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`s-${index}`, { key: `k-${index}`, stuck: true }]),
    )
    expect(trimScrollPositions(positions, 3)).toEqual({
      's-2': { key: 'k-2', stuck: true },
      's-3': { key: 'k-3', stuck: true },
      's-4': { key: 'k-4', stuck: true },
    })
  })

  it('resolves the active turn index from item turn boundaries', () => {
    expect(resolveActiveTurnIndex([], 0)).toBe(-1)
    expect(resolveActiveTurnIndex([0, 3, 7], 0)).toBe(0)
    expect(resolveActiveTurnIndex([0, 3, 7], 5)).toBe(1)
    expect(resolveActiveTurnIndex([0, 3, 7], 9)).toBe(2)
  })
})
