// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/stores/dialogStore', () => ({ requestDialog: m.request }))
import { notify, useNotifyStore } from './notify'
import { storageKeys } from '@/config/storageKeys'
describe('unified notification entry', () => {
  beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); useNotifyStore.getState().setOptIn(true); m.request.mockResolvedValue(null); vi.spyOn(document, 'hasFocus').mockReturnValue(false) })
  it('uses themed notification and opens only on confirm', async () => {
    const open = vi.fn(); m.request.mockResolvedValue(true)
    await notify('会话有新结果', { body: '状态提示', onOpen: open, force: true })
    expect(m.request).toHaveBeenCalledWith({ kind: 'notification', title: '会话有新结果', message: '状态提示', confirmText: '查看会话', cancelText: '稍后' })
    expect(open).toHaveBeenCalledOnce(); m.request.mockResolvedValue(null)
    await notify('会话有新结果', { onOpen: open, force: true }); expect(open).toHaveBeenCalledOnce()
  })
  it('persists opt-out and respects it even for tests', async () => {
    useNotifyStore.getState().setOptIn(false)
    expect(localStorage.getItem(storageKeys.desktopNotifications)).toBe('0')
    await useNotifyStore.getState().refresh(); expect(useNotifyStore.getState().optedIn).toBe(false)
    expect(await notify('测试', { force: true })).toBe(false); expect(m.request).not.toHaveBeenCalled()
  })
  it('skips foreground automatic reminders but allows test', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await notify('foreground', { tag: 'foreground' }); expect(m.request).not.toHaveBeenCalled()
    await notify('测试', { force: true }); expect(m.request).toHaveBeenCalledOnce()
  })
  it('deduplicates by event rather than globally', async () => {
    await notify('结果', { tag: 'one' }); await notify('结果', { tag: 'one' }); await notify('结果', { tag: 'two' })
    expect(m.request).toHaveBeenCalledTimes(2)
  })
})
