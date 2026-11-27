// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { TaskRun, TaskSchedule } from '@/api/types'
import { queryKeys } from '@/queries/queryKeys'
import { dialog } from '@/stores/dialogStore'
import { useToastStore } from '@/stores/toastStore'
import Tasks from './Tasks'

vi.mock('@/hooks/useHubEvent', () => ({ useHubEvent: vi.fn() }))
vi.mock('@/api/client', () => ({
  api: {
    taskSchedules: vi.fn(),
    taskRuns: vi.fn(),
    taskRunResult: vi.fn(),
    triggerTaskSchedule: vi.fn(),
    upsertTaskSchedule: vi.fn(),
    deleteTaskSchedule: vi.fn(),
  }
}))

  ; (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
let client: QueryClient

beforeEach(() => {
  for (const item of useToastStore.getState().items) {
    useToastStore.getState().dismiss(item.id)
  }
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
    prompt_preview: '', result_preview: '', note: '', has_result: false,
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

  vi.spyOn(dialog, 'confirm').mockResolvedValue(true)
  vi.mocked(api.upsertTaskSchedule).mockRejectedValueOnce(new Error('save denied'))

  const enableBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '启用')!
  await act(async () => { enableBtn.click(); await Promise.resolve() })
  expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('save denied'))).toBe(true)

  vi.mocked(api.triggerTaskSchedule).mockRejectedValueOnce(new Error('trigger denied'))
  const fireBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '立即触发')!
  await act(async () => { fireBtn.click(); await new Promise((r) => setTimeout(r, 10)) })
  expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('trigger denied'))).toBe(true)
})

it('hides legacy progress and loads the full conclusion only on demand', async () => {
  vi.mocked(api.taskRunResult).mockResolvedValue({ result_text: '**归档通过**\n\n' + '完整结论。'.repeat(130) + '正文末尾' })
  client.setQueryData(queryKeys.tasks.runs, {
    runs: [
      {
        id: 'legacy-1', task_id: 'task-1', task_name: '归档任务', fired_at: 1700000000,
        finished_at: 0, stream_id: 's1', status: 'done', prompt_preview: '',
        result_preview: '**LLM Running (Turn 1) ...**\n\n<summary>开始读取配置并跑 dry-run。</summary>\n\n🛠️ Tool: `code_run`  📥 args:\n````text\n{"script": "x"}\n',
        note: '',
      },
      {
        id: 'clean-2', task_id: 'task-1', task_name: '归档任务', fired_at: 1700000100,
        finished_at: 0, stream_id: 's2', status: 'done', prompt_preview: '',
        result_preview: '归档完成：已压缩 3 个归档包，0 项错误。',
        has_result: true, note: '',
      },
    ],
  })
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))
  const resultCells = Array.from(host.querySelectorAll('tbody tr')).map((tr) => tr.children[3]?.textContent?.trim())
  expect(resultCells[0]).not.toContain('开始读取配置并跑 dry-run。')
  expect(vi.mocked(api.taskRunResult)).not.toHaveBeenCalled()
  expect(resultCells[0]).not.toContain('LLM Running')
  expect(resultCells[0]).not.toContain('<summary>')
  expect(resultCells[0]).not.toContain('code_run')
  expect(resultCells[1]).toContain('归档完成：已压缩 3 个归档包，0 项错误。')
  const details = Array.from(host.querySelectorAll('button')).filter((b) => b.textContent?.includes('详情'))
  expect(details).toHaveLength(1)
  await act(async () => { details[0].click() })
  await vi.waitFor(async () => {
    await act(async () => {})
    expect(document.querySelector('[role=dialog]')?.textContent).toContain('正文末尾')
  })
  expect(api.taskRunResult).toHaveBeenCalledWith('clean-2')
  expect(document.querySelector('[role=dialog] strong')?.textContent).toBe('归档通过')
})

it('locks TaskCard buttons against same-tick double-clicks, shows loading labels, and unlocks after rejection', async () => {
  let currentSchedule: TaskSchedule = {
    id: 't-lock', name: '早报任务', type: 'interval', interval_minutes: 60, cron: '',
    prompt: 'test', enabled: false, fire_count: 0, last_fired_at: 0,
  }
  vi.mocked(api.taskSchedules).mockImplementation(async () => ({ schedules: [currentSchedule] }))
  vi.mocked(api.taskRuns).mockResolvedValue({ runs: [] })
  client.setQueryData(queryKeys.tasks.schedules, { schedules: [currentSchedule] })
  client.setQueryData(queryKeys.tasks.runs, { runs: [] })
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))

  const btn = (text: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)!
  const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValue(true)

  // 1. Toggle same-tick double-click + rejection recovery
  let rejectToggle!: (err: Error) => void
  vi.mocked(api.upsertTaskSchedule).mockImplementationOnce(() => new Promise<TaskSchedule>((_, reject) => { rejectToggle = reject }))
  const enableBtn = btn('启用')
  await act(async () => {
    enableBtn.click()
    enableBtn.click()
  })
  expect(api.upsertTaskSchedule).toHaveBeenCalledTimes(1)
  expect(btn('启用中…').disabled).toBe(true)
  expect(btn('立即触发').disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="编辑任务"]')!.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除任务"]')!.disabled).toBe(true)
  await act(async () => { rejectToggle(new Error('toggle failed')); await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('toggle failed'))).toBe(true)
  expect(btn('启用').disabled).toBe(false)

  // Subsequent toggle succeeds and transitions to enabled=true, then 禁用 -> 禁用中…
  let resolveToggle!: (v: TaskSchedule) => void
  vi.mocked(api.upsertTaskSchedule).mockImplementationOnce(() => new Promise<TaskSchedule>((resolve) => { resolveToggle = resolve }))
  await act(async () => { btn('启用').click() })
  expect(api.upsertTaskSchedule).toHaveBeenCalledTimes(2)
  currentSchedule = { ...currentSchedule, enabled: true }
  await act(async () => { resolveToggle(currentSchedule); await Promise.resolve() })
  await act(async () => { await new Promise((r) => setTimeout(r, 15)) })
  expect(useToastStore.getState().items.some(t => t.kind === 'success' && t.message === '已启用定时任务')).toBe(true)

  let resolveDisable!: (v: TaskSchedule) => void
  vi.mocked(api.upsertTaskSchedule).mockImplementationOnce(() => new Promise<TaskSchedule>((resolve) => { resolveDisable = resolve }))
  const disableBtn = btn('禁用')
  await act(async () => {
    disableBtn.click()
    disableBtn.click()
  })
  expect(api.upsertTaskSchedule).toHaveBeenCalledTimes(3)
  expect(btn('禁用中…').disabled).toBe(true)
  currentSchedule = { ...currentSchedule, enabled: false }
  await act(async () => { resolveDisable(currentSchedule); await Promise.resolve() })
  await act(async () => { await new Promise((r) => setTimeout(r, 15)) })

  // 2. Trigger same-tick double-click (even across dialog.confirm) + rejection recovery
  let resolveConfirm!: (ok: boolean) => void
  confirmSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveConfirm = resolve }))
  let rejectFire!: (err: Error) => void
  vi.mocked(api.triggerTaskSchedule).mockImplementationOnce(() => new Promise((_, reject) => { rejectFire = reject }))

  const fireBtn = btn('立即触发')
  await act(async () => {
    fireBtn.click()
    fireBtn.click()
  })
  expect(confirmSpy).toHaveBeenCalledTimes(1)
  expect(btn('触发中…').disabled).toBe(true)
  expect(btn('启用').disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="编辑任务"]')!.disabled).toBe(true)
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除任务"]')!.disabled).toBe(true)

  await act(async () => { resolveConfirm(true); await Promise.resolve() })
  expect(api.triggerTaskSchedule).toHaveBeenCalledTimes(1)
  await act(async () => { rejectFire(new Error('fire failed')); await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('fire failed'))).toBe(true)
  expect(btn('立即触发').disabled).toBe(false)

  // 3. Delete same-tick double-click (before dialog.confirm) + rejection recovery + 删除中…
  let resolveDelConfirm!: (ok: boolean) => void
  confirmSpy.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveDelConfirm = resolve }))
  let rejectDelete!: (err: Error) => void
  vi.mocked(api.deleteTaskSchedule).mockImplementationOnce(() => new Promise((_, reject) => { rejectDelete = reject }))

  const delBtn = host.querySelector<HTMLButtonElement>('button[aria-label="删除任务"]')!
  await act(async () => {
    delBtn.click()
    delBtn.click()
  })
  expect(confirmSpy).toHaveBeenCalledTimes(2)
  expect(delBtn.disabled).toBe(true)
  expect(delBtn.textContent).toContain('删除中…')
  expect(btn('立即触发').disabled).toBe(true)

  await act(async () => { resolveDelConfirm(true); await Promise.resolve() })
  expect(api.deleteTaskSchedule).toHaveBeenCalledTimes(1)
  await act(async () => { rejectDelete(new Error('delete failed')); await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message.includes('delete failed'))).toBe(true)
  expect(delBtn.disabled).toBe(false)

  confirmSpy.mockRestore()
})

it('ignores backdrop clicks in TaskDialog and prompts only when dirty on close', async () => {
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))
  const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)

  const newBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('新建任务'))!
  act(() => newBtn.click())
  const dlg = host.querySelector('[role="dialog"]')!
  const backdrop = dlg.parentElement!

  // Backdrop click is ignored even when clean
  act(() => { backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()

  // Clean Escape closes synchronously without confirm
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(confirmSpy).not.toHaveBeenCalled()

  // Reopen, dirty the name input, and verify Escape prompts
  act(() => newBtn.click())
  const nameInput = host.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="每日早报"]')!
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setValue.call(nameInput, '未保存任务')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  expect(confirmSpy).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[role="dialog"]')).not.toBeNull()

  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
  expect(confirmSpy).toHaveBeenCalledTimes(2)
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  confirmSpy.mockRestore()
})

it('shows accessible inline field errors instead of dialog.alert and focuses first invalid control', async () => {
  const alertSpy = vi.spyOn(dialog, 'alert').mockResolvedValue(undefined)
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))

  const newBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('新建任务'))!
  act(() => newBtn.click())

  const dlg = host.querySelector('[role="dialog"]')!
  const nameInput = dlg.querySelector<HTMLInputElement>('input[placeholder="每日早报"]')!
  const cronInput = dlg.querySelector<HTMLInputElement>('input[placeholder*="分 时 日 月 周"]')!
  const promptInput = dlg.querySelector<HTMLTextAreaElement>('textarea')!
  const saveBtn = Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent?.trim() === '保存')!

  const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!

  // Set invalid cron as well, then submit with blank name and prompt
  act(() => {
    setInput.call(cronInput, 'not-a-cron')
    cronInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { saveBtn.click() })

  expect(alertSpy).not.toHaveBeenCalled()
  expect(api.upsertTaskSchedule).not.toHaveBeenCalled()
  expect(nameInput.getAttribute('aria-invalid')).toBe('true')
  expect(cronInput.getAttribute('aria-invalid')).toBe('true')
  expect(promptInput.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(nameInput)
  expect(dlg.querySelectorAll('[role="alert"]').length).toBeGreaterThanOrEqual(3)

  // Typing clears field-level error
  act(() => {
    setInput.call(nameInput, '日报')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(nameInput.getAttribute('aria-invalid')).toBeNull()

  // Submit again -> focuses invalid cron
  await act(async () => { saveBtn.click() })
  expect(document.activeElement).toBe(cronInput)

  // Fix cron and prompt -> submits cleanly
  act(() => {
    setInput.call(cronInput, '0 8 * * *')
    cronInput.dispatchEvent(new Event('input', { bubbles: true }))
    setTextarea.call(promptInput, '总结今日工作')
    promptInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  vi.mocked(api.upsertTaskSchedule).mockResolvedValueOnce({} as TaskSchedule)
  await act(async () => { saveBtn.click(); await Promise.resolve() })
  expect(api.upsertTaskSchedule).toHaveBeenCalledTimes(1)
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  alertSpy.mockRestore()
})

it('rejects non-integer interval_minutes inline in TaskDialog', async () => {
  act(() => root.render(<QueryClientProvider client={client}><Tasks /></QueryClientProvider>))
  const newBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('新建任务'))!
  act(() => newBtn.click())

  const dlg = host.querySelector('[role="dialog"]')!
  const nameInput = dlg.querySelector<HTMLInputElement>('input[placeholder="每日早报"]')!
  const typeSelect = dlg.querySelector<HTMLSelectElement>('select')!
  const promptInput = dlg.querySelector<HTMLTextAreaElement>('textarea')!
  const saveBtn = Array.from(dlg.querySelectorAll('button')).find((b) => b.textContent?.trim() === '保存')!

  const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  const setTextarea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  act(() => {
    setInput.call(nameInput, '整数校验任务')
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeSelect.value = 'interval'
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    setTextarea.call(promptInput, '检查周期')
    promptInput.dispatchEvent(new Event('input', { bubbles: true }))
  })

  const intervalInput = dlg.querySelector<HTMLInputElement>('input[type="number"]')!
  act(() => {
    setInput.call(intervalInput, '1.5')
    intervalInput.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { saveBtn.click() })

  expect(api.upsertTaskSchedule).not.toHaveBeenCalled()
  expect(intervalInput.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(intervalInput)
  expect(dlg.querySelector('[role="alert"]')?.textContent).toContain('整数')
})
