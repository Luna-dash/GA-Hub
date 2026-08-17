import { describe, expect, it } from 'vitest'
import { buildVirtualOffsets, computeVirtualRange, virtualIndexAtOffset } from './virtualList'

describe('virtual chat layout', () => {
  it('builds cumulative offsets and normalizes invalid sizes', () => {
    expect(buildVirtualOffsets(3, (index) => [10, 0, Number.NaN][index])).toEqual([0, 10, 11, 12])
  })

  it('finds the item containing a scroll offset', () => {
    const offsets = [0, 20, 50, 90]
    expect(virtualIndexAtOffset(offsets, -10)).toBe(0)
    expect(virtualIndexAtOffset(offsets, 0)).toBe(0)
    expect(virtualIndexAtOffset(offsets, 20)).toBe(1)
    expect(virtualIndexAtOffset(offsets, 89)).toBe(2)
    expect(virtualIndexAtOffset(offsets, 1000)).toBe(2)
  })

  it('returns top and bottom spacers for a bounded window', () => {
    const offsets = [0, 100, 250, 450, 700, 1000]
    expect(computeVirtualRange(offsets, 450, 100, 50)).toEqual({
      start: 2,
      end: 4,
      top: 250,
      bottom: 300,
    })
  })

  it('renders all items when the viewport covers the list', () => {
    const offsets = [0, 20, 40, 60]
    expect(computeVirtualRange(offsets, 0, 100, 0)).toEqual({
      start: 0,
      end: 3,
      top: 0,
      bottom: 0,
    })
  })
})
