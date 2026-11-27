import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { X } from './ActionIcons'

export interface MinimapTurnItem {
  id: string
  index: number
  label: string
}

export const MAX_DIRECT_MINIMAP_SLOTS = 11

/**
 * 为长对话构建等比映射的固定槽位索引列表：
 * - 轮次不超过 `maxSlots` 时 1:1 映射全部分轮；
 * - 超过 `maxSlots` 时首尾固定为第 1 轮与末轮，其余槽位随 `activeIndex` 等比分布，
 *   确保向上/向下翻看任意历史轮次时，焦点指示点始终平滑反映在整段对话中的真实位置。
 */
export function buildMinimapSlots(
  total: number,
  activeIndex: number,
  maxSlots = MAX_DIRECT_MINIMAP_SLOTS,
): number[] {
  if (total <= 0) return []
  if (maxSlots <= 1) {
    return [Math.max(0, Math.min(total - 1, activeIndex))]
  }
  if (total <= maxSlots) {
    return Array.from({ length: total }, (_, idx) => idx)
  }

  const last = total - 1
  const clampedActive = Math.max(0, Math.min(last, activeIndex))
  const minSlot = clampedActive === 0 ? 0 : Math.max(1, (maxSlots - 1) - (last - clampedActive))
  const maxSlot = clampedActive === last ? maxSlots - 1 : Math.min(maxSlots - 2, clampedActive)
  const rawSlot = Math.round((clampedActive / last) * (maxSlots - 1))
  const activeSlot = Math.max(minSlot, Math.min(maxSlot, rawSlot))

  const slots = new Array<number>(maxSlots)
  slots[0] = 0
  slots[activeSlot] = clampedActive
  slots[maxSlots - 1] = last

  for (let s = 1; s < activeSlot; s += 1) {
    const ideal = Math.round((s / activeSlot) * clampedActive)
    const minAllowed = slots[s - 1] + 1
    const maxAllowed = clampedActive - (activeSlot - s)
    slots[s] = Math.max(minAllowed, Math.min(maxAllowed, ideal))
  }

  const belowCount = (maxSlots - 1) - activeSlot
  for (let k = 1; k < belowCount; k += 1) {
    const s = activeSlot + k
    const ideal = clampedActive + Math.round((k / belowCount) * (last - clampedActive))
    const minAllowed = slots[s - 1] + 1
    const maxAllowed = last - (belowCount - k)
    slots[s] = Math.max(minAllowed, Math.min(maxAllowed, ideal))
  }

  return slots
}

interface ConversationTurnMinimapProps {
  items: readonly MinimapTurnItem[]
  activeIndex: number
  onSelect: (index: number) => void
}

/**
 * 右侧多轮会话位置导航器：
 * - 短对话展示全部圆点；长对话等比采样为紧凑胶囊轨道并支持拖拽顺滑定位（scrubbing）；
 * - 下方附带 `当前/总计` 位置胶囊，点击弹出可搜索的全轮次目录面板，快速直达任意一轮。
 */
export const ConversationTurnMinimap = memo(function ConversationTurnMinimap({
  items,
  activeIndex,
  onSelect,
}: ConversationTurnMinimapProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const dirListRef = useRef<HTMLDivElement>(null)
  const scrubStartYRef = useRef<number | null>(null)
  const scrubbingRef = useRef(false)
  const scrubIndexRef = useRef<number | null>(null)
  const scrubCleanupRef = useRef<(() => void) | null>(null)
  const suppressClickRef = useRef(false)

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [tooltipTop, setTooltipTop] = useState<number>(0)
  const [directoryOpen, setDirectoryOpen] = useState(false)
  const [query, setQuery] = useState('')

  const clampedActive = items.length > 0 ? Math.max(0, Math.min(items.length - 1, activeIndex)) : 0
  const isCompressed = items.length > MAX_DIRECT_MINIMAP_SLOTS

  const slots = useMemo(
    () => buildMinimapSlots(items.length, clampedActive, MAX_DIRECT_MINIMAP_SLOTS),
    [items.length, clampedActive],
  )
  const activeSlotIdx = useMemo(() => {
    const exact = slots.indexOf(clampedActive)
    return exact >= 0 ? exact : 0
  }, [slots, clampedActive])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredEntries = useMemo(() => {
    const all = items.map((item, idx) => ({ item, idx }))
    if (!normalizedQuery) return all
    const cleanNum = normalizedQuery.replace(/^#/, '')
    return all.filter(({ item }) => (
      item.label.toLowerCase().includes(normalizedQuery)
      || (cleanNum.length > 0 && String(item.index).includes(cleanNum))
    ))
  }, [items, normalizedQuery])

  useEffect(() => {
    if (!directoryOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) {
        setDirectoryOpen(false)
        setQuery('')
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDirectoryOpen(false)
        setQuery('')
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [directoryOpen])

  useEffect(() => {
    if (!directoryOpen) return
    const list = dirListRef.current
    const activeEl = list?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!list || !activeEl || list.scrollHeight <= list.clientHeight + 1) return
    list.scrollTop = Math.max(0, activeEl.offsetTop - list.clientHeight / 2 + activeEl.offsetHeight / 2)
  }, [directoryOpen, clampedActive])

  useEffect(() => () => {
    scrubCleanupRef.current?.()
    scrubCleanupRef.current = null
  }, [])

  if (items.length <= 1) return null

  const hoveredItem = !directoryOpen && hoveredIdx !== null ? items[hoveredIdx] : undefined

  const updateTooltipFromElement = (el: HTMLElement) => {
    const wrapperRect = wrapperRef.current?.getBoundingClientRect()
    const btnRect = el.getBoundingClientRect()
    if (wrapperRect && wrapperRect.height > 0 && btnRect.height > 0) {
      setTooltipTop(btnRect.top - wrapperRect.top + btnRect.height / 2)
    } else {
      setTooltipTop(el.offsetTop + el.offsetHeight / 2)
    }
  }

  const resolveScrubIndex = (clientY: number): number => {
    const nav = navRef.current
    if (!nav || items.length <= 1) return clampedActive
    const navRect = nav.getBoundingClientRect()
    if (navRect.height <= 0) return clampedActive
    const ratio = Math.max(0, Math.min(1, (clientY - navRect.top) / navRect.height))
    return Math.round(ratio * (items.length - 1))
  }

  const resetScrubState = () => {
    scrubStartYRef.current = null
    scrubbingRef.current = false
    scrubIndexRef.current = null
  }

  return (
    <div
      ref={wrapperRef}
      className="pointer-events-auto relative flex w-12 flex-col items-center gap-1.5"
      onMouseLeave={() => {
        if (!scrubbingRef.current) setHoveredIdx(null)
      }}
    >
      <nav
        ref={navRef}
        aria-label="多轮会话选择器"
        onPointerDown={(event) => {
          if (!isCompressed || event.button !== 0) return
          scrubCleanupRef.current?.()
          const pointerId = event.pointerId
          scrubStartYRef.current = event.clientY
          scrubbingRef.current = false
          scrubIndexRef.current = null

          // Wait until pointer movement crosses the scrub threshold before acquiring
          // pointer capture; capturing on pointerdown retargets pointerup to <nav> in
          // Chromium and suppresses native <button> click events when simply clicking a dot.
          const onWindowPointerMove = (moveEvent: PointerEvent) => {
            if (pointerId !== undefined && moveEvent.pointerId !== pointerId) return
            if (scrubStartYRef.current === null) return
            if (!scrubbingRef.current) {
              if (Math.abs(moveEvent.clientY - scrubStartYRef.current) <= 4) return
              scrubbingRef.current = true
              if (pointerId !== undefined) {
                try {
                  navRef.current?.setPointerCapture?.(pointerId)
                } catch {
                  // Ignore synthetic test events without active pointerId.
                }
              }
            }
            const nextIdx = resolveScrubIndex(moveEvent.clientY)
            scrubIndexRef.current = nextIdx
            setHoveredIdx(nextIdx)
            const wrapperRect = wrapperRef.current?.getBoundingClientRect()
            const navRect = navRef.current?.getBoundingClientRect()
            if (wrapperRect && navRect && navRect.height > 0) {
              const clampedY = Math.max(navRect.top, Math.min(navRect.bottom, moveEvent.clientY))
              setTooltipTop(clampedY - wrapperRect.top)
            }
          }

          const finishPointer = (endEvent: PointerEvent, canceled: boolean) => {
            if (pointerId !== undefined && endEvent.pointerId !== pointerId) return
            scrubCleanupRef.current?.()
            scrubCleanupRef.current = null
            if (pointerId !== undefined) {
              try {
                if (navRef.current?.hasPointerCapture?.(pointerId) ?? true) {
                  navRef.current?.releasePointerCapture?.(pointerId)
                }
              } catch {
                // Ignore when pointer capture was not acquired.
              }
            }
            if (!canceled && scrubbingRef.current && scrubIndexRef.current !== null) {
              suppressClickRef.current = true
              onSelect(scrubIndexRef.current)
              window.setTimeout(() => {
                suppressClickRef.current = false
              }, 0)
            }
            if (canceled) {
              setHoveredIdx(null)
            }
            resetScrubState()
          }

          const onWindowPointerUp = (upEvent: PointerEvent) => finishPointer(upEvent, false)
          const onWindowPointerCancel = (cancelEvent: PointerEvent) => finishPointer(cancelEvent, true)

          window.addEventListener('pointermove', onWindowPointerMove)
          window.addEventListener('pointerup', onWindowPointerUp)
          window.addEventListener('pointercancel', onWindowPointerCancel)
          scrubCleanupRef.current = () => {
            window.removeEventListener('pointermove', onWindowPointerMove)
            window.removeEventListener('pointerup', onWindowPointerUp)
            window.removeEventListener('pointercancel', onWindowPointerCancel)
          }
        }}
        className="flex w-7 flex-col items-center gap-[3px] rounded-full border border-line/65 bg-bg-card px-1 py-2.5 shadow-[inset_0_1px_0_var(--c-inset-highlight),0_4px_14px_rgba(45,34,22,0.09)] touch-none"
      >
        {slots.map((turnIdx, slotIdx) => {
          const item = items[turnIdx]
          if (!item) return null
          const dist = Math.abs(slotIdx - activeSlotIdx)
          const isCurrent = dist === 0
          const isBoundaryAnchor = isCompressed && (slotIdx === 0 || slotIdx === slots.length - 1)
          const indicatorClass = isCurrent
            ? 'h-3.5 w-[6px] bg-accent shadow-[0_0_0_3px_rgba(166,91,42,0.16),0_1px_4px_rgba(166,91,42,0.35)]'
            : dist === 1
              ? 'h-2.5 w-[5px] bg-ink/45 group-hover/dot:bg-accent/85'
              : dist === 2
                ? 'h-[7px] w-[5px] bg-ink/30 group-hover/dot:bg-accent/80'
                : isBoundaryAnchor || (!isCompressed && slotIdx === slots.length - 1)
                  ? 'h-[6px] w-[6px] bg-ink/55 ring-2 ring-ink/10 group-hover/dot:scale-125 group-hover/dot:bg-accent'
                  : 'h-[5px] w-[5px] bg-ink/25 group-hover/dot:scale-125 group-hover/dot:bg-accent/80'

          return (
            <button
              key={slotIdx}
              type="button"
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false
                  return
                }
                onSelect(turnIdx)
              }}
              onMouseEnter={(event) => {
                if (scrubbingRef.current) return
                setHoveredIdx(turnIdx)
                updateTooltipFromElement(event.currentTarget)
              }}
              onFocus={(event) => {
                setHoveredIdx(turnIdx)
                updateTooltipFromElement(event.currentTarget)
              }}
              onBlur={() => setHoveredIdx((prev) => (prev === turnIdx ? null : prev))}
              aria-label={`跳到第 ${item.index} 轮：${item.label}`}
              aria-current={isCurrent ? 'step' : undefined}
              title={`第 ${item.index} 轮：${item.label}`}
              className="group/dot flex h-4 w-5 shrink-0 items-center justify-center focus-visible:outline-none"
            >
              <span
                aria-hidden="true"
                className={`block rounded-full transition-all duration-150 ${indicatorClass}`}
              />
            </button>
          )
        })}
      </nav>

      <button
        type="button"
        data-turn-directory-trigger
        aria-label={`打开对话目录（当前第 ${clampedActive + 1} 轮，共 ${items.length} 轮）`}
        aria-haspopup="dialog"
        aria-expanded={directoryOpen}
        title={`第 ${clampedActive + 1} / ${items.length} 轮（点击打开目录）`}
        onClick={() => {
          setHoveredIdx(null)
          setDirectoryOpen((prev) => {
            const next = !prev
            if (!next) setQuery('')
            return next
          })
        }}
        className={`inline-flex h-5 min-w-9 max-w-full items-center justify-center rounded-full border px-1.5 text-[10px] font-medium leading-none tabular-nums shadow-[inset_0_1px_0_var(--c-inset-highlight),0_2px_8px_rgba(45,34,22,0.08)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
          directoryOpen
            ? 'border-accent/65 bg-accent-soft text-accent'
            : 'border-line/70 bg-bg-card text-ink-muted hover:border-accent/55 hover:text-ink'
        }`}
      >
        {clampedActive + 1}/{items.length}
      </button>

      {hoveredItem && (
        <div
          role="status"
          className="ga-paper-popover pointer-events-none absolute right-full mr-2.5 w-56 -translate-y-1/2 rounded-xl px-3 py-2 text-left"
          style={{ top: tooltipTop }}
        >
          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold">
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft/85 px-1.5 py-0.5 text-accent">
              第 {hoveredItem.index} 轮
            </span>
            <span className="tabular-nums text-ink-faint">{hoveredItem.index} / {items.length}</span>
          </div>
          <div className="mt-1 line-clamp-2 break-words text-xs leading-snug text-ink">
            {hoveredItem.label}
          </div>
        </div>
      )}

      {directoryOpen && (
        <div
          role="dialog"
          aria-label="对话轮次目录"
          data-turn-directory-popover
          data-chat-wheel-independent
          className="ga-paper-popover absolute right-full top-1/2 z-20 mr-2.5 flex max-h-[min(24rem,70vh)] w-72 -translate-y-1/2 flex-col overflow-hidden rounded-xl text-left"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line/50 px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-ink">对话目录</span>
              <span className="rounded-full bg-bg-soft px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-muted">
                {clampedActive + 1} / {items.length}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-soft hover:text-ink"
                onClick={() => {
                  onSelect(0)
                  setQuery('')
                  setDirectoryOpen(false)
                }}
              >
                首轮
              </button>
              <button
                type="button"
                className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-soft hover:text-ink"
                onClick={() => {
                  onSelect(items.length - 1)
                  setQuery('')
                  setDirectoryOpen(false)
                }}
              >
                末轮
              </button>
              <button
                type="button"
                aria-label="关闭对话目录"
                className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-muted transition-colors hover:bg-bg-soft hover:text-ink"
                onClick={() => {
                  setQuery('')
                  setDirectoryOpen(false)
                }}
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {items.length >= 8 && (
            <div className="shrink-0 border-b border-line/40 px-2.5 py-1.5">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="筛选对话轮次"
                placeholder="搜索关键词或轮次号…"
                className="h-7 w-full rounded-md border border-line/80 bg-bg-soft/60 px-2 text-xs text-ink outline-none focus:border-accent"
              />
            </div>
          )}

          <div
            ref={dirListRef}
            data-chat-wheel-independent
            className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5"
          >
            {filteredEntries.length > 0 ? filteredEntries.map(({ item, idx }) => {
              const isActive = idx === clampedActive
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => {
                    onSelect(idx)
                    setQuery('')
                    setDirectoryOpen(false)
                  }}
                  className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                    isActive
                      ? 'bg-accent-soft/80 font-medium text-accent ring-1 ring-accent/30'
                      : 'text-ink hover:bg-bg-soft/80'
                  }`}
                >
                  <span className="mt-0.5 w-6 shrink-0 text-right text-[10px] font-semibold tabular-nums text-ink-faint">
                    #{item.index}
                  </span>
                  <span className="min-w-0 flex-1 line-clamp-2 break-words leading-snug">
                    {item.label}
                  </span>
                </button>
              )
            }) : (
              <p className="px-2 py-4 text-center text-xs text-ink-muted">未找到匹配的对话轮次</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
