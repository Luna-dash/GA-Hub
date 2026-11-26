import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Brain } from 'lucide-react'
import clsx from 'clsx'
import { RotateCw, X } from '@/components/ActionIcons'
import { antiApi, type AntiModels, type AntiOrchestratorPreset } from '@/api/client'
import {
  composeModelVariantId,
  DEFAULT_MODEL,
  DEFAULT_ORCHESTRATOR_PRESETS,
  EFFORT_SHORT_LABELS,
  getFamilyEffortOptions,
  getOfficialOrchestratorRoleFamilies,
  modelFamilies,
  normalizeOrchestratorPresets,
  ORCH_PRESET_KEY_PREFIX,
  resolveEffortForFamily,
  splitModelVariantId,
  type AgyModelFamily,
} from '@/components/AntiModelSelector'
import { ModalOverlay } from '@/components/ModalOverlay'
import { readPageState } from '@/utils/pageState'

const syncTimeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function formatSyncTime(raw?: string | null) {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? syncTimeFormat.format(ms) : null
}

function resolveActivePresetIdFromStorage(): 'preset-1' | 'preset-2' | null {
  const stored = readPageState<string>('antiChat.modelFamily', '')
  if (stored === `${ORCH_PRESET_KEY_PREFIX}preset-1`) return 'preset-1'
  if (stored === `${ORCH_PRESET_KEY_PREFIX}preset-2`) return 'preset-2'
  if (/orchestrator/i.test(stored)) {
    return stored === 'gemini-pro-orchestrator' || stored.toLowerCase().includes('carbon')
      ? 'preset-2'
      : 'preset-1'
  }
  return null
}

function RoleConfigRow({
  label,
  selectAriaLabel,
  effortAriaLabel,
  modelValue,
  families,
  disabled,
  onChange,
}: {
  label: string
  selectAriaLabel: string
  effortAriaLabel: string
  modelValue: string | null | undefined
  families: ReadonlyArray<AgyModelFamily>
  disabled: boolean
  onChange: (nextModelId: string) => void
}) {
  const parts = splitModelVariantId(modelValue)
  const matchedFamily = families.find(f => f.key === parts.familyKey)
  const effortOptions = matchedFamily
    ? getFamilyEffortOptions(matchedFamily)
    : [{ key: parts.effort, name: parts.effort }]

  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-8 shrink-0 text-[11px] font-medium text-ink-muted">{label}</span>
        <select
          aria-label={selectAriaLabel}
          value={parts.familyKey}
          disabled={disabled}
          onChange={event => {
            const nextKey = event.target.value
            const nextFam = families.find(f => f.key === nextKey)
            const nextEffort = resolveEffortForFamily(nextFam, parts.effort)
            onChange(composeModelVariantId(nextKey, nextEffort, nextFam))
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-line bg-bg-soft/60 px-2 text-xs text-ink outline-none focus:border-accent"
        >
          {parts.familyKey && !matchedFamily && (
            <option value={parts.familyKey}>{parts.familyKey}（当前配置）</option>
          )}
          {families.map(fam => (
            <option key={fam.key} value={fam.key}>{fam.name}</option>
          ))}
        </select>
      </div>
      <div role="radiogroup" aria-label={effortAriaLabel} className="flex flex-wrap items-center gap-1 sm:shrink-0">
        {effortOptions.map(option => {
          const active = option.key === parts.effort
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.name}
              disabled={disabled}
              onClick={() => onChange(composeModelVariantId(parts.familyKey, option.key, matchedFamily))}
              className={clsx(
                'rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50',
                active
                  ? 'bg-accent text-[var(--c-accent-fg)] shadow-sm'
                  : 'border border-line/70 bg-bg-soft/50 text-ink-muted hover:border-accent/60 hover:text-ink',
              )}
            >
              {EFFORT_SHORT_LABELS[option.key] ?? option.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export function AntiOrchestratorModal({
  open,
  onClose,
  profileId,
}: {
  open: boolean
  onClose: () => void
  profileId: string
}) {
  const cache = useQueryClient()
  const effectivePid = profileId || 'default'
  const [message, setMessage] = useState('')
  const [presetDrafts, setPresetDrafts] = useState<[AntiOrchestratorPreset, AntiOrchestratorPreset]>(() =>
    normalizeOrchestratorPresets(DEFAULT_ORCHESTRATOR_PRESETS),
  )
  const [hiddenDraft, setHiddenDraft] = useState<string[]>([])

  const modelsQuery = useQuery({
    queryKey: ['anti-models', effectivePid],
    enabled: open && Boolean(effectivePid),
    queryFn: ({ signal }) => antiApi.models(signal),
    staleTime: 60_000,
    retry: false,
  })
  const modelsConfigQuery = useQuery({
    queryKey: ['anti-models-config'],
    enabled: open,
    queryFn: ({ signal }) => antiApi.modelsConfig(signal),
    staleTime: 60_000,
    retry: false,
  })

  useEffect(() => {
    if (!open) return
    setPresetDrafts(normalizeOrchestratorPresets(modelsConfigQuery.data?.orchestrator_presets))
    setHiddenDraft(Array.isArray(modelsConfigQuery.data?.hidden_models) ? modelsConfigQuery.data.hidden_models : [])
  }, [open, modelsConfigQuery.data])

  const syncModels = useMutation({
    mutationFn: () => antiApi.syncModels(),
    onMutate: () => {
      setMessage('')
    },
    onSuccess: synced => {
      cache.setQueryData(['anti-models', effectivePid], synced)
      void cache.invalidateQueries({ queryKey: ['anti-models'] })
      setMessage(`已同步上游模型（${synced.items.length} 个）。`)
    },
  })

  const saveConfig = useMutation({
    mutationFn: async ({
      presets,
      hiddenModels,
    }: {
      presets: ReadonlyArray<AntiOrchestratorPreset>
      hiddenModels: ReadonlyArray<string>
    }) => {
      const cleanedPresets = normalizeOrchestratorPresets(presets).map((preset, idx) => ({
        ...preset,
        name: preset.name.trim() || DEFAULT_ORCHESTRATOR_PRESETS[idx].name,
      }))
      const saved = await antiApi.updateModelsConfig({
        orchestrator_presets: cleanedPresets,
        hidden_models: [...new Set(hiddenModels.map(m => m.trim()).filter(Boolean))],
      })
      const activePresetId = resolveActivePresetIdFromStorage()
      const activePreset = activePresetId
        ? cleanedPresets.find(p => p.id === activePresetId)
        : undefined
      if (activePreset && effectivePid) {
        const updatedOrch = await antiApi.updateProfileOrchestrator(effectivePid, {
          planner: activePreset.planner ?? null,
          executor: activePreset.executor ?? null,
        })
        cache.setQueryData(['anti-orchestrator', effectivePid], updatedOrch)
        void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      }
      return saved
    },
    onMutate: () => {
      setMessage('')
    },
    onSuccess: saved => {
      cache.setQueryData(['anti-models-config'], saved)
      setPresetDrafts(normalizeOrchestratorPresets(saved.orchestrator_presets))
      setHiddenDraft(Array.isArray(saved.hidden_models) ? saved.hidden_models : [])
      setMessage('已保存，顶栏模型与空闲进程已刷新。')
    },
  })

  const allItems: AntiModels['items'] = modelsQuery.data?.items ?? [DEFAULT_MODEL]
  const plannerFamilies = useMemo(() => getOfficialOrchestratorRoleFamilies(allItems, 'planner'), [allItems])
  const executorFamilies = useMemo(() => getOfficialOrchestratorRoleFamilies(allItems, 'executor'), [allItems])
  const normalFamilies = useMemo(() => modelFamilies(allItems).filter(f => !f.isOrchestrator), [allItems])
  const hasUpstreamOrch = useMemo(
    () => allItems.some(item => Boolean(item.is_orchestrator) || /orchestrator/i.test(item.id)),
    [allItems],
  )

  const hiddenSet = new Set(hiddenDraft)
  const visibleCount = normalFamilies.filter(fam => !hiddenSet.has(fam.key)).length

  const close = () => {
    if (syncModels.isPending || saveConfig.isPending) return
    onClose()
    setMessage('')
    syncModels.reset()
    saveConfig.reset()
  }

  if (!open) return null

  const compactBtn = 'ga-btn-sm h-7 shrink-0 px-2 py-0 text-[11px]'
  const compactPrimaryBtn = 'ga-btn-sm-primary h-7 shrink-0 px-2.5 py-0 text-[11px]'
  const formDisabled = modelsConfigQuery.isPending || saveConfig.isPending

  const updatePreset = (index: 0 | 1, patch: Partial<AntiOrchestratorPreset>) => {
    setPresetDrafts(prev => {
      const next: [AntiOrchestratorPreset, AntiOrchestratorPreset] = [{ ...prev[0] }, { ...prev[1] }]
      next[index] = { ...next[index], ...patch }
      return next
    })
  }

  return createPortal(
    <ModalOverlay
      onClose={close}
      labelledBy="agy-orchestrator-title"
      panelClassName="flex max-h-[88vh] w-[36rem] max-w-[94vw] flex-col overflow-hidden p-0"
    >
      <div className="shrink-0 border-b border-line/60 px-4 py-3 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Brain size={15} className="shrink-0 text-accent" aria-hidden="true" />
            <h2 id="agy-orchestrator-title" className="truncate text-sm font-semibold text-ink">
              模型筛选与 Orchestrator 预设
            </h2>
          </div>
          <button
            type="button"
            className={compactBtn}
            onClick={close}
            disabled={syncModels.isPending || saveConfig.isPending}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            <span>关闭</span>
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 sm:px-5">
        <div role="status" className="rounded-md bg-bg-card/80 px-2.5 py-1.5 text-xs text-ink-muted empty:hidden">
          {message}
        </div>
        <section
          data-anti-models-orch-section
          aria-labelledby="agy-models-orch-title"
          className="space-y-3 rounded-lg border border-line/70 bg-bg-card p-3 text-xs"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 id="agy-models-orch-title" className="truncate text-sm font-semibold text-ink">
                上游模型目录
              </h3>
              <p className="mt-0.5 text-[11px] text-ink-muted">
                {modelsQuery.data?.items
                  ? `共 ${modelsQuery.data.items.length} 个模型${formatSyncTime(modelsQuery.data.synced_at) ? ` · 同步于 ${formatSyncTime(modelsQuery.data.synced_at)}` : ''}`
                  : '默认每日 00/06/12/18 点自动同步上游目录'}
              </p>
            </div>
            <button
              type="button"
              className={compactBtn}
              disabled={syncModels.isPending}
              aria-label="同步上游模型"
              onClick={() => syncModels.mutate()}
            >
              <RotateCw size={12} className={syncModels.isPending ? 'animate-spin motion-reduce:animate-none' : undefined} aria-hidden="true" />
              <span>{syncModels.isPending ? '同步中…' : '同步上游模型'}</span>
            </button>
          </div>
          {syncModels.error && (
            <p className="text-[11px] text-status-danger">
              {syncModels.error instanceof Error ? syncModels.error.message : '同步上游模型失败'}
            </p>
          )}

          <div data-anti-orchestrator-section className="space-y-2.5 border-t border-line/60 pt-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-ink">Orchestrator 预设搭配（2 套）</span>
              <span className="text-[11px] text-ink-muted">仅保留官方支持的角色模型 · 全局共享</span>
            </div>
            <div className="space-y-2.5">
              {presetDrafts.map((preset, idx) => {
                const slot = (idx === 0 ? 0 : 1) as 0 | 1
                const defaultName = DEFAULT_ORCHESTRATOR_PRESETS[slot].name
                return (
                  <div
                    key={preset.id}
                    data-anti-orch-preset={preset.id}
                    className="space-y-2 rounded-lg border border-line/60 bg-bg-soft/40 p-2.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-ink">预设 {idx + 1}</span>
                      <label className="flex items-center gap-1 text-[11px] text-ink-muted">
                        <span className="shrink-0">Orch ·</span>
                        <input
                          type="text"
                          aria-label={`预设 ${idx + 1} 名称`}
                          value={preset.name}
                          maxLength={24}
                          placeholder={defaultName}
                          disabled={formDisabled}
                          onChange={event => updatePreset(slot, { name: event.target.value })}
                          className="h-6 w-28 rounded border border-line bg-bg-card px-1.5 text-xs text-ink outline-none focus:border-accent"
                        />
                      </label>
                    </div>
                    <RoleConfigRow
                      label="规划"
                      selectAriaLabel={`预设 ${idx + 1} Planner 模型`}
                      effortAriaLabel={`预设 ${idx + 1} Planner 思考等级`}
                      modelValue={preset.planner}
                      families={plannerFamilies}
                      disabled={formDisabled}
                      onChange={nextPlanner => updatePreset(slot, { planner: nextPlanner })}
                    />
                    <RoleConfigRow
                      label="执行"
                      selectAriaLabel={`预设 ${idx + 1} Executor 模型`}
                      effortAriaLabel={`预设 ${idx + 1} Executor 思考等级`}
                      modelValue={preset.executor}
                      families={executorFamilies}
                      disabled={formDisabled}
                      onChange={nextExecutor => updatePreset(slot, { executor: nextExecutor })}
                    />
                  </div>
                )
              })}
            </div>
          </div>

          <div data-anti-model-visibility-section className="space-y-2 border-t border-line/60 pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink">
                顶栏显示模型（已显示 {visibleCount} / {normalFamilies.length}）
              </span>
              <button
                type="button"
                className="ga-btn-link px-1 py-0 text-[11px] disabled:opacity-40"
                disabled={hiddenDraft.length === 0 || formDisabled}
                onClick={() => setHiddenDraft([])}
              >
                全部显示
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {normalFamilies.map(fam => {
                const isVisible = !hiddenSet.has(fam.key)
                const isLastVisible = !hasUpstreamOrch && isVisible && visibleCount <= 1
                const effortHint = getFamilyEffortOptions(fam)
                  .map(opt => EFFORT_SHORT_LABELS[opt.key] ?? opt.name)
                  .join(' / ')
                return (
                  <label
                    key={fam.key}
                    className={clsx(
                      'flex cursor-pointer items-center gap-2 rounded-md border border-line/50 bg-bg-soft/35 px-2 py-1.5 transition-colors hover:border-accent/40',
                      isLastVisible && 'opacity-70',
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={`显示模型 ${fam.name}`}
                      checked={isVisible}
                      disabled={formDisabled || isLastVisible}
                      onChange={event => {
                        const checked = event.target.checked
                        setHiddenDraft(prev => (
                          checked
                            ? prev.filter(id => id !== fam.key)
                            : [...new Set([...prev, fam.key])]
                        ))
                      }}
                      className="h-3.5 w-3.5 rounded border-line text-accent accent-accent"
                    />
                    <span className="min-w-0 flex-1 truncate text-xs text-ink">{fam.name}</span>
                    {effortHint && (
                      <span className="shrink-0 text-[10px] text-ink-faint">{effortHint}</span>
                    )}
                  </label>
                )
              })}
            </div>
          </div>

          {saveConfig.error && (
            <p className="text-[11px] text-status-danger">
              {saveConfig.error instanceof Error ? saveConfig.error.message : '保存设置失败'}
            </p>
          )}
          <div className="flex items-center justify-end gap-1.5 border-t border-line/50 pt-2.5">
            <button
              type="button"
              className={compactBtn}
              disabled={formDisabled}
              onClick={() => saveConfig.mutate({
                presets: [...DEFAULT_ORCHESTRATOR_PRESETS],
                hiddenModels: [],
              })}
            >
              恢复默认
            </button>
            <button
              type="button"
              className={compactPrimaryBtn}
              disabled={formDisabled}
              onClick={() => saveConfig.mutate({
                presets: presetDrafts,
                hiddenModels: hiddenDraft,
              })}
            >
              {saveConfig.isPending ? '保存中…' : '保存设置'}
            </button>
          </div>
        </section>
      </div>
    </ModalOverlay>,
    document.body,
  )
}
