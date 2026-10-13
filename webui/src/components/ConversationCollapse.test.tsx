// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('./MarkdownView', () => ({ MarkdownView: ({ children }: { children?: string }) => <div>{children}</div> }))
import { MessageBubble } from './MessageBubble'
import { ConversationCollapseProvider, ConversationCollapseControl } from './ConversationCollapse'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const afterCollapse = vi.fn()
const content = '**LLM Running (Turn 1) ...**\n<summary>第一轮</summary>\n🛠️ code_run({})\n'
  + '**LLM Running (Turn 2) ...**\n最终结论\n[Info] Final response to user.'
function render(session = 'a', includeFirst = true) {
  act(() => root.render(<ConversationCollapseProvider key={session} onAfterCollapse={afterCollapse}>
    <div data-viewport>
      <div data-history="first">{includeFirst && <MessageBubble role="assistant" content={content} streaming={false} />}</div>
      <div data-history="second"><MessageBubble role="assistant" content={content} streaming={false} /></div>
      <div data-live><MessageBubble role="assistant" content={content} streaming /></div>
      <ConversationCollapseControl />
    </div>
  </ConversationCollapseProvider>))
}
function process(which: string) {
  return [...host.querySelectorAll<HTMLButtonElement>(`[data-history="${which}"] button`)].find(b => b.textContent?.includes('执行过程'))!
}
function setTurnOpen(which: string, open = true, index = 0) {
  const record = host.querySelectorAll<HTMLDetailsElement>(`[data-history="${which}"] details`)[index]
  act(() => { record.open = open; record.dispatchEvent(new Event('toggle')) })
}
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  afterCollapse.mockReset()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })

it('lets an earlier history reply reveal one fixed conversation action, without opening the last reply', () => {
  render()
  expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
  act(() => process('first').click())
  expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
  setTurnOpen('first')
  const actions = host.querySelectorAll('[data-collapse-to-latest]')
  expect(actions).toHaveLength(1)
  expect(actions[0].closest('[data-history]')).toBeNull()
  expect(actions[0].parentElement?.className).toContain('absolute')
  expect(actions[0].closest('[data-conversation-collapse]')).not.toBeNull()
  expect(process('second').getAttribute('aria-expanded')).toBe('false')
  setTurnOpen('first', false)
  expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
  setTurnOpen('first')
  act(() => process('first').click())
  expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
})

it('collapses multiple history replies and the live reply together before one latest navigation', () => {
  const localScroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: localScroll })
  try {
    render()
    act(() => { process('first').click(); process('second').click() })
    expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
    setTurnOpen('first')
    setTurnOpen('second')
    act(() => (host.querySelector('[data-live] [data-running-turn] > button') as HTMLButtonElement).click())
    expect(host.querySelectorAll('[data-collapse-to-latest]')).toHaveLength(1)
    act(() => (host.querySelector('[data-collapse-to-latest]') as HTMLButtonElement).click())
    expect(process('first').getAttribute('aria-expanded')).toBe('false')
    expect(process('second').getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelectorAll('[data-running-turn] > button[aria-expanded="true"]')).toHaveLength(0)
    expect(host.querySelectorAll('details')).toHaveLength(0)
    expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
    expect(host.textContent).toContain('最终结论')
    expect(localScroll).not.toHaveBeenCalled()
    expect(afterCollapse).toHaveBeenCalledTimes(1)
  } finally { delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView }
})

it('removes stale registrations when a history reply unmounts or the session changes', () => {
  render()
  act(() => process('first').click())
  setTurnOpen('first')
  render('a', false)
  expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
  act(() => process('second').click())
  setTurnOpen('second')
  expect(host.querySelector('[data-collapse-to-latest]')).not.toBeNull()
  render('b', false)
  expect(host.querySelector('[data-collapse-to-latest]')).toBeNull()
})
