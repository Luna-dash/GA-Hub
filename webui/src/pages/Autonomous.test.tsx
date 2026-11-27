// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/queries/queryKeys'
import { dialog } from '@/stores/dialogStore'
import { useToastStore } from '@/stores/toastStore'
import Autonomous from './Autonomous'

const apiMock = vi.hoisted(() => ({
  schedules: vi.fn(),
  runs: vi.fn(),
  reports: vi.fn(),
  report: vi.fn(),
  upsertSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  triggerSchedule: vi.fn(),
}))

vi.mock('@/hooks/useHubEvent', () => ({ useHubEvent: vi.fn() }))
vi.mock('@/api/client', () => ({ api: apiMock }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Autonomous schedule dialog & report drawer', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    apiMock.schedules.mockResolvedValue({
      schedules: [{
        id: 'sch-1', name: '空闲反思', type: 'idle', idle_minutes: 30,
        cron: '', interval_minutes: 60, enabled: false, fire_count: 0, last_fired_at: 0,
      }],
    })
    apiMock.runs.mockResolvedValue({ runs: [] })
    apiMock.reports.mockResolvedValue({ reports: [{ name: 'rep-1.md', size: 120, mtime: 1 }] })
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    host.remove()
  })

  const renderPage = async () => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <Autonomous />
      </QueryClientProvider>,
    ))
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
  }

  const button = (text: string, scope: ParentNode = host) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)!

  it('uses readable disabled badge styling and validates/locks schedule saves', async () => {
    const alertSpy = vi.spyOn(dialog, 'alert').mockResolvedValue(undefined)
    let resolveSave!: () => void
    apiMock.upsertSchedule.mockImplementation(() => new Promise<void>((resolve) => { resolveSave = resolve }))

    await renderPage()
    const disabledPill = Array.from(host.querySelectorAll('span')).find((s) => s.textContent === '禁用')!
    expect(disabledPill.className).not.toContain('bg-slate-700')
    expect(disabledPill.className).toContain('text-ink-muted')

    await act(async () => button('新建计划').click())
    const dlg = host.querySelector('[role="dialog"]')!
    const numInput = dlg.querySelector<HTMLInputElement>('input[type="number"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numInput, '0')
      numInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('保存', dlg).click())
    expect(alertSpy).not.toHaveBeenCalled()
    expect(numInput.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(numInput)
    expect(dlg.querySelector('[role="alert"]')?.textContent).toContain('空闲时间无效')
    expect(apiMock.upsertSchedule).not.toHaveBeenCalled()

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numInput, '15')
      numInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(numInput.getAttribute('aria-invalid')).toBeNull()
    expect(dlg.querySelector('[role="alert"]')).toBeNull()
    await act(async () => button('保存', dlg).click())
    expect(apiMock.upsertSchedule).toHaveBeenCalledTimes(1)
    const savingBtn = button('保存中…', dlg)
    expect(savingBtn.disabled).toBe(true)
    await act(async () => savingBtn.click())
    expect(apiMock.upsertSchedule).toHaveBeenCalledTimes(1)

    await act(async () => { resolveSave(); await Promise.resolve() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    alertSpy.mockRestore()
  })

  it('shows loading and error retry states inside ReportDrawer', async () => {
    let rejectReport!: (err: Error) => void
    apiMock.report.mockImplementationOnce(() => new Promise((_, reject) => { rejectReport = reject }))

    await renderPage()
    await act(async () => button('rep-1.md').click())
    const dlg = host.querySelector('[role="dialog"]')!
    expect(dlg.textContent).toContain('正在读取报告…')

    await act(async () => { rejectReport(new Error('file missing')); await new Promise((r) => setTimeout(r, 20)) })
    expect(dlg.querySelector('[role="alert"]')?.textContent).toContain('报告加载失败：file missing')

    apiMock.report.mockResolvedValueOnce({ content: '# 报告正文' })
    await act(async () => { button('重试', dlg).click(); await new Promise((r) => setTimeout(r, 20)) })
    expect(dlg.textContent).toContain('报告正文')
  })

  it('shows compact header status pills, resolves schedule names, and paginates run history', async () => {
    apiMock.runs.mockResolvedValue({
      runs: Array.from({ length: 12 }, (_, idx) => ({
        id: `run-${idx + 1}`,
        schedule_id: 'sch-1',
        fired_at: 1_700_000_000 - idx * 60,
        prompt_preview: `进化提示 ${idx + 1}`,
        report_paths: [],
      })),
    })

    await renderPage()
    const summary = host.querySelector('[aria-label="自主进化概览"]')
    expect(summary?.textContent).toContain('已启用 0/1')
    expect(summary?.textContent).toContain('触发 0 次')
    expect(summary?.textContent).toContain('报告 1 份')
    expect(host.querySelector('[aria-label="运行概览"]')).toBeNull()

    const rows = host.querySelectorAll('tbody tr')
    expect(rows).toHaveLength(10)
    expect(rows[0].textContent).toContain('空闲反思')

    const pager = host.querySelector('nav[aria-label="触发历史分页"]')
    expect(pager?.textContent).toContain('第 1 / 2 页')
    await act(async () => {
      pager!.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')!.click()
    })
    expect(host.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(pager?.textContent).toContain('第 2 / 2 页')
  })

  it('extracts filenames from both Windows backslash and POSIX report paths', async () => {
    apiMock.runs.mockResolvedValue({
      runs: [{
        id: 'run-win',
        schedule_id: 'sch-1',
        fired_at: 1_700_000_000,
        prompt_preview: '跨平台路径测试',
        report_paths: ['C:\\Users\\demo\\reports\\win-report.md', '/tmp/reports/unix-report.md'],
      }],
    })
    apiMock.report.mockResolvedValue({ content: '# Windows 报告' })

    await renderPage()
    const winBtn = button('win-report.md')
    expect(winBtn).toBeDefined()
    expect(button('unix-report.md')).toBeDefined()

    await act(async () => { winBtn.click(); await new Promise((r) => setTimeout(r, 20)) })
    expect(apiMock.report).toHaveBeenCalledWith('win-report.md')
  })

  it('locks ScheduleCard buttons against rapid double-clicks during toggle, triggerNow, and delete', async () => {
    let resolveToggle!: () => void
    let resolveFire!: () => void
    let resolveDelete!: () => void
    apiMock.upsertSchedule.mockImplementation(() => new Promise<void>((resolve) => { resolveToggle = resolve }))
    apiMock.triggerSchedule.mockImplementation(() => new Promise<void>((resolve) => { resolveFire = resolve }))
    apiMock.deleteSchedule.mockImplementation(() => new Promise<void>((resolve) => { resolveDelete = resolve }))
    vi.spyOn(dialog, 'confirm').mockResolvedValue(true)

    await renderPage()

    // 1. Toggle double-click guard
    const toggleBtn = button('启用')
    await act(async () => {
      toggleBtn.click()
      toggleBtn.click()
    })
    expect(apiMock.upsertSchedule).toHaveBeenCalledTimes(1)
    expect(button('启用中…').disabled).toBe(true)
    expect(button('立即触发').disabled).toBe(true)
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="删除计划"]')!.disabled).toBe(true)
    await act(async () => { resolveToggle(); await Promise.resolve() })
    expect(button('立即触发').disabled).toBe(false)

    // 2. Trigger double-click guard
    const fireBtn = button('立即触发')
    await act(async () => { fireBtn.click() })
    await act(async () => { fireBtn.click() })
    expect(apiMock.triggerSchedule).toHaveBeenCalledTimes(1)
    expect(button('触发中…').disabled).toBe(true)
    await act(async () => { resolveFire(); await Promise.resolve() })
    expect(button('立即触发').disabled).toBe(false)

    // 3. Delete double-click guard
    const delBtn = host.querySelector<HTMLButtonElement>('button[aria-label="删除计划"]')!
    await act(async () => {
      delBtn.click()
      delBtn.click()
    })
    await act(async () => { await Promise.resolve() })
    expect(apiMock.deleteSchedule).toHaveBeenCalledTimes(1)
    expect(button('立即触发').disabled).toBe(true)
    await act(async () => { resolveDelete(); await Promise.resolve() })
  })

  it('ignores backdrop clicks in ScheduleDialog and confirms dirty close', async () => {
    await renderPage()
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await act(async () => button('新建计划').click())
    const dlg = host.querySelector('[role="dialog"]')!
    act(() => { dlg.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    // Clean cancel closes immediately
    await act(async () => button('取消', dlg).click())
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(confirmSpy).not.toHaveBeenCalled()

    // Reopen, edit name, and verify dirty-close prompt
    await act(async () => button('新建计划').click())
    const nameInput = host.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="人类可读的备注"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, '草稿计划')
      nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      button('取消').click()
      await Promise.resolve()
    })
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    await act(async () => {
      button('取消').click()
      await Promise.resolve()
    })
    expect(confirmSpy).toHaveBeenCalledTimes(2)
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    confirmSpy.mockRestore()
  })

  it('routes schedule mutation successes and transient API errors to toast without blocking dialog alerts', async () => {
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockResolvedValue(true)
    const alertSpy = vi.spyOn(dialog, 'alert').mockResolvedValue(undefined)
    apiMock.upsertSchedule.mockResolvedValueOnce({} as never).mockRejectedValueOnce(new Error('toggle oops'))
    apiMock.triggerSchedule.mockResolvedValueOnce({} as never)
    apiMock.deleteSchedule.mockResolvedValueOnce({} as never)

    await renderPage()

    await act(async () => { button('启用').click(); await Promise.resolve() })
    expect(useToastStore.getState().items.some(t => t.kind === 'success' && t.message === '已启用计划')).toBe(true)

    await act(async () => { button('启用').click(); await Promise.resolve() })
    expect(useToastStore.getState().items.some(t => t.kind === 'error' && t.message === 'toggle oops')).toBe(true)

    await act(async () => { button('立即触发').click(); await Promise.resolve() })
    expect(useToastStore.getState().items.some(t => t.kind === 'success' && t.message === '已触发自主任务')).toBe(true)

    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="删除计划"]')!.click(); await Promise.resolve() })
    expect(useToastStore.getState().items.some(t => t.kind === 'success' && t.message === '已删除计划')).toBe(true)
    expect(alertSpy).not.toHaveBeenCalled()

    confirmSpy.mockRestore()
    alertSpy.mockRestore()
  })
})
