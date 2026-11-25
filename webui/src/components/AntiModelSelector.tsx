import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import type { AgyOrchestratorSettings, AntiModels } from '@/api/client'
import { Z_LAYERS } from '@/config/zLayers'

export const DEFAULT_FAMILY = 'gemini-4-hydrogen'
export const DEFAULT_MODEL = { id: `${DEFAULT_FAMILY}-high`, display_name: 'Gemini 4 Hydrogen (High)' }
export const DEFAULT_EFFORT = 'high'
export const EFFORT_OPTIONS = [
  { key: 'low', name: 'low' },
  { key: 'medium', name: 'medium' },
  { key: 'high', name: 'high' },
  { key: 'xhigh', name: 'xhigh' },
  { key: 'max', name: 'max' },
] as const

const EFFORT_SHORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export interface AgyModelFamily {
  key: string
  name: string
  variants: Partial<Record<string, string>>
  plain?: string
  efforts?: string[]
  defaultEffort?: string
  isOrchestrator?: boolean
}

export function modelFamilies(items: AntiModels['items']) {
  const families = new Map<string, AgyModelFamily>()
  for (const item of items) {
    const { id, display_name } = item
    const isOrch = Boolean(item.is_orchestrator) || /orchestrator/i.test(id)
    if (isOrch) {
      const existing = families.get(id) ?? { key: id, name: display_name || id, variants: {}, plain: id, isOrchestrator: true, efforts: [] }
      existing.isOrchestrator = true
      existing.plain = id
      if (display_name) existing.name = display_name
      families.set(id, existing)
      continue
    }
    const variant = id.match(/^(.+)-(low|medium|high|xhigh|max)$/i)
    const key = variant?.[1] ?? id
    const level = variant?.[2].toLowerCase()
    const label = level ? display_name.replace(/\s*\((low|medium|high|xhigh|max|extra)\)\s*$/i, '') : display_name
    const family = families.get(key) ?? { key, name: label && label !== id ? label : key, variants: {} }
    if (level) family.variants[level] = id
    else family.plain = id
    if (item.efforts?.length) {
      const merged = new Set([...(family.efforts ?? []), ...item.efforts.map(e => e.toLowerCase())])
      family.efforts = [...merged]
    }
    if (item.default_effort) family.defaultEffort = item.default_effort.toLowerCase()
    families.set(key, family)
  }
  return [...families.values()]
}

export function buildOrchestratorRoleChoices(items: AntiModels['items']) {
  const options: Array<{ id: string; label: string }> = []
  const seen = new Set<string>()
  const push = (id: string, label: string) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    options.push({ id, label })
  }
  for (const item of items) {
    if (item.is_orchestrator || /orchestrator/i.test(item.id)) continue
    if (item.efforts?.length && !/-(low|medium|high|xhigh|max)$/i.test(item.id)) {
      for (const lvl of item.efforts) {
        const titleLevel = EFFORT_SHORT_LABELS[lvl] ?? lvl
        push(`${item.id}-${lvl}`, `${item.display_name} (${titleLevel})`)
      }
    } else {
      push(item.id, item.display_name || item.id)
    }
  }
  return options
}

export function AntiModelSelector({
  families,
  selectedFamilyKey,
  effort,
  effortOptions,
  isOrchestrator,
  orchestratorSummary,
  disabled,
  title,
  onSelectFamily,
  onSelectEffort,
  onOpenOrchestratorSettings,
}: {
  families: ReadonlyArray<AgyModelFamily>
  selectedFamilyKey: string | undefined
  effort: string
  effortOptions: ReadonlyArray<{ key: string; name: string }>
  isOrchestrator: boolean
  orchestratorSummary?: AgyOrchestratorSettings
  disabled?: boolean
  title?: string
  onSelectFamily: (key: string) => void
  onSelectEffort: (effort: string) => void
  onOpenOrchestratorSettings?: () => void
}) {
  const selected = families.find(item => item.key === selectedFamilyKey) ?? families[0]
  const disabledNow = Boolean(disabled || families.length === 0)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const upwards = below < 220 && above > below
      const available = Math.max(96, upwards ? above : below)
      const width = Math.min(340, Math.max(rect.width, 260), window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setPosition({
        position: 'fixed',
        width,
        left,
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        maxHeight: Math.min(360, available),
        zIndex: Z_LAYERS.contextMenu,
      })
    }
    place()
    window.addEventListener('resize', place)
    const onScroll = (event: Event) => {
      if (!menuRef.current?.contains(event.target as Node)) place()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, families.length])

  useEffect(() => {
    if (!open) return
    if (disabledNow) {
      setOpen(false)
      return
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open, disabledNow])

  const effortText = EFFORT_SHORT_LABELS[effort] ?? effort
  const hasEffort = !isOrchestrator && effortOptions.length > 0
  const hasCustomOrch = Boolean(orchestratorSummary?.planner || orchestratorSummary?.executor)
  const triggerTitle = title
    ?? (selected
      ? (hasEffort ? `${selected.name} · 思考强度 ${effortText}` : selected.name)
      : '模型')

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label="模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabledNow}
        title={triggerTitle}
        onClick={() => { if (!disabledNow) setOpen(prev => !prev) }}
        className="inline-flex h-[35px] min-h-[35px] max-h-[35px] min-w-0 max-w-[15rem] sm:max-w-[19rem] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-line bg-gradient-to-br from-bg-soft to-bg-card px-2.5 text-left text-sm text-ink shadow-[inset_0_1px_rgba(255,250,232,0.7),0_2px_3px_rgba(58,42,28,0.08)] transition-[border-color,box-shadow] hover:border-accent focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="model-select-label min-w-0 flex-1 truncate">
          {selected?.name ?? (families.length ? '选择模型' : '暂无模型')}
        </span>
        {hasEffort && (
          <span
            data-anti-effort-badge
            className="shrink-0 rounded border border-accent/25 bg-accent-soft/75 px-1.5 py-0.5 text-[11px] font-medium leading-none text-accent"
          >
            {effortText}
          </span>
        )}
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={clsx('shrink-0 text-ink-muted transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          style={position}
          className="model-select-menu flex flex-col overflow-hidden"
          onMouseDown={event => event.preventDefault()}
        >
          <div role="listbox" aria-label="模型" className="min-h-0 flex-1 overflow-y-auto p-1">
            {families.map(item => {
              const isSelected = item.key === selected?.key
              return (
                <button
                  key={item.key}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  title={item.name}
                  onClick={() => {
                    onSelectFamily(item.key)
                    setOpen(false)
                    triggerRef.current?.focus()
                  }}
                  className={clsx(
                    'flex min-h-[32px] w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-sm text-ink transition-colors hover:bg-accent-soft/60',
                    isSelected && 'bg-accent-soft/75 font-medium',
                  )}
                >
                  <span className="model-select-label min-w-0 flex-1 truncate whitespace-nowrap">
                    {item.name}
                  </span>
                  {item.isOrchestrator && (
                    <span className="shrink-0 rounded bg-bg-soft px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                      Orch
                    </span>
                  )}
                  {isSelected && <Check size={14} aria-hidden="true" className="shrink-0 text-accent" />}
                </button>
              )
            })}
          </div>
          {hasEffort && (
            <div className="shrink-0 border-t border-line/60 bg-bg-soft/50 px-2.5 py-2">
              <div role="radiogroup" aria-label="思考等级" className="flex flex-wrap items-center justify-center gap-1">
                {effortOptions.map(option => {
                  const active = option.key === effort
                  return (
                    <button
                      key={option.key}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      aria-label={option.name}
                      title={option.name}
                      data-anti-effort-option={option.key}
                      onClick={() => {
                        onSelectEffort(option.key)
                        setOpen(false)
                        triggerRef.current?.focus()
                      }}
                      className={clsx(
                        'rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors',
                        active
                          ? 'bg-accent text-white shadow-sm'
                          : 'border border-line/70 bg-bg-card text-ink-muted hover:border-accent/60 hover:text-ink',
                      )}
                    >
                      {EFFORT_SHORT_LABELS[option.key] ?? option.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {isOrchestrator && onOpenOrchestratorSettings && (
            <div className="shrink-0 border-t border-line/60 bg-bg-soft/50 px-2.5 py-2 text-[11px]">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-ink-muted">
                  {hasCustomOrch ? 'Planner / Executor 已自定义' : 'Planner / Executor：默认 High'}
                </span>
                <button
                  type="button"
                  className="ga-btn-link shrink-0 px-1 py-0 text-[11px]"
                  onClick={() => {
                    setOpen(false)
                    onOpenOrchestratorSettings()
                  }}
                >
                  去设置 →
                </button>
              </div>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
