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
  function close() { return [...dialog().querySelectorAll('button')].find(b => b.textContent?.startsWith('关闭'))! }
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks()
    host = document.createElement('div'); document.body.append(host); root = createRoot(host)
    vi.mocked(api.startModelFingerprint).mockResolvedValue(sample)
    vi.mocked(api.getModelFingerprint).mockResolvedValue(sample)
    act(() => root.render(<ModelFingerprint sessionId="session-A" />))
  })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })
  it('uses a round fingerprint SVG and starts sampling with one click for the bound session', async () => {
    expect(icon().className).toContain('rounded-full')
    expect(icon().querySelector('svg path')).toBeTruthy()
    expect(icon().title).toContain('消耗 API 额度')
    await click(icon())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(api.startModelFingerprint).toHaveBeenCalledWith('session-A')
    expect(dialog().textContent).toContain('采样中 · 0/3')
    expect(icon().getAttribute('aria-label')).toContain('查看检测进度')
  })
  it('deduplicates rapid clicks while start is unresolved', async () => {
    let resolve!: (job: FingerprintJob) => void
    vi.mocked(api.startModelFingerprint).mockReturnValue(new Promise(r => { resolve = r }))
    await act(async () => { icon().click(); icon().click() })
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(close().textContent).toContain('后台继续')
    await act(async () => resolve(sample))
  })
  it('keeps polling when closed and reopens without a second paid job', async () => {
    await click(icon()); await click(close())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.getModelFingerprint).toHaveBeenCalledWith('session-A', 'job-1')
    await click(icon())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(dialog().textContent).toContain('采样中')
  })
  it('shows completed results without resampling when the icon is clicked again', async () => {
    vi.mocked(api.getModelFingerprint).mockResolvedValue({ ...sample, status: 'completed', completed_samples: 3,
      result: { bank_built_at: '2026-10-27', analysis: { prediction_name: 'reference-model',
        results: [{ model: 'ref', display_name: 'reference-model', probability: 0.9 }],
        diagnostics: [{ accepted: true, parsed_numbers: 304 }], evidence: { reason: '库内闭集概率' } } } })
    await click(icon()); await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(dialog().textContent).toContain('reference-model')
    expect(dialog().textContent).toContain('非身份认证')
    await click(close()); await click(icon())
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(1)
    expect(icon().getAttribute('aria-label')).toContain('查看检测结果')
  })
  it('reports a start failure and allows an explicit retry', async () => {
    vi.mocked(api.startModelFingerprint).mockRejectedValueOnce(new Error('绑定不可用'))
    await click(icon())
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe('绑定不可用')
    await click([...dialog().querySelectorAll('button')].find(b => b.textContent?.includes('采样'))!)
    expect(api.startModelFingerprint).toHaveBeenCalledTimes(2)
  })
  it('does not start when the current binding is being repaired or saved', async () => {
    act(() => root.render(<ModelFingerprint sessionId="session-A" disabled />))
    await click(icon())
    expect(api.startModelFingerprint).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
