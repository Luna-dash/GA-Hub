// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelFingerprint, type FingerprintJob } from './ModelFingerprint'
import { api } from '../api/client'
vi.mock('../api/client', () => ({ api: { startModelFingerprint: vi.fn(), getModelFingerprint: vi.fn() } }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const sample: FingerprintJob = { id: 'job-1', status: 'sampling', completed_samples: 0,
  target: { llm_key: 'local', model: 'test-model', api_mode: 'responses', temperature: 1, max_tokens: 8192 } }
describe('ModelFingerprint rail action', () => {
  let host: HTMLDivElement, root: Root
  const icon = () => host.querySelector('button')!
  const dialog = () => document.querySelector('[role="dialog"]')!
  async function click(button: Element) { await act(async () => { (button as HTMLButtonElement).click() }) }
  function button(text: string) { return [...dialog().querySelectorAll('button')].find(b => b.textContent?.startsWith(text))! }
  const confirm = () => button('确认并开始检测')
  async function start() { await click(icon()); await click(confirm()) }
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    vi.mocked(api.startModelFingerprint).mockResolvedValue(sample)
    vi.mocked(api.getModelFingerprint).mockResolvedValue(sample)
    act(() => root.render(<ModelFingerprint sessionId="session-A" />))
  })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
  it('opens a cost and privacy confirmation without starting any sampling', async () => {
    expect(icon().className).toContain('rounded-full')
    expect(icon().querySelectorAll('svg path').length).toBeGreaterThanOrEqual(7)
    await click(icon())
    expect(api.startModelFingerprint).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('开始检测前请确认')
    expect(dialog().textContent).toContain('API 费用')
    expect(dialog().textContent).toContain('数字样本')
    expect(dialog().textContent).toContain('关闭窗口不会取消')
    await click(button('取消'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(api.startModelFingerprint).not.toHaveBeenCalled()
    await start()
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(api.startModelFingerprint).toHaveBeenCalledWith('session-A')
    expect(dialog().textContent).toContain('采样中 · 0/3')
  })
  it('Escape dismisses confirmation without spending and restores trigger focus', async () => {
    icon().focus(); await click(icon())
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(api.startModelFingerprint).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(icon())
  })
  it('deduplicates rapid confirmation clicks while start is unresolved', async () => {
    let resolve!: (job: FingerprintJob) => void
    vi.mocked(api.startModelFingerprint).mockReturnValue(new Promise(r => { resolve = r }))
    await click(icon())
    const trigger = confirm()
    await act(async () => { trigger.click(); trigger.click() })
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    await click(button('关闭')); await click(icon())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    await act(async () => { resolve(sample) })
  })
  it('reopens active progress without another paid request', async () => {
    await start(); await click(button('关闭'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await click(icon())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(dialog().textContent).toContain('采样中 · 0/3')
    expect(button('检测进行中').disabled).toBe(true)
  })
  it('keeps results and requires confirmation again before resampling', async () => {
    vi.mocked(api.getModelFingerprint).mockResolvedValue({ ...sample, status: 'completed', completed_samples: 3,
      result: { bank_built_at: '2026-10-27', analysis: { prediction_name: 'reference-model',
        results: [{ model: 'ref', display_name: 'reference-model', probability: 0.9 }],
        diagnostics: [{ accepted: true, parsed_numbers: 304 }], evidence: { reason: '库内闭集概率' } } } })
    await start(); await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(dialog().textContent).toContain('reference-model')
    expect(dialog().textContent).toContain('非身份认证')
    await click(button('关闭')); await click(icon())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    await click(button('重新采样'))
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(dialog().textContent).toContain('开始检测前请确认')
    await click(button('取消'))
    expect(dialog().textContent).toContain('reference-model')
    await click(button('重新采样')); await click(confirm())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(2)
  })
  it('reports a start failure and retries only on explicit confirmation', async () => {
    vi.mocked(api.startModelFingerprint).mockRejectedValueOnce(new Error('绑定不可用'))
    await start()
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('绑定不可用')
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    await click(confirm())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(2)
  })
  it('does not start when the binding becomes disabled during confirmation', async () => {
    await click(icon())
    act(() => root.render(<ModelFingerprint sessionId="session-A" disabled />))
    expect(confirm().disabled).toBe(true)
    await click(confirm())
    expect(api.startModelFingerprint).not.toHaveBeenCalled()
  })
  it('does not open when the current binding is being repaired or saved', async () => {
    act(() => root.render(<ModelFingerprint sessionId="session-A" disabled />))
    await click(icon())
    expect(api.startModelFingerprint).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
