// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '@/queries/queryKeys'
import { dialog } from '@/stores/dialogStore'
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
    expect(alertSpy).toHaveBeenCalledWith('空闲时间无效', expect.any(String))
    expect(apiMock.upsertSchedule).not.toHaveBeenCalled()

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(numInput, '15')
      numInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
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
})
