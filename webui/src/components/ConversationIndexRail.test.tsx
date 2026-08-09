// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationIndexRail } from './ConversationIndexRail'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ConversationIndexRail', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('collapses the index and persists the preference', () => {
    act(() => root.render(
      <ConversationIndexRail><div>历史会话一</div></ConversationIndexRail>,
    ))

    const toggle = host.querySelector('[aria-label="折叠历史对话索引"]') as HTMLButtonElement
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('[aria-label="历史对话索引"]')?.getAttribute('aria-hidden')).toBe('false')

    act(() => toggle.click())

    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')
    expect(host.querySelector('[aria-label="展开历史对话索引"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="历史对话索引"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(localStorage.getItem('gahub.conversationIndexCollapsed')).toBe('true')
  })

  it('restores a persisted collapsed preference', () => {
    localStorage.setItem('gahub.conversationIndexCollapsed', 'true')

    act(() => root.render(
      <ConversationIndexRail><div>历史会话一</div></ConversationIndexRail>,
    ))

    expect(host.querySelector('[data-collapsed]')?.getAttribute('data-collapsed')).toBe('true')
    expect(host.querySelector('[aria-label="展开历史对话索引"]')?.getAttribute('aria-expanded')).toBe('false')
  })
})
