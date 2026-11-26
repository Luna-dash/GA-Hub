// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AntiModelSelector,
  buildSelectorFamilies,
  DEFAULT_ORCHESTRATOR_PRESETS,
  getOfficialOrchestratorRoleFamilies,
  normalizeSelectedFamilyKey,
  ORCH_PRESET_KEY_PREFIX,
  resolveUpstreamOrchestratorModelId,
} from './AntiModelSelector'
import type { AntiModels } from '@/api/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SAMPLE_ITEMS: AntiModels['items'] = [
  { id: 'gemini-4-neon', display_name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], is_default: true },
  { id: 'gemini-4-carbon', display_name: 'Gemini 4 Carbon', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-4-argon', display_name: 'Gemini 4 Argon', efforts: ['low', 'medium', 'high'] },
  { id: 'gemini-4-hydrogen', display_name: 'Gemini 4 Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'] },
  { id: 'gpt-oss-120b-medium', display_name: 'GPT-OSS 120B (Medium)' },
  { id: 'gemini-pro-orchestrator-neon', display_name: 'Orchestrator (Neon)', is_orchestrator: true },
  { id: 'gemini-pro-orchestrator', display_name: 'Orchestrator (Carbon)', is_orchestrator: true },
]

describe('AntiModelSelector helpers and component', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
      root = null
    }
    host?.remove()
    host = null
  })

  it('filters official Planner and Executor role candidates strictly', () => {
    const planners = getOfficialOrchestratorRoleFamilies(SAMPLE_ITEMS, 'planner').map(f => f.key)
    const executors = getOfficialOrchestratorRoleFamilies(SAMPLE_ITEMS, 'executor').map(f => f.key)
    expect(planners).toEqual(['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'claude-opus-5-5'])
    expect(executors).toEqual(['gemini-4-hydrogen', 'claude-sonnet-5-5'])
  })

  it('maps presets to upstream Orchestrator IDs accurately', () => {
    expect(resolveUpstreamOrchestratorModelId(SAMPLE_ITEMS, 'gemini-4-neon-xhigh')).toBe('gemini-pro-orchestrator-neon')
    expect(resolveUpstreamOrchestratorModelId(SAMPLE_ITEMS, 'gemini-4-carbon-high')).toBe('gemini-pro-orchestrator')
    expect(resolveUpstreamOrchestratorModelId(SAMPLE_ITEMS, 'claude-opus-5-5-high')).toBe('gemini-pro-orchestrator-neon')
  })

  it('hides filtered normal models while keeping both Orch presets and safely migrates legacy keys', () => {
    const presets = [
      { id: 'preset-1', name: '主力架构', planner: 'gemini-4-neon-xhigh', executor: 'gemini-4-hydrogen-medium' },
      { id: 'preset-2', name: 'Carbon 方案', planner: 'gemini-4-carbon-high', executor: 'claude-sonnet-5-5-high' },
    ]
    const visible = buildSelectorFamilies(SAMPLE_ITEMS, presets, ['gpt-oss-120b', 'gemini-3.8-flash'])
    const keys = visible.map(f => f.key)
    expect(keys).not.toContain('gpt-oss-120b')
    expect(keys).not.toContain('gemini-3.8-flash')
    expect(keys).toContain(`${ORCH_PRESET_KEY_PREFIX}preset-1`)
    expect(keys).toContain(`${ORCH_PRESET_KEY_PREFIX}preset-2`)

    // Legacy Orch model keys map to the matching preset
    expect(normalizeSelectedFamilyKey('gemini-pro-orchestrator', visible, presets)).toBe(`${ORCH_PRESET_KEY_PREFIX}preset-2`)
    expect(normalizeSelectedFamilyKey('gemini-pro-orchestrator-neon', visible, presets)).toBe(`${ORCH_PRESET_KEY_PREFIX}preset-1`)
    // Hidden stored family falls back cleanly to first visible model
    expect(normalizeSelectedFamilyKey('gpt-oss-120b', visible, presets)).toBe('gemini-4-neon')

    // All normal models hidden + no upstream orch still falls back to unfiltered list so UI isn't empty
    const noOrchAllHidden = buildSelectorFamilies(
      SAMPLE_ITEMS.filter(i => !i.is_orchestrator),
      DEFAULT_ORCHESTRATOR_PRESETS,
      ['gemini-4-neon', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-hydrogen', 'gemini-3.8-flash', 'claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-oss-120b'],
    )
    expect(noOrchAllHidden.length).toBeGreaterThan(0)
  })

  it('closes immediately when selecting an Orch preset and exposes the settings action link', () => {
    const families = buildSelectorFamilies(SAMPLE_ITEMS, DEFAULT_ORCHESTRATOR_PRESETS, ['gpt-oss-120b'])
    const onSelectFamily = vi.fn()
    const onOpenSettings = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    act(() => {
      root!.render(
        <AntiModelSelector
          families={families}
          selectedFamilyKey="gemini-4-neon"
          effort="high"
          effortOptions={[{ key: 'low', name: 'low' }, { key: 'high', name: 'high' }]}
          isOrchestrator={false}
          onSelectFamily={onSelectFamily}
          onSelectEffort={vi.fn()}
          onOpenOrchestratorSettings={onOpenSettings}
        />,
      )
    })

    const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]')!
    act(() => { trigger.click() })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    expect(options.some(o => o.textContent?.includes('GPT-OSS 120B'))).toBe(false)

    const orchOption = options.find(o => o.textContent?.includes('Orch · Neon'))!
    expect(orchOption.textContent).toContain('Neon High → Hydrogen High')
    act(() => { orchOption.click() })

    expect(onSelectFamily).toHaveBeenCalledWith(`${ORCH_PRESET_KEY_PREFIX}preset-1`)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    act(() => { trigger.click() })
    const openSettingsBtn = document.body.querySelector<HTMLButtonElement>('[data-anti-open-model-settings]')!
    act(() => { openSettingsBtn.click() })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })
})
