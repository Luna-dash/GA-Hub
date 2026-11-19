// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateSettingsPanel } from './UpdateSettingsPanel'
import { updateApi } from '@/api/client'

vi.mock('@/api/client', () => ({ updateApi: { status: vi.fn(), release: vi.fn(), download: vi.fn(), prepare: vi.fn(), cancel: vi.fn(), preflight: vi.fn(), request: vi.fn(), approve: vi.fn() } }))
let host: HTMLDivElement
let root: Root
const idle = { plan: { state: 'idle' }, supported: true, sources: ['trusted_local_archive'], data_epoch: 1 }
beforeEach(() => {
  vi.resetAllMocks()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host)
  vi.mocked(updateApi.status).mockResolvedValue(idle)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
function button(text: string) {
  return Array.from(host.querySelectorAll('button')).find(node => node.textContent === text)!
}
async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
describe('UpdateSettingsPanel', () => {
  it('requires a trusted source and path and validates a supplied checksum; never exposes restart', async () => {
    await act(async () => root.render(<UpdateSettingsPanel />))
    expect(button('校验并准备').disabled).toBe(true)
    const inputs = host.querySelectorAll('input')
    await enter(inputs[0], ' D:\\release.zip ')
    await enter(inputs[1], 'a'.repeat(64))
    expect(button('校验并准备').disabled).toBe(true)
    await act(async () => inputs[2].click())
    expect(button('校验并准备').disabled).toBe(false)
    vi.mocked(updateApi.prepare).mockResolvedValue({ state: 'prepared', id: 'abc' })
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'prepared', id: 'abc' } })
    await act(async () => button('校验并准备').click())
    expect(updateApi.prepare).toHaveBeenCalledWith('D:\\release.zip', 'a'.repeat(64), true)
    expect(button('取消候选更新')).toBeTruthy()
    expect(host.textContent).toContain('倒计时 60 秒')
    expect(button('唤醒独立执行器')).toBeTruthy()
  })
  it.each(['', '   '])('allows a blank checksum (%j) but still requires trust and path', async checksum => {
    await act(async () => root.render(<UpdateSettingsPanel />))
    const inputs = host.querySelectorAll('input')
    await enter(inputs[0], ' D:\\release.zip ')
    await enter(inputs[1], checksum)
    expect(button('校验并准备').disabled).toBe(true)
    await act(async () => inputs[2].click())
    expect(button('校验并准备').disabled).toBe(false)
    expect(host.textContent).toContain('SHA-256（选填）')
    await act(async () => button('校验并准备').click())
    expect(updateApi.prepare).toHaveBeenCalledWith('D:\\release.zip', '', true)
  })
  it('rejects an incomplete checksum when supplied', async () => {
    await act(async () => root.render(<UpdateSettingsPanel />))
    const inputs = host.querySelectorAll('input')
    await enter(inputs[0], 'D:\\release.zip')
    await act(async () => inputs[2].click())
    await enter(inputs[1], 'bad')
    expect(button('校验并准备').disabled).toBe(true)
    await enter(inputs[1], 'a'.repeat(64))
    expect(button('校验并准备').disabled).toBe(false)
  })
  it('uses readable theme colors for guidance, handoff status and errors', async () => {
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'prepared', id: 'abc' }, handoff: { id: 'abc', state: 'ready' } })
    await act(async () => root.render(<UpdateSettingsPanel />))
    expect(host.querySelector('[class*="text-amber-"]')).toBeNull()
    expect(host.querySelector('[class*="text-slate-"]')).toBeNull()
    for (const text of ['先在线准备更新包', '更新包已就绪', '交接：已就绪，等待确认']) {
      const element = Array.from(host.querySelectorAll('p, div')).find(node => node.textContent?.startsWith(text))
      expect(element?.classList.contains('text-ink')).toBe(true)
    }
    vi.mocked(updateApi.cancel).mockRejectedValue(new Error('Network error'))
    await act(async () => button('取消候选更新').click())
    expect(host.querySelector('[role="alert"]')?.classList.contains('text-status-danger')).toBe(true)
  })
  it('cancels only the displayed plan', async () => {
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'prepared', id: 'abc' } })
    await act(async () => root.render(<UpdateSettingsPanel />))
    vi.mocked(updateApi.cancel).mockResolvedValue({ state: 'cancelled', id: 'abc' })
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'cancelled' } })
    await act(async () => button('取消候选更新').click())
    expect(updateApi.cancel).toHaveBeenCalledWith('abc')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已取消')
  })
  it('requires a separate approval after the executor becomes ready', async () => {
    vi.mocked(updateApi.status).mockResolvedValueOnce({ ...idle, plan: { id: 'p', state: 'prepared' } })
      .mockResolvedValueOnce({ ...idle, plan: { id: 'p', state: 'armed' }, handoff: { id: 'p', state: 'ready' } })
      .mockResolvedValueOnce({ ...idle, plan: { id: 'p', state: 'armed' }, handoff: { id: 'p', state: 'countdown' } })
    await act(async () => root.render(<UpdateSettingsPanel />))
    await act(async () => button('唤醒独立执行器').click())
    expect(updateApi.preflight).toHaveBeenCalledWith('p')
    expect(updateApi.request).toHaveBeenCalledWith('p')
    expect(updateApi.approve).not.toHaveBeenCalled()
    await act(async () => button('确认切换（60秒后关闭）').click())
    expect(updateApi.approve).toHaveBeenCalledWith('p')
    expect(host.textContent).toContain('当前轮次可能中断')
  })
  it('never requests shutdown when preflight fails', async () => {
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { id: 'p', state: 'prepared' } })
    vi.mocked(updateApi.preflight).mockRejectedValueOnce(new Error('Candidate selftest failed'))
    await act(async () => root.render(<UpdateSettingsPanel />))
    await act(async () => button('唤醒独立执行器').click())
    expect(updateApi.request).not.toHaveBeenCalled()
    expect(updateApi.approve).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Candidate selftest failed')
  })

  it('restores real byte progress after leaving and returning to the panel', async () => {
    vi.useFakeTimers()
    const release = { repository: 'Luna-dash/GA-Hub', current_version: '1.1.0', version: '1.2.0', tag: 'v1.2.0', available: true, name: 'test.zip', size: 10485760, notes: '', url: '' }
    const snapshot = { supported: true, data_epoch: 1, sources: [], plan: { state: 'idle' }, release,
      download: { phase: 'downloading', received_bytes: 5242880, total_bytes: 10485760 } }
    vi.mocked(updateApi.status).mockResolvedValue(snapshot)
    try {
      await act(async () => root.render(<UpdateSettingsPanel />))
      expect(host.querySelector('progress')?.value).toBe(50)
      expect(host.textContent).toContain('5.0 MB / 10.0 MB · 50%')
      expect(button('正在后台下载并准备…').disabled).toBe(true)
      await act(async () => root.unmount())
      root = createRoot(host)
      vi.mocked(updateApi.status).mockResolvedValue({ ...snapshot, download: { ...snapshot.download, received_bytes: 8388608 } })
      await act(async () => root.render(<UpdateSettingsPanel />))
      expect(host.querySelector('progress')?.value).toBe(80)
      expect(host.textContent).toContain('最新 1.2.0')
      vi.mocked(updateApi.status).mockResolvedValue({ ...snapshot, plan: { state: 'prepared', id: 'abc', version: '1.2.0' }, download: { ...snapshot.download, phase: 'succeeded' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(host.textContent).toContain('下载完成，候选包已准备')
      expect(button('此版本已准备完成').disabled).toBe(true)
    } finally { vi.useRealTimers() }
  })
  it('shows friendly lock errors with raw JSON hidden in technical details', async () => {
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'prepared', id: 'abc' } })
    vi.mocked(updateApi.cancel).mockRejectedValue(new Error('{"detail":"Updater lock busy: C:/updates/download.lock"}'))
    await act(async () => root.render(<UpdateSettingsPanel />))
    await act(async () => button('取消候选更新').click())
    const alert = host.querySelector('[role="alert"]')!
    expect(alert.querySelector('p')?.textContent).toContain('另一个更新操作正在进行')
    expect(alert.querySelector('details')?.open).toBe(false)
    expect(alert.querySelector('pre')?.textContent).toContain('Updater lock busy')
  })
  it('keeps the last known progress on connection loss and recovers automatically', async () => {
    vi.useFakeTimers()
    vi.mocked(updateApi.status).mockResolvedValue({ supported: true, data_epoch: 1, sources: [], plan: { state: 'idle' },
      download: { phase: 'downloading', received_bytes: 50, total_bytes: 100 } })
    try {
      await act(async () => root.render(<UpdateSettingsPanel />))
      vi.mocked(updateApi.status).mockRejectedValue(new Error('Network error'))
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(host.textContent).toContain('正在自动重连')
      expect(host.querySelector('progress')?.value).toBe(50)
      vi.mocked(updateApi.status).mockResolvedValue({ supported: true, data_epoch: 1, sources: [], plan: { state: 'idle' }, download: {
        phase: 'interrupted', received_bytes: 50, total_bytes: 100, error: { message: '上次下载已中断，可重新下载', detail: 'Worker stopped' } } })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(host.textContent).not.toContain('正在自动重连')
      expect(host.querySelector('[role="alert"] p')?.textContent).toContain('上次下载已中断')
      expect(button('重新下载并校验').disabled).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('keeps preparation disabled when the running backend lacks the API', async () => {
    vi.mocked(updateApi.status).mockRejectedValue(new Error('404'))
    await act(async () => root.render(<UpdateSettingsPanel />))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('尚未提供更新接口')
    expect(button('校验并准备').disabled).toBe(true)
  })
})
