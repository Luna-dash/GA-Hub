import {
  forwardRef,
  memo,
  type ForwardedRef,
  type ReactElement,
  type Ref,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { buildVirtualOffsets, computeVirtualRange, virtualIndexAtOffset } from '@/utils/virtualList'

export interface VirtualMessageListHandle {
  getFirstVisibleIndex: (offset?: number) => number
  scrollToIndex: (index: number, options?: { behavior?: ScrollBehavior; align?: 'start' | 'center' | 'end' }) => void
  getTotalSize: () => number
}

interface Props<T> {
  items: readonly T[]
  itemKey: (item: T, index: number) => string
  estimateSize: (item: T, index: number) => number
  renderItem: (item: T, index: number) => ReactNode
  scrollRef: RefObject<HTMLDivElement>
  pinnedToBottom?: boolean
  overscanPx?: number
  virtualizationThreshold?: number
}

const DEFAULT_OVERSCAN_PX = 900
const DEFAULT_THRESHOLD = 80

/**
 * A dependency-free variable-height window for the chat transcript.
 *
 * The outer scroll container remains owned by LiveChat so existing sticky
 * notices, utility controls and scroll anchoring keep their semantics. Rows
 * are measured when mounted; unseen rows use a conservative text-based
 * estimate until they enter the overscan window.
 */
export const VirtualMessageList = forwardRef(function VirtualMessageList<T>(
  {
    items,
    itemKey,
    estimateSize,
    renderItem,
    scrollRef,
    pinnedToBottom = false,
    overscanPx = DEFAULT_OVERSCAN_PX,
    virtualizationThreshold = DEFAULT_THRESHOLD,
  }: Props<T>,
  forwardedRef: ForwardedRef<VirtualMessageListHandle>,
) {
  const listRef = useRef<HTMLDivElement>(null)
  const measuredSizesRef = useRef(new Map<string, number>())
  const offsetsRef = useRef<number[]>([0])
  const viewportRef = useRef({ scrollTop: 0, height: 0, listTop: 0 })
  const [viewport, setViewport] = useState(viewportRef.current)
  const [layoutRevision, setLayoutRevision] = useState(0)

  const keys = useMemo(() => {
    const seen = new Map<string, number>()
    return items.map((item, index) => {
      const base = itemKey(item, index)
      const occurrence = seen.get(base) ?? 0
      seen.set(base, occurrence + 1)
      return occurrence === 0 ? base : `${base}#${occurrence}`
    })
  }, [items, itemKey])

  useEffect(() => {
    const active = new Set(keys)
    for (const key of measuredSizesRef.current.keys()) {
      if (!active.has(key)) measuredSizesRef.current.delete(key)
    }
  }, [keys])

  const offsets = useMemo(() => {
    const next = buildVirtualOffsets(items.length, (index) => {
      const key = keys[index]
      return measuredSizesRef.current.get(key) ?? estimateSize(items[index], index)
    })
    offsetsRef.current = next
    // Keep this dependency explicit: ResizeObserver bumps the revision after a
    // row's real height replaces its estimate.
    void layoutRevision
    return next
  }, [estimateSize, items, keys, layoutRevision])

  const virtualized = items.length > virtualizationThreshold
  const listTop = listRef.current?.offsetTop ?? viewport.listTop
  const relativeScrollTop = Math.max(0, viewport.scrollTop - listTop)
  const range = virtualized
    ? computeVirtualRange(offsets, relativeScrollTop, viewport.height || 640, overscanPx)
    : { start: 0, end: items.length, top: 0, bottom: 0 }

  const refreshViewport = useCallback(() => {
    const scroller = scrollRef.current
    const list = listRef.current
    if (!scroller || !list) return
    const next = {
      scrollTop: scroller.scrollTop,
      height: scroller.clientHeight,
      listTop: list.offsetTop,
    }
    viewportRef.current = next
    setViewport((previous) => (
      previous.scrollTop === next.scrollTop
      && previous.height === next.height
      && previous.listTop === next.listTop
        ? previous
        : next
    ))
  }, [scrollRef])

  useLayoutEffect(() => {
    refreshViewport()
  }, [items.length, refreshViewport, virtualized])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let frame: number | null = null
    const onScroll = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        refreshViewport()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(refreshViewport)
    resizeObserver?.observe(scroller)
    if (listRef.current) resizeObserver?.observe(listRef.current)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
    }
  }, [refreshViewport, scrollRef])

  const measureRow = useCallback((key: string, index: number, measured: number) => {
    if (!Number.isFinite(measured) || measured <= 0) return
    const previous = measuredSizesRef.current.get(key)
    if (previous != null && Math.abs(previous - measured) < 0.5) return

    const oldOffsets = offsetsRef.current
    const delta = measured - (previous ?? oldOffsets[index + 1] - oldOffsets[index])
    measuredSizesRef.current.set(key, measured)

    const scroller = scrollRef.current
    const currentListTop = listRef.current?.offsetTop ?? 0
    const currentRelativeTop = Math.max(0, (scroller?.scrollTop ?? 0) - currentListTop)
    const wasAboveViewport = oldOffsets[index + 1] <= currentRelativeTop + 1
    const currentlyPinned = scroller
      ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
      : pinnedToBottom
    if (scroller && Math.abs(delta) >= 0.5 && wasAboveViewport && !currentlyPinned) {
      scroller.scrollTop += delta
    } else if (scroller && Math.abs(delta) >= 0.5 && currentlyPinned) {
      window.requestAnimationFrame(() => {
        if (scrollRef.current === scroller) scroller.scrollTop = scroller.scrollHeight
      })
    }
    setLayoutRevision((value) => value + 1)
  }, [pinnedToBottom, scrollRef])

  useImperativeHandle(forwardedRef, () => ({
    getFirstVisibleIndex: (extraOffset = 0) => {
      const scroller = scrollRef.current
      const list = listRef.current
      if (!scroller || !list || items.length === 0) return 0
      const top = Math.max(0, scroller.scrollTop - list.offsetTop + extraOffset)
      return virtualIndexAtOffset(offsetsRef.current, top)
    },
    scrollToIndex: (index, options = {}) => {
      const scroller = scrollRef.current
      const list = listRef.current
      if (!scroller || !list || items.length === 0) return
      const targetIndex = Math.max(0, Math.min(items.length - 1, index))
      const itemTop = offsetsRef.current[targetIndex] ?? 0
      const itemBottom = offsetsRef.current[targetIndex + 1] ?? itemTop
      const viewportHeight = scroller.clientHeight
      const align = options.align ?? 'start'
      const targetTop = align === 'center'
        ? itemTop - Math.max(0, (viewportHeight - (itemBottom - itemTop)) / 2)
        : align === 'end'
          ? itemBottom - viewportHeight
          : itemTop - 16
      const top = Math.max(0, list.offsetTop + targetTop)
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top, behavior: options.behavior ?? 'smooth' })
      } else {
        scroller.scrollTop = top
      }
    },
    getTotalSize: () => offsetsRef.current[offsetsRef.current.length - 1] ?? 0,
  }), [forwardedRef, items.length, scrollRef])

  return (
    <div
      ref={listRef}
      data-chat-virtual-list
      data-virtualized={virtualized ? 'true' : 'false'}
      data-total-count={items.length}
      data-rendered-count={range.end - range.start}
      data-virtual-top={range.top}
      data-virtual-bottom={range.bottom}
      style={virtualized ? { position: 'relative', height: offsets[offsets.length - 1] ?? 0 } : undefined}
    >
      {items.slice(range.start, range.end).map((item, visibleIndex) => {
        const index = range.start + visibleIndex
        const key = keys[index]
        return (
          <MeasuredRow
            key={key}
            rowKey={key}
            index={index}
            top={virtualized ? offsets[index] : undefined}
            virtualized={virtualized}
            onMeasure={measureRow}
          >
            {renderItem(item, index)}
          </MeasuredRow>
        )
      })}
    </div>
  )
}) as <T>(props: Props<T> & { ref?: Ref<VirtualMessageListHandle> }) => ReactElement

interface RowProps {
  rowKey: string
  index: number
  top?: number
  virtualized: boolean
  onMeasure: (key: string, index: number, measured: number) => void
  children: ReactNode
}

const MeasuredRow = memo(function MeasuredRow({ rowKey, index, top, virtualized, onMeasure, children }: RowProps) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const measure = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    const measured = node.getBoundingClientRect?.().height || node.offsetHeight
    onMeasure(rowKey, index, measured)
  }, [index, onMeasure, rowKey])

  useLayoutEffect(() => {
    measure()
  }, [measure, children])

  useEffect(() => {
    const node = nodeRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [measure])

  return (
    <div
      ref={nodeRef}
      data-chat-message
      data-virtual-index={index}
      style={virtualized
        ? { position: 'absolute', top, left: 0, right: 0, paddingBottom: '0.5rem' }
        : { paddingBottom: '0.5rem' }}
    >
      {children}
    </div>
  )
})
