// @vitest-environment jsdom
import { act, useState } from 'react'
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
    expect(orchOption.textContent).not.toContain('Neon High → Hydrogen High')
    expect(orchOption.getAttribute('title')).toContain('规划：')
    expect(orchOption.getAttribute('title')).toContain('执行：')
    act(() => { orchOption.click() })

    expect(onSelectFamily).toHaveBeenCalledWith(`${ORCH_PRESET_KEY_PREFIX}preset-1`)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    act(() => { trigger.click() })
    const footer = document.body.querySelector<HTMLElement>('[data-anti-model-footer]')!
    expect(footer).not.toBeNull()
    expect(footer.querySelector('[role="radiogroup"][aria-label="思考等级"]')).not.toBeNull()
    const openSettingsBtn = footer.querySelector<HTMLButtonElement>('[data-anti-open-model-settings]')!
    expect(openSettingsBtn).not.toBeNull()
    act(() => { openSettingsBtn.click() })
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('supports full keyboard navigation, typeahead, Tab footer handoff, menuRef-aware blur, and effort roving selection', () => {
    const families = buildSelectorFamilies(SAMPLE_ITEMS, DEFAULT_ORCHESTRATOR_PRESETS, ['gpt-oss-120b', 'gemini-3.8-flash'])
    const onSelectFamily = vi.fn()
    const onSelectEffort = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    const outside = document.createElement('button')
    outside.type = 'button'
    outside.textContent = 'Outside'
    host.append(outside)
    const mount = document.createElement('div')
    host.append(mount)
    root = createRoot(mount)

    function Harness() {
      const [effort, setEffort] = useState('high')
      return (
        <AntiModelSelector
          families={families}
          selectedFamilyKey="gemini-4-neon"
          effort={effort}
          effortOptions={[{ key: 'low', name: 'low' }, { key: 'medium', name: 'medium' }, { key: 'high', name: 'high' }]}
          isOrchestrator={false}
          onSelectFamily={onSelectFamily}
          onSelectEffort={(next) => {
            onSelectEffort(next)
            setEffort(next)
          }}
          onOpenOrchestratorSettings={vi.fn()}
        />
      )
    }

    act(() => {
      root!.render(<Harness />)
    })

    const trigger = mount.querySelector<HTMLButtonElement>('button[role="combobox"]')!
    const pressTrigger = (key: string, opts: Partial<KeyboardEventInit> = {}) => {
      let ev!: KeyboardEvent
      act(() => {
        ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
        trigger.dispatchEvent(ev)
      })
      return ev
    }

    trigger.focus()
    // ArrowDown opens at selected index (0: Gemini 4 Neon), next ArrowDown moves to index 1
    pressTrigger('ArrowDown')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const options = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    expect(options.every(o => o.tabIndex === -1)).toBe(true)
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options[0].id)

    pressTrigger('ArrowDown')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options[1].id)
    pressTrigger('End')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options[options.length - 1].id)
    pressTrigger('Home')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options[0].id)
    pressTrigger('ArrowUp')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(options[options.length - 1].id)

    // Enter commits active option and closes
    pressTrigger('Enter')
    expect(onSelectFamily).toHaveBeenLastCalledWith(families[families.length - 1].key)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    // Space opens, typeahead jumps to Claude Sonnet 5.5, Enter selects
    pressTrigger(' ')
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    for (const ch of 'claude s') pressTrigger(ch)
    const sonnetIdx = families.findIndex(f => f.key === 'claude-sonnet-5-5')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')[sonnetIdx].id,
    )
    pressTrigger('Enter')
    expect(onSelectFamily).toHaveBeenLastCalledWith('claude-sonnet-5-5')

    // Escape closes with stopPropagation and keeps focus on trigger
    pressTrigger('ArrowDown')
    const parentSpy = vi.fn()
    host.addEventListener('keydown', parentSpy)
    pressTrigger('Escape')
    host.removeEventListener('keydown', parentSpy)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(parentSpy).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)

    // Tab hands off focus into [data-anti-model-footer] without closing via blur
    pressTrigger('ArrowDown')
    const tabEv = pressTrigger('Tab')
    expect(tabEv.defaultPrevented).toBe(true)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const highRadio = document.body.querySelector<HTMLButtonElement>('[data-anti-effort-option="high"]')!
    expect(document.activeElement).toBe(highRadio)

    // ArrowLeft / ArrowRight inside radiogroup roves selection and moves focus
    const radiogroup = document.body.querySelector<HTMLElement>('[role="radiogroup"][aria-label="思考等级"]')!
    act(() => {
      radiogroup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    })
    expect(onSelectEffort).toHaveBeenLastCalledWith('low')
    expect(document.activeElement).toBe(document.body.querySelector('[data-anti-effort-option="low"]'))

    act(() => {
      radiogroup.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    })
    expect(onSelectEffort).toHaveBeenLastCalledWith('high')
    expect(document.activeElement).toBe(highRadio)

    // Blurring to an outside element closes the menu cleanly
    act(() => {
      outside.focus()
    })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('returns focus to trigger on Shift+Tab from non-first effort radio and resets typeahead on arrow nav', () => {
    const families = buildSelectorFamilies(SAMPLE_ITEMS, DEFAULT_ORCHESTRATOR_PRESETS, ['gpt-oss-120b', 'gemini-3.8-flash'])
    const onSelectFamily = vi.fn()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    act(() => {
      root!.render(
        <AntiModelSelector
          families={families}
          selectedFamilyKey="gemini-4-neon"
          effort="high"
          effortOptions={[{ key: 'low', name: 'low' }, { key: 'medium', name: 'medium' }, { key: 'high', name: 'high' }]}
          isOrchestrator={false}
          onSelectFamily={onSelectFamily}
          onSelectEffort={vi.fn()}
          onOpenOrchestratorSettings={vi.fn()}
        />,
      )
    })

    const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]')!
    const pressTrigger = (key: string, opts: Partial<KeyboardEventInit> = {}) => {
      let ev!: KeyboardEvent
      act(() => {
        ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
        trigger.dispatchEvent(ev)
      })
      return ev
    }

    // Tab into high radio (index 2, after low/medium), then Shift+Tab returns to trigger
    trigger.focus()
    pressTrigger('ArrowDown')
    pressTrigger('Tab')
    const highRadio = document.body.querySelector<HTMLButtonElement>('[data-anti-effort-option="high"]')!
    expect(document.activeElement).toBe(highRadio)

    let shiftTabEv!: KeyboardEvent
    act(() => {
      shiftTabEv = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      highRadio.dispatchEvent(shiftTabEv)
    })
    expect(shiftTabEv.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(trigger)

    // Typeahead 'c' -> ArrowDown -> Space within <700ms selects navigated option instead of typing 'c '
    pressTrigger('c')
    const opusIdx = families.findIndex(f => f.key === 'claude-opus-5-5')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')[opusIdx].id,
    )
    pressTrigger('ArrowDown')
    const sonnetIdx = families.findIndex(f => f.key === 'claude-sonnet-5-5')
    expect(trigger.getAttribute('aria-activedescendant')).toBe(
      document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')[sonnetIdx].id,
    )
    pressTrigger(' ')
    expect(onSelectFamily).toHaveBeenCalledWith('claude-sonnet-5-5')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses a compact fixed trigger width across short/long labels and tailored menu width clamped to viewport', () => {
    const families = buildSelectorFamilies(SAMPLE_ITEMS, DEFAULT_ORCHESTRATOR_PRESETS)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    const origInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1280 })

    try {
      act(() => {
        root!.render(
          <AntiModelSelector
            families={families}
            selectedFamilyKey={`${ORCH_PRESET_KEY_PREFIX}preset-1`}
            effort="high"
            effortOptions={[]}
            isOrchestrator
            onSelectFamily={vi.fn()}
            onSelectEffort={vi.fn()}
          />,
        )
      })
      const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]')!
      expect(trigger.classList.contains('w-[228px]')).toBe(true)
      expect(trigger.classList.contains('max-w-full')).toBe(true)

      const bounds = vi.spyOn(trigger, 'getBoundingClientRect')
      bounds.mockReturnValue({ left: 400, top: 20, bottom: 55, width: 228 } as DOMRect)

      act(() => { trigger.click() })
      const menu = document.body.querySelector<HTMLElement>('.model-select-menu')!
      expect(menu.style.width).toBe('272px')

      // Narrow viewport clamps width to innerWidth - 16
      window.innerWidth = 260
      act(() => { window.dispatchEvent(new Event('resize')) })
      expect(menu.style.width).toBe('244px')

      act(() => { trigger.click() })
      act(() => {
        root!.render(
          <AntiModelSelector
            families={families}
            selectedFamilyKey="gemini-4-hydrogen"
            effort="xhigh"
            effortOptions={[{ key: 'low', name: 'low' }, { key: 'xhigh', name: 'xhigh' }]}
            isOrchestrator={false}
            onSelectFamily={vi.fn()}
            onSelectEffort={vi.fn()}
          />,
        )
      })
      expect(trigger.classList.contains('w-[228px]')).toBe(true)
      expect(trigger.classList.contains('max-w-full')).toBe(true)
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: origInnerWidth })
    }
  })
})
