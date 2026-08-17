export interface VirtualRange {
  start: number
  end: number
  top: number
  bottom: number
}

/** Build the cumulative item offsets used by the chat window. */
export function buildVirtualOffsets(
  count: number,
  sizeForIndex: (index: number) => number,
): number[] {
  const offsets = new Array(Math.max(0, count) + 1).fill(0)
  for (let index = 0; index < count; index += 1) {
    const size = sizeForIndex(index)
    offsets[index + 1] = offsets[index] + (Number.isFinite(size) && size > 0 ? size : 1)
  }
  return offsets
}

/** Find the first offset whose end is greater than the requested position. */
export function virtualIndexAtOffset(offsets: ReadonlyArray<number>, position: number): number {
  if (offsets.length <= 1) return 0
  const target = Math.max(0, position)
  let low = 0
  let high = offsets.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (offsets[middle + 1] <= target) low = middle + 1
    else high = middle
  }
  return Math.min(low, offsets.length - 2)
}

/**
 * Return a bounded render window and the spacer sizes around it.
 * `scrollTop` is relative to the virtual list root, not the outer scroller.
 */
export function computeVirtualRange(
  offsets: ReadonlyArray<number>,
  scrollTop: number,
  viewportHeight: number,
  overscanPx = 800,
): VirtualRange {
  const count = Math.max(0, offsets.length - 1)
  if (count === 0) return { start: 0, end: 0, top: 0, bottom: 0 }

  const topPosition = Math.max(0, scrollTop - Math.max(0, overscanPx))
  const bottomPosition = Math.max(topPosition, scrollTop + Math.max(0, viewportHeight) + Math.max(0, overscanPx))
  const start = virtualIndexAtOffset(offsets, topPosition)
  const end = Math.min(count, virtualIndexAtOffset(offsets, bottomPosition) + 1)
  return {
    start,
    end: Math.max(start, end),
    top: offsets[start] ?? 0,
    bottom: Math.max(0, offsets[count] - (offsets[end] ?? offsets[count])),
  }
}
