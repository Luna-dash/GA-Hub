// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parseAssistantTranscript } from '@/utils/assistantTranscript'
vi.mock('./MarkdownView', () => ({ MarkdownView: ({ children }: { children: string }) => <div data-markdown>{children}</div> }))
import { RunningTranscript } from './RunningTranscript'

let host: HTMLDivElement, root: Root
const raw = '模型说明\n🛠️ Tool: `file_read` 📥 args:\n````json\n{"path":"private-argument.txt"}\n````\n📤 Result:\n````text\nraw-tool-result\n````'
const turn = (n: number, body = raw) => `**LLM Running (Turn ${n}) ...**\n<summary>检查第${n}轮</summary>\n${body}`
function render(content: string) {
  act(() => root.render(<RunningTranscript transcript={parseAssistantTranscript(content)} askUserDraftKey="test" askUserInteractive />))
}
function click(selector: string) { act(() => host.querySelector<HTMLButtonElement>(selector)!.click()) }
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

it('defaults to simple hints; opens the exact raw record without duplicate prose and collapses back', () => {
  render(turn(1))
  expect(host.textContent).toContain('读取文件')
  expect(host.textContent).not.toContain('private-argument.txt')
  expect(host.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-full-record] [data-markdown]')?.textContent).toBe(raw)
  expect(host.querySelector('[data-tool-hint]')).toBeNull()
  expect(host.textContent?.match(/模型说明/g)).toHaveLength(1)
  expect(host.textContent).toContain('回到最新')
  click('[data-full-record] button')
  expect(host.querySelector('[data-full-record]')).toBeNull()
  expect(host.textContent).not.toContain('private-argument.txt')
  expect(host.textContent).toContain('读取文件')
})

it('keeps manual full records open through streaming, new turns and explicit resume', () => {
  render(turn(1)); click('[data-running-turn="1"] > button')
  render(turn(1, raw + '\n后续新增正文'))
  expect(host.querySelector('[data-full-record]')?.textContent).toContain('后续新增正文')
  render([turn(1, raw + '\n后续新增正文'), turn(2), turn(3), turn(4), turn(5)].join('\n'))
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).not.toBeNull()
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '回到最新')!.click())
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).not.toBeNull()
  expect(host.textContent).not.toContain('回到最新')
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-running-turn="1"] [data-tool-hint]')).not.toBeNull()
})

it('opens an old title-only row as full, then leaves it readable in simple mode', () => {
  render([1, 2, 3, 4].map(n => turn(n)).join('\n'))
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).not.toBeNull()
  click('[data-running-turn="1"] [data-full-record] button')
  expect(host.querySelector('[data-running-turn="1"] [data-tool-hint]')).not.toBeNull()
})

it('anchors bottom collapse to this row and never resumes following due to the resulting scroll event', () => {
  render(turn(1)); click('[data-running-turn="1"] > button')
  const viewport = host.querySelector<HTMLElement>('[data-running-preview]')!
  const title = host.querySelector<HTMLElement>('[data-running-turn="1"] > button')!
  Object.defineProperties(viewport, { scrollHeight: { configurable: true, value: 1200 }, clientHeight: { configurable: true, value: 200 } })
  viewport.scrollTop = 1000
  vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue({ top: 100 } as DOMRect)
  vi.spyOn(title, 'getBoundingClientRect').mockReturnValue({ top: -400 } as DOMRect)
  click('[data-full-record] button')
  expect(viewport.scrollTop).toBe(500)
  viewport.scrollTop = 1000
  act(() => viewport.dispatchEvent(new Event('scroll', { bubbles: true })))
  expect(host.textContent).toContain('回到最新')
})

it('renders ask_user as a passive record while keeping only one interactive entry', () => {
  const body = '🛠️ ask_user({"question":"选择方案","candidates":["A","B"]})'
  render(turn(1, body))
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-full-record] [data-markdown]')?.textContent).toBe(body)
  expect(host.querySelectorAll('[data-ask-user-card]')).toHaveLength(1)
  expect(host.querySelector('[data-full-record] [data-ask-user-card]')).toBeNull()
  expect(host.querySelectorAll('[data-ask-user-card] button:not(:disabled)')).toHaveLength(2)
})
