import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopChrome } from './DesktopChrome'

const native = vi.hoisted(() => ({
  isMaximized: vi.fn(), onResized: vi.fn(), onFocusChanged: vi.fn(),
  toggleMaximize: vi.fn(), startDragging: vi.fn(), minimize: vi.fn(), close: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => native }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('DesktopChrome', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    native.isMaximized.mockResolvedValue(false)
    native.onResized.mockResolvedValue(vi.fn())
    native.onFocusChanged.mockResolvedValue(vi.fn())
    for (const action of [native.toggleMaximize, native.startDragging, native.minimize, native.close]) action.mockResolvedValue(undefined)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    delete window.__TAURI_INTERNALS__
    vi.clearAllMocks()
  })
  async function renderDesktop() {
    window.__TAURI_INTERNALS__ = {}
    await act(async () => root.render(<DesktopChrome><div className="h-screen">页面内容</div></DesktopChrome>))
  }
  async function click(label: string) {
    const button = host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => button.click())
  }
  it('leaves the browser layout untouched', () => {
    act(() => root.render(<DesktopChrome><div>网页内容</div></DesktopChrome>))
    expect(host.textContent).toBe('网页内容')
    expect(host.querySelector('.ga-desktop-frame')).toBeNull()
    expect(native.isMaximized).not.toHaveBeenCalled()
  })
  it('provides native minimize, maximize, restore and close without repeating branding', async () => {
    await renderDesktop()
    expect(host.querySelector('.ga-desktop-titlebar')?.textContent).toBe('')
    await click('最小化')
    expect(native.minimize).toHaveBeenCalledOnce()
    native.isMaximized.mockResolvedValue(true)
    await click('最大化')
    expect(native.toggleMaximize).toHaveBeenCalledOnce()
    expect(host.querySelector('button[aria-label="还原"]')).not.toBeNull()
    native.isMaximized.mockResolvedValue(false)
    await click('还原')
    expect(host.querySelector('button[aria-label="最大化"]')).not.toBeNull()
    await click('关闭窗口')
    expect(native.close).toHaveBeenCalledOnce()
  })
  it('drags with the left button, double-clicks to maximize and ignores right-clicks', async () => {
    await renderDesktop()
    const drag = host.querySelector('.ga-desktop-drag')!
    await act(async () => { drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 1 })) })
    expect(native.startDragging).toHaveBeenCalledOnce()
    await act(async () => { drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail: 2 })) })
    expect(native.toggleMaximize).toHaveBeenCalledOnce()
    await act(async () => { drag.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, detail: 1 })) })
    expect(native.startDragging).toHaveBeenCalledOnce()
    await click('最小化')
    expect(native.startDragging).toHaveBeenCalledOnce()
  })
  it('drags integrated headers and sidebar branding but leaves interactive children usable', async () => {
    window.__TAURI_INTERNALS__ = {}
    await act(async () => root.render(<DesktopChrome>
      <header className="ga-page-header"><span>标题</span><button>操作</button><input /><div role="combobox">选择</div><div data-no-window-drag>自定义操作</div></header>
      <div className="ga-sidebar-brand-row"><span>品牌</span></div>
      <div role="dialog"><header className="ga-page-header">弹窗标题</header></div>
    </DesktopChrome>))
    const down = async (selector: string, detail = 1) => {
      await act(async () => { host.querySelector(selector)!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, detail })) })
    }
    await down('.ga-page-header > span')
    await down('.ga-sidebar-brand-row span')
    expect(native.startDragging).toHaveBeenCalledTimes(2)
    await down('.ga-page-header > span', 2)
    expect(native.toggleMaximize).toHaveBeenCalledOnce()
    for (const selector of ['.ga-page-header button', 'input', '[role="combobox"]', '[data-no-window-drag]', '[role="dialog"] header']) await down(selector)
    expect(native.startDragging).toHaveBeenCalledTimes(2)
  })
  it('follows native resize events and removes subscriptions on unmount', async () => {
    const stopResize = vi.fn(), stopFocus = vi.fn()
    native.onResized.mockResolvedValue(stopResize)
    native.onFocusChanged.mockResolvedValue(stopFocus)
    await renderDesktop()
    native.isMaximized.mockResolvedValue(true)
    await act(async () => native.onResized.mock.calls[0][0]())
    expect(host.querySelector('button[aria-label="还原"]')).not.toBeNull()
    act(() => root.render(<div />))
    expect(stopResize).toHaveBeenCalledOnce()
    expect(stopFocus).toHaveBeenCalledOnce()
  })
  it('keeps controls outside the runtime content and reports native operation failures', async () => {
    await renderDesktop()
    expect(host.querySelector('.ga-desktop-content .ga-desktop-controls')).toBeNull()
    native.minimize.mockRejectedValueOnce(new Error('permission denied'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await click('最小化')
    expect(host.querySelector('[role="status"]')?.textContent).toContain('窗口操作失败')
    await click('最小化')
    expect(host.querySelector('[role="status"]')).toBeNull()
  })
})
