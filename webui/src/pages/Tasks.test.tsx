// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskRun } from '@/api/types'
import { queryKeys } from '@/queries/queryKeys'
import Tasks from './Tasks'

vi.mock('@/hooks/useHubEvent', () => ({ useHubEvent: vi.fn() }))
vi.mock('@/api/client', () => ({ api: {
  taskSchedules: vi.fn(),
  taskRuns: vi.fn(),
  taskEmailConfig: vi.fn(),
} }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(queryKeys.tasks.schedules, { schedules: [] })
  client.setQueryData(queryKeys.tasks.emailConfig, {})
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  host.remove()
})

function setRuns(count: number) {
  const runs: TaskRun[] = Array.from({ length: count }, (_, i) => ({
    id: `run-${i + 1}`, task_id: 'task-1', task_name: `Run ${i + 1}`,
    fired_at: 1700000000 - i * 60, finished_at: 0, stream_id: '', status: 'done',
    prompt_preview: '', result_preview: '', email_sent: false, email_error: '', note: '',
  }))
  client.setQueryData(queryKeys.tasks.runs, { runs })
}

function render(count: number) {
  setRuns(count)
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))
}

const nav = () => host.querySelector('nav[aria-label="运行历史分页"]')
const button = (name: string) => nav()!.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!
const pageText = () => nav()?.querySelector('[role="status"]')?.textContent?.trim()
const rows = () => Array.from(host.querySelectorAll('tbody tr')).map(row => row.children[1]?.textContent)

it('shows ten rows at a time in API order and stops at both ends', () => {
  render(23)
  const prev = button('上一页')
  const next = button('下一页')
  expect(pageText()).toBe('第 1 / 3 页 · 23 条')
  expect(rows()).toEqual(Array.from({ length: 10 }, (_, i) => `Run ${i + 1}`))
  expect(prev.disabled).toBe(true)
  expect(next.disabled).toBe(false)

  act(() => next.click())
  expect(pageText()).toBe('第 2 / 3 页 · 23 条')
  expect(rows()).toEqual(Array.from({ length: 10 }, (_, i) => `Run ${i + 11}`))
  act(() => next.click())
  expect(pageText()).toBe('第 3 / 3 页 · 23 条')
  expect(rows()).toEqual(['Run 21', 'Run 22', 'Run 23'])
  expect(next.disabled).toBe(true)
  act(() => prev.click())
  expect(rows()[0]).toBe('Run 11')
})

it.each([0, 10])('does not show pagination for %s runs', count => {
  render(count)
  expect(nav()).toBeNull()
  if (count === 0) expect(host.querySelector('tbody')?.textContent).toBe('尚无运行历史')
  else expect(rows()).toHaveLength(count)
})

it('keeps the current page on refresh and clamps it when the last page disappears', async () => {
  render(23)
  act(() => button('下一页').click())
  act(() => button('下一页').click())

  const refresh = (count: number) => act(async () => {
    setRuns(count)
    await new Promise(resolve => setTimeout(resolve, 15))
  })
  await refresh(24)
  expect(pageText()).toBe('第 3 / 3 页 · 24 条')
  await refresh(12)
  expect(pageText()).toBe('第 2 / 2 页 · 12 条')
  expect(rows()).toEqual(['Run 11', 'Run 12'])
  await refresh(23)
  expect(pageText()).toBe('第 2 / 3 页 · 23 条')
})
