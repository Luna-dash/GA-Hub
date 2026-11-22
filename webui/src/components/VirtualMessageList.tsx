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
import { markProgrammaticScroll } from '@/utils/programmaticScroll'
import { buildVirtualOffsets, computeVirtualRange, virtualIndexAtOffset } from '@/utils/virtualList'

export interface VirtualMessageListHandle {
  prepareForPrepend: () => boolean
  releasePrependAnchor: () => void
  hasPrependAnchor: () => boolean
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
const TALL_LIST_PX = 4800

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
  const anchorSpaceRef = useRef<HTMLDivElement>(null)
  const measuredSizesRef = useRef(new Map<string, number>())
  const offsetsRef = useRef<number[]>([0])
  const prependAnchorRef = useRef<{ key: string; y: number } | null>(null)
  const hasVirtualizedRef = useRef(false)
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

  // A short page can still contain many screens of Markdown. Window it
  // before mounting all of those bubbles, and don't switch back as they measure.
  const virtualized = items.length > virtualizationThreshold
    || (items.length >= 12 && (hasVirtualizedRef.current || offsets[items.length] > TALL_LIST_PX))
  const listTop = listRef.current?.offsetTop ?? viewport.listTop
  const anchor = prependAnchorRef.current
  const anchorIndex = anchor ? keys.indexOf(anchor.key) : -1
  const relativeScrollTop = anchor && anchorIndex >= 0
    ? Math.max(0, offsets[anchorIndex] - anchor.y)
    : Math.max(0, viewport.scrollTop - listTop)
  const range = virtualized
    ? computeVirtualRange(offsets, relativeScrollTop, viewport.height || 640, overscanPx)
    : { start: 0, end: items.length, top: 0, bottom: 0 }

  // The wrapper can be shorter than the viewport. Preserve just enough space
  // to hold the anchor at its old y, even when the browser clamps scrollTop.
  const setAnchorSpace = useCallback((top: number) => {
    const scroller = scrollRef.current
    const spacer = anchorSpaceRef.current
    if (!scroller || !spacer) return
    const naturalEnd = spacer.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      - scroller.clientTop + scroller.scrollTop
    const height = Math.max(0, Math.ceil(top + scroller.clientHeight - naturalEnd))
    const next = height ? `${height}px` : ''
    if (spacer.style.height !== next) spacer.style.height = next
  }, [scrollRef])

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

  const restorePrependAnchor = useCallback(() => {
    const scroller = scrollRef.current
    const list = listRef.current
    const pending = prependAnchorRef.current
    if (pending && scroller && list) {
      const row = Array.from(list.children).find((node) => (node as HTMLElement).dataset.chatKey === pending.key)
      if (row) {
        const y = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop
        const delta = y - pending.y
        if (Math.abs(delta) >= 0.5) {
          markProgrammaticScroll()
          const target = Math.max(0, scroller.scrollTop + delta)
          scroller.scrollTop = target
          if (scroller.scrollTop < target - 0.5) {
            setAnchorSpace(target)
            scroller.scrollTop = target
          }
        }
      }
    }
  }, [scrollRef, setAnchorSpace])

  useLayoutEffect(() => {
    hasVirtualizedRef.current = virtualized
    if (prependAnchorRef.current && anchorIndex < 0) prependAnchorRef.current = null
    restorePrependAnchor()
    refreshViewport()
  }, [anchorIndex, items, offsets, refreshViewport, restorePrependAnchor, virtualized])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    let frame: number | null = null
    const onScroll = () => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        // Reclaim any reserve as the reader moves back into the real content,
        // without clamping their current position on the first gesture.
        if (!prependAnchorRef.current && anchorSpaceRef.current?.style.height) {
          setAnchorSpace(scroller.scrollTop)
        }
        refreshViewport()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => {
        restorePrependAnchor()
        refreshViewport()
      })
    resizeObserver?.observe(scroller)
    if (listRef.current) resizeObserver?.observe(listRef.current)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame !== null) window.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
    }
  }, [refreshViewport, restorePrependAnchor, scrollRef, setAnchorSpace])

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
    if (virtualized && !prependAnchorRef.current && scroller && Math.abs(delta) >= 0.5 && wasAboveViewport && !currentlyPinned) {
      markProgrammaticScroll()
      scroller.scrollTop += delta
    } else if (virtualized && !prependAnchorRef.current && scroller && Math.abs(delta) >= 0.5 && currentlyPinned && pinnedToBottom) {
      window.requestAnimationFrame(() => {
        if (scrollRef.current === scroller && !prependAnchorRef.current
          && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 + Math.max(0, delta)) {
          markProgrammaticScroll()
          scroller.scrollTop = scroller.scrollHeight
        }
      })
    }
    setLayoutRevision((value) => value + 1)
  }, [pinnedToBottom, scrollRef, virtualized])

  useImperativeHandle(forwardedRef, () => ({
    prepareForPrepend: () => {
      const list = listRef.current
      const scroller = scrollRef.current
      if (!list || !scroller) return false
      const top = scroller.getBoundingClientRect().top + scroller.clientTop
      for (const node of list.children) {
        const rect = node.getBoundingClientRect()
        const key = (node as HTMLElement).dataset.chatKey
        if (rect.top >= top + scroller.clientHeight) break
        if (key && rect.bottom > top) {
          prependAnchorRef.current = { key, y: rect.top - top }
          return true
        }
      }
      return false
    },
    releasePrependAnchor: () => { prependAnchorRef.current = null },
    hasPrependAnchor: () => prependAnchorRef.current !== null,
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
      prependAnchorRef.current = null
      if (anchorSpaceRef.current) anchorSpaceRef.current.style.height = ''
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
      markProgrammaticScroll()
      if (typeof scroller.scrollTo === 'function') {
        scroller.scrollTo({ top, behavior: options.behavior ?? 'smooth' })
      } else {
        scroller.scrollTop = top
      }
    },
    getTotalSize: () => offsetsRef.current[offsetsRef.current.length - 1] ?? 0,
  }), [forwardedRef, items.length, scrollRef])

  return (
    <>
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
              isLast={index === items.length - 1}
              top={virtualized ? offsets[index] : undefined}
              virtualized={virtualized}
              onMeasure={measureRow}
            >
              {renderItem(item, index)}
            </MeasuredRow>
          )
        })}
      </div>
      <div ref={anchorSpaceRef} aria-hidden="true" />
    </>
  )
}) as <T>(props: Props<T> & { ref?: Ref<VirtualMessageListHandle> }) => ReactElement

interface RowProps {
  rowKey: string
  index: number
  isLast: boolean
  top?: number
  virtualized: boolean
  onMeasure: (key: string, index: number, measured: number) => void
  children: ReactNode
}

const MeasuredRow = memo(function MeasuredRow({ rowKey, index, isLast, top, virtualized, onMeasure, children }: RowProps) {
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
      data-chat-key={rowKey}
      data-virtual-index={index}
      style={virtualized
        ? { position: 'absolute', top, left: 0, right: 0, paddingBottom: isLast ? 0 : '0.5rem' }
        : { paddingBottom: isLast ? 0 : '0.5rem' }}
    >
      {children}
    </div>
  )
})
