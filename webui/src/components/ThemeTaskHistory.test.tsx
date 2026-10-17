// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { ThemeTaskHistory } from './ThemeTaskHistory'
import { api } from '@/api/client'
import type { ChatWSOut, SessionMessagesResponse } from '@/api/types'
import { useChatStore } from '@/stores/chatStore'

const sockets = vi.hoisted(() => [] as { path: string; onMessage?: (e: ChatWSOut) => void; close: ReturnType<typeof vi.fn> }[])
vi.mock('@/runtime/chatSocket', () => ({ ChatSocket: class {
  onMessage?: (e: ChatWSOut) => void
  close = vi.fn()
  constructor(public path: string) { sockets.push(this) }
  open() {}
} }))
vi.mock('@/api/client', () => ({ api: { getSessionMessages: vi.fn() } }))
vi.mock('@/components/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <div>{content}</div> }))
vi.mock('@/components/TranscriptRecordContent', () => ({ TranscriptRecordContent: ({ content }: { content: string }) => <div>{content}</div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const page = (items: SessionMessagesResponse['items'], more = false): SessionMessagesResponse => ({ session_id: 'one', archive_bound: true, revision: 'r1', items, total: 2, has_more: more, next_before: more ? 10 : null })
const message = (id: string, content: string, run = 'latest', ordinal = 10) => ({ id, content, run_id: run, role: 'assistant' as const, ordinal, timestamp: '2026-10-18T00:00:00Z' })
let host: HTMLDivElement, root: Root
async function render(runId: string | null = 'latest', active = false) { await act(async () => { root.render(<ThemeTaskHistory sessionId="one" runId={runId} active={active}><p>原有折叠结论</p></ThemeTaskHistory>) }) }
async function click(text: string) { const b = [...host.querySelectorAll('button')].find(x => x.textContent?.includes(text)); expect(b, text).toBeTruthy(); await act(async () => { b!.click() }) }
const panel = () => host.querySelector('[role=tabpanel]:not([hidden])')!
beforeEach(async () => {
  vi.clearAllMocks(); sockets.length = 0
  vi.mocked(api.getSessionMessages).mockResolvedValue(page([message('a', '<summary>本次摘要</summary>本次结果'), message('b', '旧结果', 'old')]))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await render()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })
it('loads lazily and keeps session state isolated while filtering the current run', async () => {
  const globalState = useChatStore.getState()
  expect(api.getSessionMessages).not.toHaveBeenCalled(); expect(sockets).toHaveLength(0)
  await click('本次过程')
  expect(panel().textContent).toContain('本次摘要'); expect(panel().textContent).not.toContain('本次结果'); expect(panel().textContent).not.toContain('旧结果')
  expect(sockets[0].path).toBe('/ws/sessions/one')
  expect(useChatStore.getState()).toBe(globalState)
  await click('会话历史')
  expect(panel().textContent).toContain('旧结果'); expect(sockets[0].close).toHaveBeenCalledOnce()
  await click('结论'); expect(sockets[1].close).toHaveBeenCalledOnce()
})
it('shows only collapsed summaries and links to the report without rendering raw responses', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page([message('turns', '**LLM Running (Turn 1) ...**\n<summary>检查</summary>\n第一段执行内容\n**LLM Running (Turn 2) ...**\n<summary>整理</summary>\n第二段执行内容')]))
  await click('本次过程')
  expect(panel().textContent).toContain('检查')
  expect(panel().textContent).toContain('Turn 1')
  expect(panel().textContent).not.toContain('第一段执行内容')
  expect(panel().textContent).toContain('整理')
  expect(panel().textContent).not.toContain('第二段执行内容')
  expect(panel().querySelectorAll('details')).toHaveLength(0)
  expect(panel().textContent).not.toContain('加载更早')
  await click('查看结论')
  expect(host.querySelector('[role=tab][aria-selected=true]')?.textContent).toBe('结论')
})
it('automatically completes the current run across pages and stops at older runs', async () => {
  vi.mocked(api.getSessionMessages)
    .mockResolvedValueOnce({ ...page([message('last', '<summary>本次末尾</summary>', 'latest', 30)], true), next_before: 30 })
    .mockResolvedValueOnce({ ...page([message('middle', '<summary>本次中段</summary>', 'latest', 20)], true), next_before: 20 })
    .mockResolvedValueOnce({ ...page([message('prior', '不属于本次', 'old', 1), message('first', '<summary>本次起点</summary>', 'latest', 10)], true), next_before: 1 })
  await click('本次过程')
  const text = panel().textContent!
  expect(text.indexOf('本次起点')).toBeGreaterThanOrEqual(0)
  expect(text.indexOf('本次起点')).toBeLessThan(text.indexOf('本次中段'))
  expect(text.indexOf('本次中段')).toBeLessThan(text.indexOf('本次末尾'))
  expect(text).not.toContain('不属于本次')
  expect(text).not.toContain('加载更早')
  expect(vi.mocked(api.getSessionMessages).mock.calls.map(call => call[1]?.before)).toEqual([undefined, 30, 20])
})
it('reports a stalled current-run cursor instead of looping forever', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValue(page([message('last', '本次末尾')], true))
  await click('本次过程')
  expect(panel().textContent).toContain('本次过程未能完整读取')
  expect(vi.mocked(api.getSessionMessages)).toHaveBeenCalledTimes(2)
})
const question = (id: string, content: string, ordinal: number) => ({ ...message(id, content, 'latest', ordinal), role: 'user' as const })
it('shows one user exchange at a time with only its question and conclusion', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page([
    question('q1', '第一个问题', 1),
    message('a1', '**LLM Running (Turn 1) ...**\n<summary>过程摘要</summary>中间秘密\n**LLM Running (Turn 2) ...**\n<summary>完成</summary>最终结论一', 'latest', 2),
    question('q2', '第二个问题', 3), message('a2', '最终结论二', 'latest', 4),
  ]))
  await click('会话历史')
  expect(panel().textContent).toContain('第二个问题')
  expect(panel().textContent).toContain('最终结论二')
  expect(panel().textContent).not.toContain('第一个问题')
  expect([...panel().querySelectorAll('button')].find(b => b.textContent?.includes('下节'))?.disabled).toBe(true)
  await click('上节')
  expect(panel().textContent).toContain('第一个问题')
  expect(panel().textContent).toContain('最终结论一')
  for (const hidden of ['中间秘密', '过程摘要', 'Turn', '刷新', '已同步', '加载更早', '第二个问题']) expect(panel().textContent).not.toContain(hidden)
  expect(panel().querySelectorAll('article')).toHaveLength(1)
  await click('下节')
  expect(panel().textContent).toContain('第二个问题')
})
it('loads previous sections across answer-only pages without duplicate navigation entries', async () => {
  vi.mocked(api.getSessionMessages)
    .mockResolvedValueOnce({ ...page([question('q2', '新问题', 30), message('a2', '新结论', 'latest', 40)], true), next_before: 30 })
    .mockResolvedValueOnce({ ...page([message('a1', '旧结论', 'latest', 20)], true), next_before: 20 })
    .mockResolvedValueOnce(page([question('q1', '旧问题', 10), message('a1', '旧结论', 'latest', 20)]))
  await click('会话历史'); await click('上节')
  expect(panel().textContent).toContain('旧问题'); expect(panel().textContent).toContain('旧结论')
  expect(vi.mocked(api.getSessionMessages).mock.calls.slice(1).map(call => call[1]?.before)).toEqual([30, 20])
  expect([...panel().querySelectorAll('button')].find(b => b.textContent?.includes('上节'))?.disabled).toBe(true)
  await click('下节'); expect(panel().textContent).toContain('新问题')
})
it('finds the latest question beyond the first page and excludes system messages', async () => {
  vi.mocked(api.getSessionMessages)
    .mockResolvedValueOnce({ ...page([message('a1', '长回复的结论', 'latest', 20)], true), next_before: 20 })
    .mockResolvedValueOnce(page([question('q1', '跨页问题', 1)]))
  await click('会话历史')
  expect(panel().textContent).toContain('跨页问题'); expect(panel().textContent).toContain('长回复的结论')
  expect(panel().textContent).not.toContain('系统秘密')
})
it('guards repeated history cursors and allows retry', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValue({ ...page([message('a1', '半段回复')], true), next_before: 10 })
  await click('会话历史')
  expect(panel().textContent).toContain('历史分页未能前进')
  expect(vi.mocked(api.getSessionMessages)).toHaveBeenCalledTimes(2)
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page([question('q1', '重试问题', 1), message('a1', '重试结论', 'latest', 2)]))
  await click('重试'); expect(panel().textContent).toContain('重试问题')
})
it('does not show a partial streaming answer as a conclusion', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page([question('q1', '正在处理的问题', 1)]))
  await click('会话历史')
  await act(async () => {
    sockets[0].onMessage?.({ type: 'started', session_id: 'one', stream_id: 's1', run_id: 'latest' })
    sockets[0].onMessage?.({ type: 'next', session_id: 'one', stream_id: 's1', run_id: 'latest', content: '<summary>过程</summary>尚未完成的响应' })
  })
  expect(panel().textContent).toContain('正在执行，尚无结论')
  expect(panel().textContent).not.toContain('尚未完成的响应')
})
it('applies only events for this session, without switching to chat or changing the selected tab', async () => {
  await click('本次过程')
  await act(async () => { sockets[0].onMessage?.({ type: 'started', session_id: 'other', stream_id: 'bad', run_id: 'latest', query: '不能出现' }) })
  expect(panel().textContent).not.toContain('不能出现')
  await act(async () => {
    sockets[0].onMessage?.({ type: 'started', session_id: 'one', stream_id: 's1', run_id: 'latest', query: '实时指令' })
    sockets[0].onMessage?.({ type: 'next', session_id: 'one', stream_id: 's1', run_id: 'latest', content: '<summary>实时摘要</summary>实时正文' })
  })
  expect(panel().textContent).toContain('实时摘要')
  expect(panel().textContent).not.toContain('实时正文')
  expect(panel().textContent).not.toContain('实时指令')
  expect(panel().textContent).not.toContain('查看结论')
  await render('latest', true)
  expect(host.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('本次过程')
})
it('offers retry after a read error and cancels a request when hidden', async () => {
  vi.mocked(api.getSessionMessages).mockRejectedValueOnce(new Error('offline'))
  await click('会话历史'); expect(panel().textContent).toContain('offline')
  await click('重试'); expect(panel().textContent).toContain('旧结果')
  const signal = vi.mocked(api.getSessionMessages).mock.calls.at(-1)?.[1]?.signal
  await click('结论'); expect(signal?.aborted).toBe(true)
})
it('does not pretend untagged legacy messages belong to the latest run', async () => {
  await render(null); await click('本次过程')
  expect(panel().textContent).toContain('暂无可关联的执行记录')
  expect(panel().textContent).not.toContain('旧结果')
})
it('supports keyboard tabs without navigating away', async () => {
  const first = host.querySelector('[role=tab]')!
  await act(async () => { first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(host.querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('本次过程')
  expect(document.activeElement?.getAttribute('role')).toBe('tab')
})

it('keeps the selected older exchange when a newer archive revision arrives', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce({ ...page([
    question('q1', '问题一', 1), message('a1', '结论一', 'first', 2),
    question('q2', '问题二', 3), message('a2', '结论二', 'second', 4),
  ]), total: 4 })
  await click('会话历史'); await click('上节')
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce({ ...page([
    question('q3', '问题三', 5), message('a3', '结论三', 'third', 6),
  ]), revision: 'r2', total: 6 })
  await act(async () => { sockets.at(-1)!.onMessage!({ type: 'done', session_id: 'one', stream_id: 'a3', content: '结论三' }) })
  expect(panel().textContent).toContain('问题一')
  await click('下节'); expect(panel().textContent).toContain('问题二')
  await click('下节'); expect(panel().textContent).toContain('问题三')
  expect(panel().querySelectorAll('article')).toHaveLength(1)
})

it('never falls back to raw response text when summaries are missing', async () => {
  vi.mocked(api.getSessionMessages).mockResolvedValueOnce(page([message('plain', '**LLM Running (Turn 1) ...**\n原始响应秘密内容')]))
  await click('本次过程')
  expect(panel().textContent).toContain('未记录过程摘要')
  expect(panel().textContent).not.toContain('原始响应秘密内容')
  expect(panel().textContent).toContain('查看结论')
})
