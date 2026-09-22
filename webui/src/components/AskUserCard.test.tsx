// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { markdownRender } = vi.hoisted(() => ({
  markdownRender: vi.fn(({ children }: { children?: string }) => <div>{children}</div>),
}))

vi.mock('./MarkdownView', () => ({
  MarkdownView: markdownRender,
}))

import { AskUserCard } from './AskUserCard'
import { useDraftStore } from '@/stores/draftStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('AskUserCard', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    markdownRender.mockClear()
    useDraftStore.setState({ texts: {}, attachments: {} })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const options = () => [...host.querySelectorAll<HTMLButtonElement>('[data-ask-user-card] button')]

  it('renders the question as markdown and the candidates as pickable options', () => {
    act(() => root.render(
      <AskUserCard question="选哪个方案？" candidates={['方案 A', '方案 B']} />,
    ))

    expect(markdownRender).toHaveBeenCalledTimes(1)
    expect(markdownRender.mock.calls[0][0].children).toBe('选哪个方案？')
    const buttons = options()
    expect(buttons).toHaveLength(2)
    expect(buttons[0].textContent).toContain('方案 A')
    expect(buttons[1].textContent).toContain('方案 B')
    expect(host.textContent).toContain('点击选项将填入输入框')
  })

  it('fills the draft store when an option is picked and marks it as filled', () => {
    act(() => root.render(
      <AskUserCard question="选哪个？" candidates={['是', '否']} draftKey="liveChat:s9" />,
    ))

    act(() => options()[1].click())

    expect(useDraftStore.getState().texts['liveChat:s9']).toBe('否')
    expect(options()[1].textContent).toContain('已填入')
    expect(options()[0].textContent).not.toContain('已填入')
  })

  it('moves the filled marker when a different option is picked', () => {
    act(() => root.render(
      <AskUserCard question="选哪个？" candidates={['是', '否']} draftKey="liveChat:s9" />,
    ))

    const pick = (label: string) => {
      const target = options().find((button) => button.textContent?.includes(label))!
      act(() => target.click())
    }

    pick('是')
    expect(useDraftStore.getState().texts['liveChat:s9']).toBe('是')
    pick('否')
    expect(useDraftStore.getState().texts['liveChat:s9']).toBe('否')
    expect(options().find((b) => b.textContent?.includes('否'))?.textContent).toContain('已填入')
    expect(options().find((b) => b.textContent?.includes('是'))?.textContent).not.toContain('已填入')
  })

  it('never writes the draft store without a draft key', () => {
    act(() => root.render(
      <AskUserCard question="选哪个？" candidates={['是']} />,
    ))

    act(() => options()[0].click())

    expect(useDraftStore.getState().texts).toEqual({})
  })
})
