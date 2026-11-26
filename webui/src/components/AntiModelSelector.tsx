import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import type { AntiModels, AntiOrchestratorPreset } from '@/api/client'
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

export const EFFORT_SHORT_LABELS: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export const OFFICIAL_ORCH_PLANNER_FAMILIES = [
  'gemini-4-neon',
  'gemini-4-carbon',
  'gemini-4-argon',
  'claude-opus-5-5',
] as const

export const OFFICIAL_ORCH_EXECUTOR_FAMILIES = [
  'gemini-4-hydrogen',
  'claude-sonnet-5-5',
] as const

export const ORCH_PRESET_KEY_PREFIX = 'orch-preset:'

export const DEFAULT_ORCHESTRATOR_PRESETS: readonly [AntiOrchestratorPreset, AntiOrchestratorPreset] = [
  {
    id: 'preset-1',
    name: 'Neon',
    planner: 'gemini-4-neon-high',
    executor: 'gemini-4-hydrogen-high',
  },
  {
    id: 'preset-2',
    name: 'Carbon',
    planner: 'gemini-4-carbon-high',
    executor: 'gemini-4-hydrogen-high',
  },
]

export interface AgyModelFamily {
  key: string
  name: string
  variants: Partial<Record<string, string>>
  plain?: string
  efforts?: string[]
  defaultEffort?: string
  isOrchestrator?: boolean
  subtitle?: string
  tooltip?: string
  preset?: AntiOrchestratorPreset
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

export function normalizeOrchestratorPresets(
  raw?: ReadonlyArray<AntiOrchestratorPreset> | null,
): [AntiOrchestratorPreset, AntiOrchestratorPreset] {
  const entries = Array.isArray(raw) ? raw : []
  const byId = new Map<string, AntiOrchestratorPreset>()
  for (const entry of entries) {
    if (entry && (entry.id === 'preset-1' || entry.id === 'preset-2') && !byId.has(entry.id)) {
      byId.set(entry.id, entry)
    }
  }
  return DEFAULT_ORCHESTRATOR_PRESETS.map((fallback, idx) => {
    const src = byId.get(fallback.id) ?? (entries[idx] && typeof entries[idx] === 'object' ? entries[idx] : undefined)
    const trimmedName = typeof src?.name === 'string' ? src.name.trim() : ''
    const hasPlanner = Boolean(src && Object.prototype.hasOwnProperty.call(src, 'planner'))
    const hasExecutor = Boolean(src && Object.prototype.hasOwnProperty.call(src, 'executor'))
    const planner = hasPlanner
      ? (typeof src?.planner === 'string' && src.planner.trim() ? src.planner.trim() : null)
      : fallback.planner
    const executor = hasExecutor
      ? (typeof src?.executor === 'string' && src.executor.trim() ? src.executor.trim() : null)
      : fallback.executor
    return {
      id: fallback.id,
      name: (trimmedName || fallback.name).slice(0, 32),
      planner,
      executor,
    }
  }) as [AntiOrchestratorPreset, AntiOrchestratorPreset]
}

export function splitModelVariantId(modelId?: string | null): { familyKey: string; effort: string } {
  const clean = (modelId || '').trim()
  const match = clean.match(/^(.+)-(low|medium|high|xhigh|max)$/i)
  if (match) {
    return { familyKey: match[1], effort: match[2].toLowerCase() }
  }
  return { familyKey: clean, effort: DEFAULT_EFFORT }
}

export function getFamilyEffortOptions(family?: AgyModelFamily) {
  if (!family || family.isOrchestrator) return []
  if (family.efforts?.length) {
    return EFFORT_OPTIONS.filter(option => family.efforts!.includes(option.key))
  }
  const variantOptions = EFFORT_OPTIONS.filter(option => Boolean(family.variants[option.key]))
  if (variantOptions.length > 0) return variantOptions
  return family.plain ? [...EFFORT_OPTIONS] : []
}

export function resolveEffortForFamily(family: AgyModelFamily | undefined, preferred: string): string {
  const options = getFamilyEffortOptions(family)
  if (options.length === 0) return family?.defaultEffort ?? DEFAULT_EFFORT
  return (
    options.find(opt => opt.key === preferred)?.key
    ?? options.find(opt => opt.key === (family?.defaultEffort ?? DEFAULT_EFFORT))?.key
    ?? options.find(opt => opt.key === DEFAULT_EFFORT)?.key
    ?? options[0]?.key
    ?? DEFAULT_EFFORT
  )
}

export function composeModelVariantId(familyKey: string, effort: string, family?: AgyModelFamily): string {
  const cleanFamily = familyKey.trim()
  if (!cleanFamily) return DEFAULT_MODEL.id
  const cleanEffort = effort.trim().toLowerCase() || DEFAULT_EFFORT
  if (family?.variants[cleanEffort]) return family.variants[cleanEffort]!
  const hasVariants = Boolean(family && (Object.keys(family.variants).length > 0 || (family.efforts?.length ?? 0) > 0))
  if (family?.plain && !hasVariants) return family.plain
  return `${cleanFamily}-${cleanEffort}`
}

export function getOfficialOrchestratorRoleFamilies(
  items: AntiModels['items'],
  role: 'planner' | 'executor',
): AgyModelFamily[] {
  const allowlist: ReadonlyArray<string> = role === 'planner'
    ? OFFICIAL_ORCH_PLANNER_FAMILIES
    : OFFICIAL_ORCH_EXECUTOR_FAMILIES
  const byKey = new Map(
    modelFamilies(items)
      .filter(f => !f.isOrchestrator)
      .map(f => [f.key, f]),
  )
  const out: AgyModelFamily[] = []
  for (const key of allowlist) {
    const fam = byKey.get(key)
    if (fam) out.push(fam)
  }
  return out
}

export function resolveUpstreamOrchestratorModelId(
  items: AntiModels['items'],
  plannerId?: string | null,
): string {
  const upstreamOrchIds = items
    .filter(item => Boolean(item.is_orchestrator) || /orchestrator/i.test(item.id))
    .map(item => item.id)
  const { familyKey } = splitModelVariantId(plannerId)
  const preferredOrder = familyKey === 'gemini-4-carbon'
    ? ['gemini-pro-orchestrator', 'gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator-argon']
    : familyKey === 'gemini-4-argon'
      ? ['gemini-pro-orchestrator-argon', 'gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator']
      : ['gemini-pro-orchestrator-neon', 'gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon']
  for (const candidate of preferredOrder) {
    if (upstreamOrchIds.includes(candidate)) return candidate
  }
  return upstreamOrchIds[0] ?? preferredOrder[0]
}

export function formatOrchestratorPresetLabel(name: string): string {
  const clean = name.trim()
  return `Orch · ${clean || '默认'}`
}

function compactFamilyName(name: string): string {
  return name
    .replace(/^Gemini\s+\d+(?:\.\d+)?\s+/i, '')
    .replace(/^Claude\s+/i, '')
    .trim() || name
}

export function formatFullRoleLabel(
  modelId: string | null | undefined,
  allFamilies: ReadonlyArray<AgyModelFamily>,
): string {
  if (!modelId) return '默认 (High)'
  const { familyKey, effort } = splitModelVariantId(modelId)
  const fam = allFamilies.find(f => f.key === familyKey)
  const label = fam?.name ?? familyKey
  const effortLabel = EFFORT_SHORT_LABELS[effort] ?? effort
  return `${label} (${effortLabel})`
}

export function formatCompactRoleLabel(
  modelId: string | null | undefined,
  allFamilies: ReadonlyArray<AgyModelFamily>,
): string {
  if (!modelId) return '默认 High'
  const { familyKey, effort } = splitModelVariantId(modelId)
  const fam = allFamilies.find(f => f.key === familyKey)
  const baseName = compactFamilyName(fam?.name ?? familyKey)
  const effortLabel = EFFORT_SHORT_LABELS[effort] ?? effort
  return `${baseName} ${effortLabel}`
}

export function buildSelectorFamilies(
  items: AntiModels['items'],
  presets?: ReadonlyArray<AntiOrchestratorPreset> | null,
  hiddenModels?: ReadonlyArray<string> | null,
): AgyModelFamily[] {
  const allFamilies = modelFamilies(items)
  const normalFamilies = allFamilies.filter(f => !f.isOrchestrator)
  const hiddenSet = new Set((hiddenModels ?? []).map(s => s.trim()).filter(Boolean))
  const visibleNormal = normalFamilies.filter(f => !hiddenSet.has(f.key))
  const hasUpstreamOrch = items.some(item => Boolean(item.is_orchestrator) || /orchestrator/i.test(item.id))

  const orchFamilies: AgyModelFamily[] = hasUpstreamOrch
    ? normalizeOrchestratorPresets(presets).map(preset => {
      const plannerCompact = formatCompactRoleLabel(preset.planner, normalFamilies)
      const executorCompact = formatCompactRoleLabel(preset.executor, normalFamilies)
      const plannerFull = formatFullRoleLabel(preset.planner, normalFamilies)
      const executorFull = formatFullRoleLabel(preset.executor, normalFamilies)
      return {
        key: `${ORCH_PRESET_KEY_PREFIX}${preset.id}`,
        name: formatOrchestratorPresetLabel(preset.name),
        subtitle: `${plannerCompact} → ${executorCompact}`,
        tooltip: `规划：${plannerFull} · 执行：${executorFull}`,
        variants: {},
        efforts: [],
        isOrchestrator: true,
        preset,
      }
    })
    : []

  const combined = [...visibleNormal, ...orchFamilies]
  return combined.length > 0 ? combined : normalFamilies
}

export function normalizeSelectedFamilyKey(
  rawKey: string | undefined,
  visibleFamilies: ReadonlyArray<AgyModelFamily>,
  presets: ReadonlyArray<AntiOrchestratorPreset> = DEFAULT_ORCHESTRATOR_PRESETS,
): string | undefined {
  if (visibleFamilies.length === 0) return undefined
  if (rawKey && visibleFamilies.some(f => f.key === rawKey)) return rawKey
  if (rawKey && /orchestrator/i.test(rawKey)) {
    const lower = rawKey.toLowerCase()
    const targetHint = lower.includes('argon')
      ? 'argon'
      : rawKey === 'gemini-pro-orchestrator' || lower.includes('carbon')
        ? 'carbon'
        : 'neon'
    const matchedPreset = presets.find(p => (p.planner || '').toLowerCase().includes(targetHint)) ?? presets[0]
    const candidateKey = `${ORCH_PRESET_KEY_PREFIX}${matchedPreset?.id ?? 'preset-1'}`
    if (visibleFamilies.some(f => f.key === candidateKey)) return candidateKey
  }
  return visibleFamilies[0]?.key
}

export function AntiModelSelector({
  families,
  selectedFamilyKey,
  effort,
  effortOptions,
  isOrchestrator,
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
      const width = Math.min(340, Math.max(rect.width, 268), window.innerWidth - 16)
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
      setPosition({
        position: 'fixed',
        width,
        left,
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        maxHeight: Math.min(380, available),
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
  const triggerTitle = title
    ?? (selected
      ? (selected.tooltip
        ? `${selected.name} · ${selected.tooltip}`
        : (hasEffort ? `${selected.name} · 思考强度 ${effortText}` : selected.name))
      : '模型')

  const firstOrchIndex = families.findIndex(f => Boolean(f.isOrchestrator))

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
        className="inline-flex h-[35px] min-h-[35px] max-h-[35px] min-w-0 max-w-[15rem] sm:max-w-[19rem] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[9px] border border-line bg-gradient-to-br from-bg-soft to-bg-card px-2.5 text-left text-sm text-ink shadow-[inset_0_1px_var(--c-inset-highlight),0_2px_3px_rgba(58,42,28,0.08)] transition-[border-color,box-shadow] hover:border-accent focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
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
            {families.map((item, idx) => {
              const isSelected = item.key === selected?.key
              const showSeparator = firstOrchIndex > 0 && idx === firstOrchIndex
              return (
                <div key={item.key}>
                  {showSeparator && <div role="separator" className="my-1 border-t border-line/50" />}
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    title={item.tooltip ?? item.name}
                    onClick={() => {
                      onSelectFamily(item.key)
                      setOpen(false)
                      triggerRef.current?.focus()
                    }}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-left text-sm text-ink transition-colors hover:bg-accent-soft/60',
                      item.subtitle ? 'min-h-[40px]' : 'min-h-[32px]',
                      isSelected && 'bg-accent-soft/75 font-medium',
                    )}
                  >
                    {item.subtitle ? (
                      <div className="min-w-0 flex-1">
                        <div className="model-select-label truncate whitespace-nowrap">
                          {item.name}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] font-normal leading-tight text-ink-muted">
                          {item.subtitle}
                        </div>
                      </div>
                    ) : (
                      <span className="model-select-label min-w-0 flex-1 truncate whitespace-nowrap">
                        {item.name}
                      </span>
                    )}
                    {item.isOrchestrator && (
                      <span className="shrink-0 rounded bg-bg-soft px-1.5 py-0.5 text-[10px] font-medium text-ink-muted">
                        Orch
                      </span>
                    )}
                    {isSelected && <Check size={14} aria-hidden="true" className="shrink-0 text-accent" />}
                  </button>
                </div>
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
                          ? 'bg-accent text-[var(--c-accent-fg)] shadow-sm'
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
          {onOpenOrchestratorSettings && (
            <div className="shrink-0 border-t border-line/60 bg-bg-soft/50 px-2.5 py-1.5 text-center text-[11px]">
              <button
                type="button"
                data-anti-open-model-settings
                className="ga-btn-link px-1 py-0.5 text-[11px]"
                onClick={() => {
                  setOpen(false)
                  onOpenOrchestratorSettings()
                }}
              >
                模型筛选与 Orch 预设 →
              </button>
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
