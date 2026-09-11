// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownView } from './MarkdownView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  revealFile: vi.fn(),
  resolveFile: vi.fn(),
  clipboardWrite: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: { revealFile: mocks.revealFile, resolveFile: mocks.resolveFile },
}))

vi.mock('@/stores/toastStore', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

describe('MarkdownView responsive wrapping', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.revealFile.mockReset()
    mocks.revealFile.mockResolvedValue({ ok: true, path: '' })
    mocks.resolveFile.mockReset()
    mocks.resolveFile.mockResolvedValue({
      raw: '', resolved: null, exists: false, is_dir: false, ambiguous: false,
    })
    mocks.clipboardWrite.mockReset()
    mocks.clipboardWrite.mockResolvedValue(undefined)
    ;(navigator as unknown as { clipboard: unknown }).clipboard = {
      writeText: mocks.clipboardWrite,
    }
    // writeClipboard() falls back to execCommand outside secure contexts;
    // jsdom is not secure, so pin the secure path for the mock.
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it.each(['chat', 'plain'] as const)('allows long unbroken %s content to shrink and wrap', (mode) => {
    const detail = `_运行错误（stream_error）：${'AttributeError'.repeat(30)}_`
    act(() => root.render(<MarkdownView mode={mode}>{detail}</MarkdownView>))

    const prose = host.querySelector('.prose-chat')
    expect(prose?.classList.contains('min-w-0')).toBe(true)
    expect(prose?.classList.contains('max-w-full')).toBe(true)
    expect(prose?.classList.contains('[overflow-wrap:anywhere]')).toBe(true)
    expect(prose?.textContent).toContain('AttributeError')
  })

  it.each([
    String.raw`C:\Users\Luna\New project\final report.docx`,
    '/tmp/New project/final report.pdf',
  ])('opens a complete FILE marker path containing spaces: %s', async (path) => {
    act(() => root.render(
      <MarkdownView mode="plain">{`交付物：[FILE:${path}] 后续说明`}</MarkdownView>,
    ))

    const link = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.title === `打开文件 ${path}`)
    expect(link).not.toBeNull()
    expect(link?.textContent).toContain(path)
    expect(host.textContent).toContain('后续说明')

    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(mocks.revealFile).toHaveBeenCalledTimes(1)
    expect(mocks.revealFile).toHaveBeenCalledWith(path)
  })

  it('does not turn an empty FILE marker into a path button', () => {
    act(() => root.render(<MarkdownView mode="plain">{'[FILE:   ]'}</MarkdownView>))

    expect(host.querySelector('button[title^="打开文件"]')).toBeNull()
    expect(mocks.revealFile).not.toHaveBeenCalled()
  })

  it('offers resolve-aware actions on the path-link context menu', async () => {
    mocks.resolveFile.mockResolvedValue({
      raw: 'temp/report.md',
      resolved: 'D:/GA/temp/report.md',
      exists: true,
      is_dir: false,
      ambiguous: false,
    })
    act(() => root.render(<MarkdownView mode="plain">{'[FILE:temp/report.md]'}</MarkdownView>))
    await act(async () => { await Promise.resolve() })

    const link = host.querySelector<HTMLButtonElement>('button')
    expect(link).not.toBeNull()
    // 解析后的绝对路径进 tooltip
    expect(link?.title).toBe('D:/GA/temp/report.md')

    act(() => {
      link!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 10,
      }))
    })
    const labels = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .map((button) => button.textContent)
    expect(labels).toContain('打开文件')
    expect(labels).toContain('在资源管理器中显示')
    expect(labels).toContain('复制完整路径')
    expect(labels).toContain('复制所在文件夹')

    const copyItem = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '复制完整路径')
    await act(async () => { copyItem?.click(); await Promise.resolve() })

    expect(mocks.clipboardWrite).toHaveBeenCalledWith('D:/GA/temp/report.md')
    expect(mocks.toastSuccess).toHaveBeenCalled()
  })

  it.each(['pelican_bicycle_v2.svg', './pelican_bicycle_v2.svg', 'report.pdf?download=1', '报告.svg'])('renders bare file target %s as text without resolving or navigating', async (target) => {
    act(() => root.render(<MarkdownView mode="chat">{`[文件 **下载**](${target})`}</MarkdownView>))
    await act(async () => { await Promise.resolve() })
    expect(host.textContent).toContain('文件 下载')
    expect(host.querySelector('strong')?.textContent).toBe('下载')
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
    expect(mocks.resolveFile).not.toHaveBeenCalled()
    expect(mocks.revealFile).not.toHaveBeenCalled()
  })

  it('keeps web URLs, app routes and fragments as links', () => {
    act(() => root.render(<MarkdownView>{'[web](https://example.com/report.svg) [route](/chat) [anchor](#section) [mail](mailto:a@example.com)'}</MarkdownView>))
    expect([...host.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([
      'https://example.com/report.svg', '/chat', '#section', 'mailto:a@example.com',
    ])
  })

  it('still resolves and opens explicit FILE markers with bare filenames', async () => {
    const path = 'D:/study/GA/temp/pelican_bicycle_v2.svg'
    mocks.resolveFile.mockResolvedValue({ raw: 'pelican_bicycle_v2.svg', resolved: path, exists: true, is_dir: false, ambiguous: false })
    act(() => root.render(<MarkdownView>{'[FILE:pelican_bicycle_v2.svg]'}</MarkdownView>))
    await act(async () => { await Promise.resolve() })
    expect(mocks.resolveFile).toHaveBeenCalledWith('pelican_bicycle_v2.svg')
    expect(host.querySelector('a')).toBeNull()
    await act(async () => { host.querySelector<HTMLButtonElement>('button')!.click(); await Promise.resolve() })
    expect(mocks.revealFile).toHaveBeenCalledWith('pelican_bicycle_v2.svg')
    expect(host.querySelector('button')?.title).toBe(path)
  })

  it('disables open actions when the cited path cannot be resolved', async () => {
    mocks.resolveFile.mockResolvedValue({
      raw: 'temp/ghost.md', resolved: null, exists: false, is_dir: false, ambiguous: false,
    })
    act(() => root.render(<MarkdownView mode="plain">{'[FILE:temp/ghost.md]'}</MarkdownView>))
    await act(async () => { await Promise.resolve() })

    act(() => {
      host.querySelector<HTMLButtonElement>('button')!.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 10,
      }))
    })
    const items = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    const openItem = items.find((button) => button.textContent === '打开文件')
    const copyItem = items.find((button) => button.textContent === '复制完整路径')
    expect(openItem?.disabled).toBe(true)
    expect(copyItem?.disabled).toBe(true)
  })
})
