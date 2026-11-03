// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NovaSettingsPanel } from './NovaSettingsPanel'
import { novaApi } from '@/api/client'

vi.mock('@/api/client', () => ({ novaApi: { status: vi.fn(), action: vi.fn() } }))

let host: HTMLDivElement
let root: Root
const status = { device: 'd'.repeat(24), paired: false, running: false }
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
})
