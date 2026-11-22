// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TaskRun } from '@/api/types'
import { queryKeys } from '@/queries/queryKeys'
import { dialog } from '@/stores/dialogStore'
import Tasks from './Tasks'

vi.mock('@/hooks/useHubEvent', () => ({ useHubEvent: vi.fn() }))
vi.mock('@/api/client', () => ({ api: {
  taskSchedules: vi.fn(),
  taskRuns: vi.fn(),
  triggerTaskSchedule: vi.fn(),
  upsertTaskSchedule: vi.fn(),
  deleteTaskSchedule: vi.fn(),
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
    prompt_preview: '', result_preview: '', note: '',
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

it('renders Chinese status labels and surfaces errors when schedule actions fail', async () => {
  const { api } = await import('@/api/client')
  client.setQueryData(queryKeys.tasks.schedules, {
    schedules: [{
      id: 't-1', name: '早报', type: 'interval', interval_minutes: 60, cron: '',
      prompt: 'test', enabled: false, fire_count: 0, last_fired_at: 0,
    }],
  })
  client.setQueryData(queryKeys.tasks.runs, {
    runs: [
      { id: 'r1', task_id: 't-1', task_name: '早报', fired_at: 1700000000, finished_at: 0, stream_id: '', status: 'done', prompt_preview: '', result_preview: '', note: '' },
      { id: 'r2', task_id: 't-1', task_name: '早报', fired_at: 1700000000, finished_at: 0, stream_id: '', status: 'running', prompt_preview: '', result_preview: '', note: '' },
      { id: 'r3', task_id: 't-1', task_name: '早报', fired_at: 1700000000, finished_at: 0, stream_id: '', status: 'error', prompt_preview: '', result_preview: '', note: '' },
    ],
  })
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))

  const badges = Array.from(host.querySelectorAll('tbody tr')).map((tr) => tr.children[2]?.textContent?.trim())
  expect(badges).toEqual(['完成', '运行中', '失败'])
  expect(host.querySelector('header')?.textContent).toContain('已启用 0/1')
  expect(host.querySelector('header')?.textContent).toContain('记录 3 条')
  expect(host.querySelector('header')?.textContent).toContain('运行中 1')
  expect(host.textContent).not.toContain('邮件设置')
  expect(host.querySelectorAll('thead th')).toHaveLength(4)

  const disabledPill = Array.from(host.querySelectorAll('span')).find((el) => el.textContent === '禁用')!
  expect(disabledPill.className).not.toContain('bg-slate-700')
  expect(disabledPill.className).toContain('text-ink-muted')

  const alertSpy = vi.spyOn(dialog, 'alert').mockResolvedValue(undefined)
  vi.spyOn(dialog, 'confirm').mockResolvedValue(true)
  vi.mocked(api.upsertTaskSchedule).mockRejectedValueOnce(new Error('save denied'))

  const enableBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '启用')!
  await act(async () => { enableBtn.click(); await Promise.resolve() })
  expect(alertSpy).toHaveBeenCalledWith('切换失败', 'save denied')

  vi.mocked(api.triggerTaskSchedule).mockRejectedValueOnce(new Error('trigger denied'))
  const fireBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '立即触发')!
  await act(async () => { fireBtn.click(); await new Promise((r) => setTimeout(r, 10)) })
  expect(alertSpy).toHaveBeenCalledWith('触发失败', 'trigger denied')

  alertSpy.mockRestore()
})
