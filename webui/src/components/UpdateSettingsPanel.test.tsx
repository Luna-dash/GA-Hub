// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateSettingsPanel } from './UpdateSettingsPanel'
import { updateApi } from '@/api/client'

vi.mock('@/api/client', () => ({
  updateApi: {
    status: vi.fn(),
    release: vi.fn(),
    download: vi.fn(),
    prepare: vi.fn(),
    apply: vi.fn(),
    cancel: vi.fn(),
  },
}))

const idle = { supported: true, data_epoch: 2, sources: ['github_release', 'trusted_local_archive'], plan: { state: 'idle' } }
let host: HTMLDivElement
let root: Root

function button(text: string): HTMLButtonElement {
  return Array.from(host.querySelectorAll('button')).find(node => node.textContent?.includes(text)) as HTMLButtonElement
}

async function enter(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateApi.status).mockResolvedValue(idle)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('UpdateSettingsPanel', () => {
  it('checks official releases, downloads in background, and switches in one click', async () => {
    const release = { repository: 'Luna-dash/GA-Hub', current_version: '1.1.0', version: '1.2.0', tag: 'v1.2.0', available: true, name: 'GA-Hub-1.2.0-windows-x64.zip', size: 10, notes: 'Fixed bugs', url: '' }
    vi.mocked(updateApi.release).mockResolvedValue(release)
    vi.mocked(updateApi.download).mockResolvedValue({ phase: 'downloading', received_bytes: 0, total_bytes: 10, release })
    vi.mocked(updateApi.status)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce({ ...idle, release, plan: { id: 'p', state: 'prepared', version: '1.2.0' } })
      .mockResolvedValueOnce({ ...idle, release, plan: { id: 'p', state: 'switching', version: '1.2.0' } })
    vi.mocked(updateApi.apply).mockResolvedValue({ id: 'p', state: 'switching', version: '1.2.0' })

    await act(async () => root.render(<UpdateSettingsPanel />))
    await act(async () => button('检查正式版本').click())
    expect(host.textContent).toContain('Fixed bugs')
    await act(async () => button('下载、校验并准备更新').click())
    expect(updateApi.download).toHaveBeenCalledTimes(1)

    await act(async () => button('立即重启并更新').click())
    expect(updateApi.apply).toHaveBeenCalledWith('p')
    expect(host.textContent).toContain('正在重启并切换至新版本')
  })

  it('validates optional local archive SHA-256 and requires trust checkbox', async () => {
    await act(async () => root.render(<UpdateSettingsPanel />))
    const inputs = host.querySelectorAll('input')
    await enter(inputs[0], 'D:\\release.zip')
    await act(async () => inputs[2].click())
    await enter(inputs[1], 'bad')
    expect(button('校验并准备').disabled).toBe(true)
    await enter(inputs[1], 'a'.repeat(64))
    expect(button('校验并准备').disabled).toBe(false)
  })

  it('clears a submitted local package and lets the user replace the prepared candidate', async () => {
    const oldPlan = { id: 'old', state: 'prepared', version: '1.3.0' }
    const newPlan = { id: 'new', state: 'prepared', version: '1.3.1' }
    vi.mocked(updateApi.prepare).mockResolvedValueOnce(oldPlan).mockResolvedValueOnce(newPlan)
    vi.mocked(updateApi.cancel).mockResolvedValue({ id: 'old', state: 'cancelled' })
    vi.mocked(updateApi.status)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce({ ...idle, plan: oldPlan })
      .mockResolvedValueOnce({ ...idle, plan: { id: 'old', state: 'cancelled' } })
      .mockResolvedValueOnce({ ...idle, plan: newPlan })

    await act(async () => root.render(<UpdateSettingsPanel />))
    const [archive, sha256, trusted] = host.querySelectorAll('input')
    await enter(archive, 'D:\\old.zip')
    await enter(sha256, 'a'.repeat(64))
    await act(async () => trusted.click())
    await act(async () => button('校验并准备').click())
    expect(updateApi.prepare).toHaveBeenCalledWith('D:\\old.zip', 'a'.repeat(64), true)
    expect(archive.value).toBe('')
    expect(sha256.value).toBe('')
    expect(trusted.checked).toBe(false)
    expect(button('校验并准备').disabled).toBe(true)

    await act(async () => button('取消旧候选并更换本地包').click())
    expect(updateApi.cancel).toHaveBeenCalledWith('old')
    expect(updateApi.apply).not.toHaveBeenCalled()
    expect(archive.disabled).toBe(false)
    await enter(archive, 'D:\\new.zip')
    await act(async () => trusted.click())
    await act(async () => button('校验并准备').click())
    expect(updateApi.prepare).toHaveBeenLastCalledWith('D:\\new.zip', '', true)
    expect(host.textContent).toContain('候选包已就绪 · 1.3.1')
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

  it('allows clearing a pre-switch failed update plan', async () => {
    vi.mocked(updateApi.status).mockResolvedValue({
      ...idle,
      plan: { state: 'failed', id: 'f01', switch_started: false, error: 'old desktop did not exit within 15s' },
    })
    await act(async () => root.render(<UpdateSettingsPanel />))
    vi.mocked(updateApi.cancel).mockResolvedValue({ state: 'cancelled', id: 'f01' })
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'cancelled', id: 'f01' } })
    await act(async () => button('清除失败状态').click())
    expect(updateApi.cancel).toHaveBeenCalledWith('f01')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('已取消')
  })

  it('restores real byte progress after leaving and returning to the panel', async () => {
    vi.useFakeTimers()
    const release = { repository: 'Luna-dash/GA-Hub', current_version: '1.1.0', version: '1.2.0', tag: 'v1.2.0', available: true, name: 'test.zip', size: 10485760, notes: '', url: '' }
    const snapshot = {
      ...idle,
      release,
      download: { phase: 'downloading', received_bytes: 5242880, total_bytes: 10485760 },
    }
    vi.mocked(updateApi.status).mockResolvedValue(snapshot)
    try {
      await act(async () => root.render(<UpdateSettingsPanel />))
      expect(host.textContent).toContain('5.0 MB / 10.0 MB · 50%')
      await act(async () => root.render(<UpdateSettingsPanel active={false} />))
      const callsAfterHide = vi.mocked(updateApi.status).mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
      expect(vi.mocked(updateApi.status).mock.calls.length).toBe(callsAfterHide)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces errors with readable theme colors', async () => {
    vi.mocked(updateApi.status).mockResolvedValue({ ...idle, plan: { state: 'prepared', id: 'abc' } })
    vi.mocked(updateApi.apply).mockRejectedValue(new Error('Network error'))
    await act(async () => root.render(<UpdateSettingsPanel />))
    await act(async () => button('立即重启并更新').click())
    expect(host.querySelector('[role="alert"]')?.classList.contains('text-status-danger')).toBe(true)
  })
})
