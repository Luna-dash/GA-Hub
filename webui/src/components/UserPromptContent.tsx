import { useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronUp } from '@/components/ActionIcons'
import { MessageContent } from '@/components/MessageContent'

const NORMAL_MAX_HEIGHT_PX = 168
const COMPACT_MAX_HEIGHT_PX = 112
const OVERFLOW_TOLERANCE_PX = 6

/**
 * Fallback heuristic used only when DOM layout metrics are unavailable
 * (e.g. jsdom / SSR where scrollHeight === 0).
 */
export function estimateUserPromptOverflow(content: string, compact = false): boolean {
  if (!content) return false
  const lines = content.split('\n')
  const maxLines = compact ? 4 : 6
  const charsPerLine = compact ? 48 : 64
  let visualLines = 0
  for (const line of lines) {
    visualLines += Math.max(1, Math.ceil(line.length / charsPerLine))
    if (visualLines > maxLines) return true
  }
  return false
}

export interface UserPromptContentProps {
  content: string
  /** Compact surfaces (side drawers / conductor log) use a slightly tighter cap. */
  compact?: boolean
  /** CSS background color expression matching the enclosing bubble for the fade mask. */
  fadeBg?: string
  /** Optional chat font scale percentage (100 = default) so the line cap scales naturally. */
  fontScalePercent?: number
  className?: string
}

/**
 * Renders a user prompt with a bounded default height so very long pasted
 * requests stay scannable in chat transcripts, with a smooth fade-out and
 * an inline expand/collapse toggle.
 */
export function UserPromptContent({
  content,
  compact = false,
  fadeBg = 'var(--c-user-bubble-bg)',
  fontScalePercent = 100,
  className,
}: UserPromptContentProps) {
  const baseMaxPx = compact ? COMPACT_MAX_HEIGHT_PX : NORMAL_MAX_HEIGHT_PX
  const scale = Number.isFinite(fontScalePercent) && fontScalePercent > 0 ? fontScalePercent / 100 : 1
  const maxHeightPx = Math.round(baseMaxPx * scale)
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(() => estimateUserPromptOverflow(content, compact))

  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return

    const measure = () => {
      const scrollHeight = el.scrollHeight
      if (scrollHeight > 0) {
        setOverflowing(scrollHeight > maxHeightPx + OVERFLOW_TOLERANCE_PX)
      } else {
        setOverflowing(estimateUserPromptOverflow(content, compact))
      }
    }

    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content, compact, maxHeightPx])

  const clamped = overflowing && !expanded

  return (
    <div
      data-user-prompt
      data-user-prompt-clamped={clamped ? 'true' : 'false'}
      className={clsx('min-w-0 max-w-full', className)}
    >
      <div
        data-user-prompt-body
        className={clsx('relative', clamped && 'overflow-hidden')}
        style={clamped ? { maxHeight: `${maxHeightPx}px` } : undefined}
      >
        <div ref={contentRef}>
          <MessageContent content={content} format="text" />
        </div>
        {clamped && (
          <div
            data-user-prompt-fade
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
            style={{ background: `linear-gradient(to bottom, transparent, ${fadeBg} 92%)` }}
          />
        )}
      </div>
      {overflowing && (
        <div className="mt-1 flex items-center justify-between gap-2 pt-0.5 text-[11px] leading-none">
          <span aria-hidden="true" className="select-none tracking-widest opacity-55">
            {clamped ? '……' : ''}
          </span>
          <button
            type="button"
            data-user-prompt-toggle
            aria-expanded={expanded}
            aria-label={expanded ? '收起请求内容' : '展开全部请求内容'}
            onClick={() => setExpanded(prev => !prev)}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 font-medium text-current opacity-75 transition-opacity hover:bg-current/10 hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <span>{expanded ? '收起' : '展开全文'}</span>
            {expanded
              ? <ChevronUp className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />
              : <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden="true" />}
          </button>
        </div>
      )}
    </div>
  )
}
