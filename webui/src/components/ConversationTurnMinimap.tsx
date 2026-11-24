import { useEffect, useRef, useState } from 'react'

export interface MinimapTurnItem {
  id: string
  index: number
  label: string
}

interface ConversationTurnMinimapProps {
  items: readonly MinimapTurnItem[]
  activeIndex: number
  onSelect: (index: number) => void
}

/**
 * 仿 Antigravity IDE 风格的右侧多轮会话位置选择器：
 * 以圆点与纵向波浪胶囊展示全部分轮，当前轮亮起琥珀聚焦光晕，相邻轮过渡收窄，
 * 末轮带常驻锚点；悬停或聚焦节点弹出对应提问预览，点击直达该轮对话。
 */
export function ConversationTurnMinimap({
  items,
  activeIndex,
  onSelect,
}: ConversationTurnMinimapProps) {
  const navRef = useRef<HTMLElement>(null)
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)
  const [tooltipTop, setTooltipTop] = useState<number>(0)

  const clampedActive = items.length > 0 ? Math.max(0, Math.min(items.length - 1, activeIndex)) : 0

  useEffect(() => {
    const nav = navRef.current
    const activeNode = nav?.querySelector<HTMLElement>('[aria-current="step"]')
    if (!nav || !activeNode || nav.scrollHeight <= nav.clientHeight + 1) return
    const navRect = nav.getBoundingClientRect()
    const nodeRect = activeNode.getBoundingClientRect()
    if (navRect.height <= 0 || nodeRect.height <= 0) return
    const pad = 10
    const relTop = nodeRect.top - navRect.top
    const relBottom = nodeRect.bottom - navRect.top
    if (relTop < pad) {
      nav.scrollTop = Math.max(0, nav.scrollTop + relTop - pad)
    } else if (relBottom > nav.clientHeight - pad) {
      nav.scrollTop += relBottom - (nav.clientHeight - pad)
    }
  }, [clampedActive, items.length])

  if (items.length <= 1) return null

  const hoveredItem = hoveredIdx !== null ? items[hoveredIdx] : undefined

  return (
    <div
      className="pointer-events-auto relative flex max-h-full w-9 flex-col items-center"
      onMouseLeave={() => setHoveredIdx(null)}
    >
      <nav
        ref={navRef}
        aria-label="多轮会话选择器"
        onWheel={(event) => {
          const nav = navRef.current
          if (!nav || nav.scrollHeight <= nav.clientHeight + 1) return
          const canUp = event.deltaY < 0 && nav.scrollTop > 0
          const canDown = event.deltaY > 0 && nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1
          if (canUp || canDown) event.stopPropagation()
        }}
        className="flex max-h-full w-7 flex-col items-center gap-[3px] overflow-y-auto rounded-full border border-line/65 bg-bg-card/88 px-1 py-2.5 shadow-[inset_0_1px_0_rgba(255,250,232,0.82),0_4px_14px_rgba(45,34,22,0.09)] backdrop-blur-md [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item, idx) => {
          const dist = Math.abs(idx - clampedActive)
          const isCurrent = dist === 0
          const isLast = idx === items.length - 1
          const indicatorClass = isCurrent
            ? 'h-3.5 w-[6px] bg-accent shadow-[0_0_0_3px_rgba(166,91,42,0.16),0_1px_4px_rgba(166,91,42,0.35)]'
            : dist === 1
              ? 'h-2.5 w-[5px] bg-ink/45 group-hover/dot:bg-accent/85'
              : dist === 2
                ? 'h-[7px] w-[5px] bg-ink/30 group-hover/dot:bg-accent/80'
                : isLast
                  ? 'h-[6px] w-[6px] bg-ink/60 ring-2 ring-ink/10 group-hover/dot:scale-125 group-hover/dot:bg-accent'
                  : 'h-[5px] w-[5px] bg-ink/22 group-hover/dot:scale-125 group-hover/dot:bg-accent/80'

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(idx)}
              onMouseEnter={(event) => {
                setHoveredIdx(idx)
                const navRect = navRef.current?.getBoundingClientRect()
                const btnRect = event.currentTarget.getBoundingClientRect()
                if (navRect) {
                  setTooltipTop(btnRect.top - navRect.top + btnRect.height / 2)
                } else {
                  setTooltipTop(event.currentTarget.offsetTop + event.currentTarget.offsetHeight / 2)
                }
              }}
              onFocus={(event) => {
                setHoveredIdx(idx)
                setTooltipTop(event.currentTarget.offsetTop + event.currentTarget.offsetHeight / 2)
              }}
              onBlur={() => setHoveredIdx((prev) => (prev === idx ? null : prev))}
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

      {hoveredItem && (
        <div
          role="status"
          className="ga-paper-popover pointer-events-none absolute right-full mr-2.5 w-56 -translate-y-1/2 rounded-xl px-3 py-2 text-left"
          style={{ top: tooltipTop }}
        >
          <div className="flex items-center justify-between gap-2 text-[10px] font-semibold">
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft/85 px-1.5 py-0.5 text-accent-deep">
              第 {hoveredItem.index} 轮
            </span>
            <span className="tabular-nums text-ink-faint">{hoveredItem.index} / {items.length}</span>
          </div>
          <div className="mt-1 line-clamp-2 break-words text-xs leading-snug text-ink">
            {hoveredItem.label}
          </div>
        </div>
      )}
    </div>
  )
}
