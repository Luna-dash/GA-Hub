// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MarkdownView } from './MarkdownView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  revealFile: vi.fn(),
}))

vi.mock('@/api/client', () => ({
  api: { revealFile: mocks.revealFile },
}))

describe('MarkdownView responsive wrapping', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    mocks.revealFile.mockReset()
    mocks.revealFile.mockResolvedValue({ ok: true, path: '' })
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
})
