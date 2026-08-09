// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MarkdownView } from './MarkdownView'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MarkdownView responsive wrapping', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
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
})
