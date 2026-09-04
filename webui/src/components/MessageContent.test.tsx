// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MessageContent } from './MessageContent'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('MessageContent format selection', () => {
  let host: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
  })

  function render(ui: ReactNode) {
    act(() => root?.render(ui))
  }

  it('renders literal pre-wrapped text without markdown parsing', () => {
    render(<MessageContent content={'# not a heading\n**raw**'} format="text" />)
    const body = host.firstElementChild as HTMLElement
    expect(body.className).toContain('whitespace-pre-wrap')
    expect(body.textContent).toBe('# not a heading\n**raw**')
    expect(body.querySelector('h1')).toBeNull()
  })

  it('renders markdown with an explicit mode', () => {
    render(<MessageContent content={'# 标题'} format="markdown" markdownMode="plain" cache={false} />)
    expect(host.querySelector('h1')?.textContent).toBe('标题')
  })

  it('renders literal preformatted output that survives markdown-looking text', () => {
    render(
      <MessageContent
        content={'| a | b |\n|---|---|'}
        format="pre"
        className="leading-6 font-sans"
      />,
    )
    const pre = host.querySelector('pre')
    expect(pre).not.toBeNull()
    expect(pre?.className).toContain('font-sans')
    expect(pre?.querySelector('table')).toBeNull()
    expect(pre?.textContent).toBe('| a | b |\n|---|---|')
  })
})
