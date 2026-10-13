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

it('defaults to simple hints; opens the exact raw record without duplicate prose and fully collapses', () => {
  render(turn(1))
  expect(host.textContent).toContain('读取文件')
  expect(host.textContent).not.toContain('private-argument.txt')
  expect(host.querySelector('[data-running-turn] button')?.getAttribute('aria-expanded')).toBe('false')
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-full-record] [data-markdown]')?.textContent).toBe(raw)
  expect(host.querySelector('[data-tool-hint]')).toBeNull()
  expect(host.textContent?.match(/模型说明/g)).toHaveLength(1)
  expect(host.textContent).toContain('收起全部并回到最新')
  click('[data-full-record] button')
  expect(host.querySelector('[data-full-record]')).toBeNull()
  expect(host.textContent).not.toContain('private-argument.txt')
  expect(host.textContent).not.toContain('读取文件')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
})

it('keeps manual full records within the current turn but retires them on new output', () => {
  render(turn(1)); click('[data-running-turn="1"] > button')
  render(turn(1, raw + '\n后续新增正文'))
  expect(host.querySelector('[data-full-record]')?.textContent).toContain('后续新增正文')
  render([turn(1, raw + '\n后续新增正文'), turn(2), turn(3), turn(4), turn(5)].join('\n'))
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).toBeNull()
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '收起全部并回到最新')!.click())
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).toBeNull()
  expect(host.querySelectorAll('[data-running-turn] > div')).toHaveLength(0)
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).not.toBeNull()
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
})

it('opens an old title-only row as full, then completely collapses it', () => {
  render([1, 2, 3, 4].map(n => turn(n)).join('\n'))
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-running-turn="1"] [data-full-record]')).not.toBeNull()
  click('[data-running-turn="1"] [data-full-record] button')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
})

it('shows a simple preview only for the latest visible turn as new turns arrive', () => {
  render([1, 2, 3, 4].map(n => turn(n)).join('\n'))
  for (const n of [1, 2, 3]) expect(host.querySelector(`[data-running-turn="${n}"] > div`)).toBeNull()
  expect(host.querySelector('[data-running-turn="4"] [data-tool-hint]')).not.toBeNull()
  render([1, 2, 3, 4, 5].map(n => turn(n)).join('\n'))
  expect(host.querySelector('[data-running-turn="4"] > div')).toBeNull()
  expect(host.querySelector('[data-running-turn="5"] [data-tool-hint]')).not.toBeNull()
})

it('keeps explicit collapse through streaming and resume, hides fallback tool titles, and can reopen', () => {
  const noSummary = (body = raw) => `**LLM Running (Turn 1) ...**\n${body}`
  render(noSummary())
  click('[data-running-turn="1"] > button')
  click('[data-full-record] button')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(host.textContent).not.toContain('读取文件')
  render(noSummary(raw + '\n更新正文'))
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '收起全部并回到最新')!.click())
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(host.textContent).not.toContain('读取文件')
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-full-record] [data-markdown]')?.textContent).toBe(raw + '\n更新正文')
  click('[data-running-turn="1"] > button')
  render(noSummary(raw + '\n更新正文') + '\n' + turn(2))
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(host.querySelector('[data-running-turn="2"] [data-tool-hint]')).not.toBeNull()
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
  expect(host.textContent).toContain('收起全部并回到最新')
})

it('does not reserve the previous preview height when the latest visible turn changes', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 360 } as DOMRect)
  render(turn(1))
  const viewport = host.querySelector<HTMLElement>('[data-running-preview]')!
  expect(viewport.style.minHeight).toBe('')
  render(turn(1) + '\n' + turn(2, '短正文'))
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(host.querySelector('[data-running-turn="2"] > div')).not.toBeNull()
  expect(viewport.style.minHeight).toBe('')
  expect(viewport.style.height).toBe('')
})

it('releases height after fully collapsing and keeps the explicit collapse on resume', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 480, top: 0 } as DOMRect)
  render(turn(1))
  click('[data-running-turn="1"] > button')
  const viewport = host.querySelector<HTMLElement>('[data-running-preview]')!
  expect(host.querySelector('[data-full-record]')).not.toBeNull()
  click('[data-full-record] button')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(viewport.style.minHeight).toBe('')
  const resume = [...host.querySelectorAll('button')].find(button => button.textContent === '收起全部并回到最新')!
  act(() => resume.click())
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(viewport.style.minHeight).toBe('')
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


it('does not retire the current prose for a bare or partial next turn', () => {
  const first = turn(1, '当前正文🛠️ code_run({})继续正文')
  render(first + '\n**LLM Running (Turn 2) ...**')
  expect(host.querySelector('[data-running-turn="1"] > div')).not.toBeNull()
  expect(host.querySelector('[data-running-turn="2"]')).toBeNull()
  render(first + '\n**LLM Running (Turn 2) ...**\n<think')
  expect(host.querySelector('[data-running-turn="1"] > div')).not.toBeNull()
  render(first + '\n**LLM Running (Turn 2) ...**\n新正文')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  expect(host.querySelector('[data-running-turn="2"]')?.textContent).toContain('新正文')
})

it('hides long incomplete thoughts while preserving the full record', () => {
  const thought = '长思考内容'.repeat(2000)
  render('**LLM Running (Turn 1) ...**\n<analysis>' + thought)
  expect(host.textContent).not.toContain(thought)
  expect(host.querySelector('[data-thinking-hint]')).not.toBeNull()
  expect(host.querySelector('[data-running-turn="1"] > button')?.textContent).toContain('正在思考')
  click('[data-running-turn="1"] > button')
  expect(host.querySelector('[data-full-record]')?.textContent).toContain(thought)
})

it('collapses every turn and recovery record, jumps after commit, and lets a new turn preview normally', () => {
  const scroll = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scroll })
  const content = turn(1) + '\n' + turn(2) + '\n' + turn(3)
  const renderRecovery = (text: string) => act(() => root.render(<RunningTranscript transcript={parseAssistantTranscript(text)} askUserInteractive recoveryStatus={<span>重连详情</span>} />))
  renderRecovery(content)
  for (const n of [1, 2, 3]) click(`[data-running-turn="${n}"] > button`)
  expect(host.querySelectorAll('[data-full-record]')).toHaveLength(3)
  const viewport = host.querySelector<HTMLElement>('[data-running-preview]')!
  Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 900 })
  scroll.mockImplementation(() => {
    expect(host.querySelectorAll('[data-running-turn] > div')).toHaveLength(0)
    expect(host.textContent).not.toContain('重连详情')
  })
  click('[data-collapse-to-latest]')
  expect(viewport.scrollTop).toBe(900)
  expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })
  expect(host.querySelectorAll('[data-full-record]')).toHaveLength(0)
  renderRecovery(content + '继续输出')
  expect(host.querySelectorAll('[data-running-turn] > div')).toHaveLength(0)
  renderRecovery(content + '\n' + turn(4, '新的正文'))
  expect(host.querySelector('[data-running-turn="4"] > div')?.textContent).toContain('新的正文')
  expect(host.querySelector('[data-running-turn="1"] > div')).toBeNull()
  click('[data-collapse-to-latest]')
  expect(scroll).toHaveBeenCalledTimes(2)
  click('[data-running-turn="2"] > button')
  expect(host.querySelector('[data-running-turn="2"] [data-full-record]')).not.toBeNull()
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
})
