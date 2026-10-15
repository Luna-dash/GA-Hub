// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ThemeTasks from './ThemeTasks'
import { api } from '@/api/client'

vi.mock('@/api/client', () => ({ api: {
  sessions: vi.fn(async () => ({ items: [{ id: 'one', title: '签到', llm_key: 'model', theme_task: { title: '签到', instruction: '检查签到' } }] })),
  themeRun: vi.fn(async () => ({ run: { started_at: 10, finished_at: 20, turns: 2, outcome: 'completed', report: '**LLM Running (Turn 1) ...**\n<summary>检查</summary>\n过程转储\n**LLM Running (Turn 2) ...**\n<summary>完成</summary>\n最终：签到成功。' } })),
  sessionRuntime: vi.fn(async () => ({ status: 'idle' })),
  llms: vi.fn(async () => ({ llms: [{ key: 'model', name: '执行模型' }] })),
} }))
const ev = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown) => void>(), states: [] as ((s: string) => void)[] }))
vi.mock('@/runtime/hubEventClient', () => ({ hubEventClient: {
  subscribe: (topic: string, fn: (e: unknown) => void) => { ev.handlers.set(topic, fn); return () => { ev.handlers.delete(topic) } },
  subscribeState: (fn: (s: string) => void) => { ev.states.push(fn); return () => { ev.states = ev.states.filter(f => f !== fn) } },
} }))
vi.mock('@/components/MessageContent', () => ({ MessageContent: ({ content }: { content: string }) => <div>{content}</div> }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement, root: Root, client: QueryClient
beforeEach(async () => {
  localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter><ThemeTasks /></MemoryRouter></QueryClientProvider>) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
})
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove() })
it('starts compact, opens fullscreen with conclusion only, and returns to the grid', () => {
  const card = host.querySelector('[aria-label="打开主题任务：签到"]') as HTMLButtonElement
  expect(card).not.toBeNull()
  expect(card.textContent).toContain('执行模型')
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(host.textContent).not.toContain('过程转储')
  act(() => card.click())
  const dialog = host.querySelector('[role="dialog"]')!
  expect(dialog.className).toContain('inset-0')
  expect(dialog.textContent).toContain('最终：签到成功。')
  expect(dialog.textContent).not.toContain('过程转储')
  expect(dialog.textContent).toContain('过程与历史')
  act(() => (host.querySelector('[aria-label="收起任务卡片"]') as HTMLButtonElement).click())
  expect(host.querySelector('[role="dialog"]')).toBeNull()
})

const wait = (ms = 25) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) })
const runtimeCalls = () => vi.mocked(api.sessionRuntime).mock.calls.length

it('shows a run shortcut on the compact card', () => {
  expect(host.querySelector('[aria-label="运行主题任务：签到"]')).not.toBeNull()
})

it('stays quiet while idle and refreshes only the card named by a runtime event', async () => {
  const before = runtimeCalls()
  await wait(60)
  expect(runtimeCalls()).toBe(before)
  act(() => ev.handlers.get('session:runtime')?.({ topic: 'session:runtime', payload: { session_id: 'other' } }))
  await wait()
  expect(runtimeCalls()).toBe(before)
  act(() => ev.handlers.get('session:runtime')?.({ topic: 'session:runtime', payload: { session_id: 'one' } }))
  await wait()
  expect(runtimeCalls()).toBe(before + 1)
})

it('refreshes every card once after the event socket reconnects', async () => {
  const before = runtimeCalls()
  act(() => { ev.states.forEach(f => f('closed')); ev.states.forEach(f => f('open')) })
  await wait()
  expect(runtimeCalls()).toBe(before + 1)
})

it('opens the conclusion requested by a notification link', async () => {
  act(() => root.unmount())
  root = createRoot(host)
  await act(async () => { root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/theme-tasks?open=one']}><ThemeTasks /></MemoryRouter></QueryClientProvider>) })
  await wait(60)
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('最终：签到成功。')
})
