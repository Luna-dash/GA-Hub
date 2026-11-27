// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storageApi, type AgyGcPolicyStatus, type StorageSummary } from '@/api/client'
import { useToastStore } from '@/stores/toastStore'
import { StorageSettingsPanel } from './StorageSettingsPanel'

vi.mock('@/api/client', () => ({
  storageApi: {
    summary: vi.fn(),
    agyGcPolicy: vi.fn(),
    updateAgyGcPolicy: vi.fn(),
    cleanup: vi.fn(),
  },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeSummary(): StorageSummary {
  return {
    total_bytes: 1024,
    categories: [],
  } as unknown as StorageSummary
}

function makePolicyStatus(overrides: Partial<AgyGcPolicyStatus['policy']> = {}): AgyGcPolicyStatus {
  return {
    last_run_at: null,
    last_reclaimed_bytes: 0,
    last_removed_entries: 0,
    last_error: null,
    pending_delete_count: 0,
    policy: {
      auto_enabled: true,
      interval_hours: 12,
      l0_orphans_enabled: true,
      l0_log_retention_days: 30,
      l1_redundant_enabled: true,
      l1_grace_hours: 24,
      l1_steps_retention_days: 14,
      l1_steps_max_file_mb: 16,
      l1_scratch_retention_days: 7,
      l2_subagents_enabled: true,
      l2_killed_grace_hours: 24,
      l2_idle_retention_days: 30,
      l2_keep_artifacts: true,
      l3_cold_roots_enabled: false,
      l3_cold_root_days: 90,
      l3_run_events_retention_days: 30,
      ...overrides,
    },
  }
}

describe('StorageSettingsPanel', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    vi.mocked(storageApi.summary).mockResolvedValue(makeSummary())
    vi.mocked(storageApi.agyGcPolicy).mockResolvedValue(makePolicyStatus())
    vi.mocked(storageApi.updateAgyGcPolicy).mockImplementation(async (patch) => makePolicyStatus(patch))
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  const setInput = (el: HTMLInputElement, value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('uses .ga-input-sm instead of bg-surface, allows clear/retype without keystroke PATCH, validates bounds, and saves explicitly', async () => {
    await act(async () => {
      root.render(<StorageSettingsPanel />)
    })
    await settle()

    const togglePolicyBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('自动清理策略'))!
    act(() => togglePolicyBtn.click())

    const l0 = host.querySelector<HTMLInputElement>('input[aria-label="L0 日志保留天数"]')!
    const l1 = host.querySelector<HTMLInputElement>('input[aria-label="L1 宽限小时"]')!
    const l2 = host.querySelector<HTMLInputElement>('input[aria-label="L2 已完结子会话保留天数"]')!
    const l3 = host.querySelector<HTMLInputElement>('input[aria-label="L3 冷门主会话天数"]')!

    // Uses .ga-input-sm (not undefined bg-surface) and avoids dual-input <label> wrapper
    for (const inputEl of [l0, l1, l2, l3]) {
      expect(inputEl.className).toContain('ga-input-sm')
      expect(inputEl.className).not.toContain('bg-surface')
      expect(inputEl.closest('label')).toBeNull()
    }

    const summaryCallsBeforeEdit = vi.mocked(storageApi.summary).mock.calls.length

    // Clearing and retyping does not snap back or trigger per-keystroke PATCH / disk scan
    setInput(l0, '')
    expect(l0.value).toBe('')
    setInput(l1, '')
    expect(l1.value).toBe('')
    expect(storageApi.updateAgyGcPolicy).not.toHaveBeenCalled()
    expect(vi.mocked(storageApi.summary).mock.calls.length).toBe(summaryCallsBeforeEdit)

    // Out-of-bounds values trigger inline role="alert" validation and focus first invalid field
    setInput(l0, '0')
    setInput(l1, '721')
    setInput(l2, '366')
    setInput(l3, '6')

    const saveBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('保存策略'))!
    await act(async () => { saveBtn.click() })

    expect(storageApi.updateAgyGcPolicy).not.toHaveBeenCalled()
    expect(l0.getAttribute('aria-invalid')).toBe('true')
    expect(l1.getAttribute('aria-invalid')).toBe('true')
    expect(l2.getAttribute('aria-invalid')).toBe('true')
    expect(l3.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(l0)
    expect(host.querySelectorAll('[role="alert"]').length).toBe(4)

    // Valid integers clear errors and save once on explicit button click
    setInput(l0, '14')
    setInput(l1, '12')
    setInput(l2, '45')
    setInput(l3, '180')
    expect(l0.getAttribute('aria-invalid')).toBeNull()

    await act(async () => { saveBtn.click(); await Promise.resolve() })
    await settle()

    expect(storageApi.updateAgyGcPolicy).toHaveBeenCalledTimes(1)
    expect(storageApi.updateAgyGcPolicy).toHaveBeenCalledWith({
      l0_log_retention_days: 14,
      l1_grace_hours: 12,
      l2_idle_retention_days: 45,
      l3_cold_root_days: 180,
    })
    expect(vi.mocked(storageApi.summary).mock.calls.length).toBe(summaryCallsBeforeEdit + 1)
    expect(useToastStore.getState().items.some(t => t.kind === 'success' && t.message === '已保存自动清理策略')).toBe(true)
  })
})
