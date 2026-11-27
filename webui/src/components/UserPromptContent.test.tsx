// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { estimateUserPromptOverflow, UserPromptContent } from './UserPromptContent'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('UserPromptContent', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
      root = null
    }
    host?.remove()
    host = null
  })

  it('estimates overflow accurately across newline count and long wrapped paragraphs', () => {
    expect(estimateUserPromptOverflow('简短的一句提问')).toBe(false)
    expect(estimateUserPromptOverflow('1\n2\n3\n4\n5\n6')).toBe(false)
    expect(estimateUserPromptOverflow('1\n2\n3\n4\n5\n6\n7')).toBe(true)
    expect(estimateUserPromptOverflow('a'.repeat(420))).toBe(true)
    expect(estimateUserPromptOverflow('1\n2\n3\n4\n5', true)).toBe(true)
  })

  it('renders short prompts without height clamp, fade mask, or toggle button', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    act(() => {
      root!.render(<UserPromptContent content="帮我看看这个报错" />)
    })

    const box = host.querySelector<HTMLElement>('[data-user-prompt]')!
    expect(box.dataset.userPromptClamped).toBe('false')
    expect(host.querySelector('[data-user-prompt-fade]')).toBeNull()
    expect(host.querySelector('[data-user-prompt-toggle]')).toBeNull()
    expect(box.textContent).toContain('帮我看看这个报错')
  })

  it('clamps oversized prompts by default with ellipsis fade and toggles full expansion', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const longPrompt = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行超长请求内容`).join('\n')

    act(() => {
      root!.render(<UserPromptContent content={longPrompt} />)
    })

    const box = host.querySelector<HTMLElement>('[data-user-prompt]')!
    const body = host.querySelector<HTMLElement>('[data-user-prompt-body]')!
    expect(box.dataset.userPromptClamped).toBe('true')
    expect(body.style.maxHeight).toBe('168px')
    expect(body.className).toContain('overflow-hidden')
    expect(host.querySelector('[data-user-prompt-fade]')).not.toBeNull()

    const toggle = host.querySelector<HTMLButtonElement>('[data-user-prompt-toggle]')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.textContent).toContain('展开全文')

    act(() => { toggle.click() })

    expect(box.dataset.userPromptClamped).toBe('false')
    expect(body.style.maxHeight).toBe('')
    expect(host.querySelector('[data-user-prompt-fade]')).toBeNull()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.textContent).toContain('收起')

    act(() => { toggle.click() })
    expect(box.dataset.userPromptClamped).toBe('true')
    expect(body.style.maxHeight).toBe('168px')
  })
})
