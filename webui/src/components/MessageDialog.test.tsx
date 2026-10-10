// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement | undefined
let root: Root | undefined
function render(ui: ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(ui))
}
function cleanup() { act(() => root?.unmount()); host?.remove(); root = undefined }
const screen = {
  queryByText(text: string) { return [...document.querySelectorAll('button,pre,h2,p')].find(e => e.textContent === text) ?? null },
  getByText(text: string) { const e = this.queryByText(text); if (!e) throw new Error(`Missing ${text}`); return e as HTMLElement },
  getByRole(_role: string) { return document.querySelector('input,textarea') as HTMLInputElement },
}
const fireEvent = {
  keyDown(el: Element, init: KeyboardEventInit) { act(() => {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, keyCode: init.key === 'Enter' ? 13 : 0, ...init })
    el.dispatchEvent(event)
    // jsdom does not synthesize the browser's Enter-on-button default click.
    if (!event.defaultPrevented && init.key === 'Enter' && !init.isComposing && el instanceof HTMLButtonElement) el.click()
  }) },
  click(el: HTMLElement) { act(() => { el.click() }) },
  change(el: Element, init: { target: { value: string } }) {
    act(() => {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, init.target.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  },
}
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MessageDialog } from './MessageDialog'
import { DialogHost } from './DialogHost'
import { dialog, requestDialog, useDialogStore } from '@/stores/dialogStore'
import { invoke } from '@tauri-apps/api/core'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
afterEach(() => {
  cleanup()
  useDialogStore.setState({ open: false, config: null, resolve: null, queue: [] })
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  vi.resetAllMocks()
})
describe('MessageDialog interaction', () => {
  it('danger confirmation initially focuses cancel and Enter cancels', () => {
    const result = vi.fn()
    render(<MessageDialog config={{ kind: 'confirm', title: '删除', tone: 'danger' }} onResult={result} />)
    expect(document.activeElement).toBe(screen.getByText('取消'))
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(result).toHaveBeenCalledOnce()
    expect(result).toHaveBeenCalledWith(false)
  })
  it('prompt selects its initial value, preserves empty text, settles once', () => {
    const result = vi.fn()
    render(<MessageDialog config={{ kind: 'prompt', title: '名字', defaultValue: '旧名字' }} onResult={result} />)
    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.selectionEnd).toBe(3)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByText('确认'))
    expect(result).toHaveBeenCalledOnce()
    expect(result).toHaveBeenCalledWith('')
  })
})

describe('MessageDialog keyboard and FIFO', () => {
  it('ignores IME confirmation and preserves multiline Enter', () => {
    const result = vi.fn()
    render(<MessageDialog config={{ kind: 'prompt', title: '正文', multiline: true }} onResult={result} />)
    const input = screen.getByRole('textbox')
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(result).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '甲\n乙' } })
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
    expect(result).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('确认'))
    expect(result).toHaveBeenCalledWith('甲\n乙')
  })
  it('traps Tab both directions', () => {
    render(<MessageDialog config={{ kind: 'confirm', title: '操作' }} onResult={vi.fn()} />)
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByText('取消'))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByText('确认'))
  })
  it('renders details as text, with explicit expansion', () => {
    render(<MessageDialog config={{ kind: 'alert', title: '失败', detail: '<script>bad()</script>' }} onResult={vi.fn()} />)
    expect(screen.queryByText('<script>bad()</script>')).toBeNull()
    fireEvent.click(screen.getByText('查看详情'))
    expect(screen.getByText('<script>bad()</script>').tagName).toBe('PRE')
  })
  it('queues consecutive requests without losing results or initial values', async () => {
    render(<DialogHost />)
    let first!: Promise<boolean>, second!: Promise<string | null>
    act(() => {
      first = dialog.confirm('第一条')
      second = dialog.prompt('第二条', { defaultValue: '初值' })
    })
    fireEvent.click(screen.getByText('确认'))
    await expect(first).resolves.toBe(true)
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('初值')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await expect(second).resolves.toBeNull()
    expect(useDialogStore.getState().open).toBe(false)
  })
})

describe('desktop dispatch', () => {
  it('serializes native calls until each result resolves', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    let release!: (value: boolean) => void
    vi.mocked(invoke).mockImplementationOnce(() => new Promise<boolean>(r => { release = r }) as never)
    vi.mocked(invoke).mockResolvedValueOnce('新名字')
    const first = requestDialog<boolean>({ kind: 'confirm', title: '第一个' })
    const second = requestDialog<string>({ kind: 'prompt', title: '第二个' })
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    release(true)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe('新名字')
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('falls back visibly, keeping the next native request queued until user cancels', async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(invoke).mockRejectedValueOnce(new Error('creation failed'))
    vi.mocked(invoke).mockResolvedValueOnce(null)
    render(<DialogHost />)
    let first!: Promise<boolean>, second!: Promise<null>
    await act(async () => {
      first = requestDialog<boolean>({ kind: 'confirm', title: '降级确认' })
      second = requestDialog<null>({ kind: 'alert', title: '随后消息' })
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(useDialogStore.getState().open).toBe(true))
    expect(invoke).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBeNull()
    expect(invoke).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })
})
