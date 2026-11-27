// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovaSettingsPanel } from './NovaSettingsPanel'
import { novaApi } from '@/api/client'

vi.mock('@/api/client', () => ({ novaApi: { status: vi.fn(), action: vi.fn() } }))

let host: HTMLDivElement
let root: Root
const status = { device: 'd'.repeat(24), paired: false, running: false, connected: false, paused: false }
const button = (label: string) => Array.from(host.querySelectorAll('button')).find(b => b.textContent === label) ?? (() => { throw new Error(host.innerHTML) })()
async function input(selector: string, value: string) {
  const el = host.querySelector<HTMLInputElement>(selector)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
beforeEach(async () => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.resetAllMocks()
  vi.mocked(novaApi.status).mockResolvedValue(status)
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })

describe('Nova embedded settings', () => {
  it('keeps the introduction concise and moves secondary guidance into collapsed details', async () => {
    await act(async () => root.render(<NovaSettingsPanel />))
    expect(host.querySelector('header p')?.textContent).toBe('关联账号后，即可通过 Nova 远程访问这台电脑。')
    const details = host.querySelector('details')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toBe('连接与安全说明')
    expect(details.textContent).toContain('Windows 凭据管理器')
    expect(details.textContent).toContain('自动启动')
    expect(host.querySelector('code')?.className).toContain('break-all')
    expect(host.querySelector('form .grid')?.className).toContain('sm:grid-cols-2')
  })

  it('keeps cloud availability distinct from the local connector state', async () => {
    vi.mocked(novaApi.status).mockResolvedValue({ ...status, paired: true, running: true })
    await act(async () => root.render(<NovaSettingsPanel />))
    expect(host.textContent).toContain('连接器运行中')
    expect(host.querySelector('form')).toBeNull()
  })

  it('shows cloud connection status, RTT, device name, error detail and pause/resume controls', async () => {
    const connected = { ...status, paired: true, running: true, connected: true, rtt_ms: 42, device_name: 'Office PC' }
    vi.mocked(novaApi.status).mockResolvedValue(connected)
    vi.mocked(novaApi.action).mockResolvedValue({ ...connected, running: false, connected: false, paused: true })
    await act(async () => root.render(<NovaSettingsPanel />))
    expect(host.textContent).toContain('连接器运行中 · 已连接云端 · 42ms')
    expect(host.textContent).toContain('(Office PC)')
    await act(async () => button('暂停连接').click())
    expect(novaApi.action).toHaveBeenCalledWith('pause', undefined)
    expect(host.textContent).toContain('连接器已暂停')
    vi.mocked(novaApi.action).mockResolvedValue({ ...connected, error: 'ConnectorAuthError', error_detail: '设备已撤销或凭证无效' })
    await act(async () => button('恢复连接').click())
    expect(novaApi.action).toHaveBeenCalledWith('resume', undefined)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('设备已撤销或凭证无效')
  })

  it('requires explicit confirmation and current credentials when revoking', async () => {
    vi.mocked(novaApi.status).mockResolvedValue({ ...status, paired: true, running: true })
    vi.mocked(novaApi.action).mockResolvedValue(status)
    await act(async () => root.render(<NovaSettingsPanel />))
    await act(async () => button('撤销账号关联').click())
    expect(host.textContent).toContain('撤销后将无法通过该账号远程访问本机')
    expect(button('确认撤销关联').disabled).toBe(true)
    expect(host.querySelector('[autocomplete="current-password"]')).not.toBeNull()
    await input('[autocomplete="username"]', 'test-user')
    await input('[type="password"]', 'test-password-long')
    await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(novaApi.action).toHaveBeenCalledWith('revoke', expect.objectContaining({ username: 'test-user', password: 'test-password-long', confirm: true }))
    expect(host.querySelector<HTMLInputElement>('[type="password"]')!.value).toBe('')
  })

  it('requires authorization then associates in place and clears secrets', async () => {
    vi.mocked(novaApi.action).mockResolvedValue({ ...status, paired: true, running: true })
    await act(async () => root.render(<NovaSettingsPanel />))
    expect(host.textContent).toContain(status.device)
    expect(button('登录并关联本机').disabled).toBe(true)
    await input('[autocomplete="username"]', 'test-user')
    await input('[type="password"]', 'test-password-long')
    await act(async () => Array.from(host.querySelectorAll<HTMLInputElement>('[type="checkbox"]')).at(-1)!.click())
    expect(button('登录并关联本机').disabled).toBe(false)
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(novaApi.action).toHaveBeenCalledWith('associate', expect.objectContaining({ username: 'test-user', password: 'test-password-long', confirm: true }))
    expect(host.textContent).toContain('已关联账号')
    expect(host.querySelector('form')).toBeNull()
    expect(host.querySelector('a')).toBeNull()
    await act(async () => button('撤销账号关联').click())
    expect(host.querySelector<HTMLInputElement>('[type="password"]')!.value).toBe('')
    expect(button('确认撤销关联').disabled).toBe(true)
  })

  it('supports invited registration and clears secrets after failure', async () => {
    vi.mocked(novaApi.action).mockRejectedValue(new Error('登录失败'))
    await act(async () => root.render(<NovaSettingsPanel />))
    await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click())
    await input('[autocomplete="username"]', 'new-user')
    await input('[type="password"]', 'test-password-long')
    await input('[type="password"]:not([autocomplete])', 'test-invite')
    await act(async () => Array.from(host.querySelectorAll<HTMLInputElement>('[type="checkbox"]')).at(-1)!.click())
    await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(novaApi.action).toHaveBeenCalledWith('associate', expect.objectContaining({ invite: 'test-invite' }))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('登录失败')
    expect(host.querySelector<HTMLInputElement>('[type="password"]')!.value).toBe('')
    expect(host.querySelector<HTMLInputElement>('[type="password"]:not([autocomplete])')!.value).toBe('')
  })

  it('preserves existing binding and reconnects without account password', async () => {
    const paired = { ...status, paired: true, running: true }
    vi.mocked(novaApi.status).mockResolvedValue(paired)
    vi.mocked(novaApi.action).mockResolvedValue(paired)
    await act(async () => root.render(<NovaSettingsPanel />))
    expect(host.querySelector('form')).toBeNull()
    await act(async () => button('重新连接').click())
    expect(novaApi.action).toHaveBeenCalledWith('reconnect', undefined)
  })

  it('renders collapsed connector diagnostics when available', async () => {
    vi.mocked(novaApi.status).mockResolvedValue({
      ...status,
      paired: true,
      running: true,
      connected: true,
      connector_version: '2.2.0',
      diagnostics: {
        protocol: 2,
        capabilities: ['binary', 'resumable_upload'],
        credential_backend: 'windows_credman',
        active_http: 1,
        active_ws: 2,
        reconnect_count: 3,
        bytes_in: 2048,
        bytes_out: 4096,
        events: [{ ts: 1700000000, level: 'info', event: 'hello', detail: 'protocol=v2' }],
      },
    })
    await act(async () => root.render(<NovaSettingsPanel />))
    const allDetails = Array.from(host.querySelectorAll('details'))
    expect(allDetails).toHaveLength(2)
    expect(allDetails[1].querySelector('summary')?.textContent).toBe('链路诊断')
    expect(allDetails[1].textContent).toContain('协议：v2')
    expect(allDetails[1].textContent).toContain('windows_credman')
    expect(allDetails[1].textContent).toContain('resumable_upload')
    expect(allDetails[1].textContent).toContain('protocol=v2')
  })
})
