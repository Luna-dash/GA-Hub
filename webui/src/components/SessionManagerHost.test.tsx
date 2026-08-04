// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubSession, SessionRuntime } from '@/api/types'
import { useSessionManagerStore } from '@/stores/sessionManagerStore'
import { SessionManagerHost } from './SessionManagerHost'

const apiMock = vi.hoisted(() => ({
  sessions: vi.fn(),
  sessionRuntime: vi.fn(),
  abortSession: vi.fn(),
  createSession: vi.fn(),
  updateSession: vi.fn(),
  deleteSession: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sessions: HubSession[] = [
  {
    id: 'session-active',
    title: '运行会话',
    llm_index: null,
    archive_path: null,
    created_at: '2026-08-04T10:00:00Z',
    updated_at: '2026-08-04T10:00:00Z',
  },
  {
    id: 'session-idle',
    title: '空闲会话',
    llm_index: null,
    archive_path: null,
    created_at: '2026-08-04T11:00:00Z',
    updated_at: '2026-08-04T11:00:00Z',
  },
]

const runtime = (sessionId: string, status: string): SessionRuntime => ({
  session_id: sessionId,
  status,
  run_id: status === 'running' ? `run-${sessionId}` : null,
  stream_id: status === 'running' ? `stream-${sessionId}` : null,
})

let root: Root | null = null
let container: HTMLDivElement | null = null
let locationText = ''

function LocationProbe() {
  const location = useLocation()
  locationText = `${location.pathname}${location.search}`
  return null
}

function renderHost() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <SessionManagerHost />
          <LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  })
}

async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    if (predicate()) return
  }
  throw new Error(`UI did not settle: ${container?.textContent ?? '<unmounted>'}`)
}

function button(label: string) {
  return Array.from(container?.querySelectorAll('button') ?? []).find((item) => item.textContent === label) as HTMLButtonElement | undefined
}

beforeEach(() => {
  apiMock.sessions.mockResolvedValue({ total: sessions.length, items: sessions })
  apiMock.sessionRuntime.mockImplementation(async (id: string) => runtime(id, id === 'session-active' ? 'running' : 'idle'))
  apiMock.abortSession.mockReset()
  apiMock.createSession.mockReset()
  apiMock.updateSession.mockReset().mockImplementation(async (id: string, changes: Partial<HubSession>) => ({ ...sessions.find((item) => item.id === id)!, ...changes }))
  apiMock.deleteSession.mockReset().mockResolvedValue(undefined)
  localStorage.clear()
  locationText = ''
  useSessionManagerStore.setState({ open: false, conflict: null })
})

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  vi.clearAllMocks()
})

describe('SessionManagerHost interactions', () => {
  it('opens on demand, renders each runtime, and highlights the session from a 409 conflict', async () => {
    renderHost()
    expect(container?.querySelector('[role="dialog"]')).toBeNull()

    act(() => useSessionManagerStore.getState().show({
      message: '容量已满',
      activeSessionId: 'session-active',
      activeRunId: 'run-session-active',
      capacity: 1,
      activeCount: 1,
    }))

    await settle(() => container?.textContent?.includes('运行中') === true && container?.textContent?.includes('空闲') === true)
    expect(container?.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('会话管理')
    expect(apiMock.sessions).toHaveBeenCalledTimes(1)
    expect(apiMock.sessionRuntime.mock.calls.map(([id]) => id)).toEqual(['session-active', 'session-idle'])
    expect(container?.textContent).toContain('并发容量已满（1/1）')
    const activeCard = Array.from(container?.querySelectorAll('article') ?? []).find((item) => item.textContent?.includes('session-active'))
    expect(activeCard?.className).toContain('ring-1')
  })

  it('calls abort, renders its terminal runtime, and restores the action after a failed retry', async () => {
    renderHost()
    act(() => useSessionManagerStore.getState().show())
    await settle(() => button('停止') != null)

    let resolveAbort!: (value: SessionRuntime) => void
    apiMock.abortSession.mockImplementationOnce(() => new Promise((resolve) => { resolveAbort = resolve }))
    act(() => button('停止')?.click())
    expect(apiMock.abortSession).toHaveBeenCalledWith('session-active')
    expect(button('停止中…')?.disabled).toBe(true)

    await act(async () => resolveAbort(runtime('session-active', 'idle')))
    await settle(() => container?.textContent?.includes('停止中…') === false)
    expect(container?.textContent).toContain('空闲')
    expect(button('停止')).toBeUndefined()

    // Reopening the host performs its documented runtime inspection again. A
    // rejected abort must expose the error and restore the enabled stop action.
    act(() => useSessionManagerStore.getState().close())
    act(() => useSessionManagerStore.getState().show())
    await settle(() => button('停止') != null)
    apiMock.abortSession.mockRejectedValueOnce({ body: { detail: '停止失败，请重试' } })
    act(() => button('停止')?.click())
    await settle(() => container?.textContent?.includes('停止失败，请重试') === true)
    expect(button('停止')?.disabled).toBe(false)
  })

  it('filters, renames, confirms idle deletion, and protects the active session', async () => {
    renderHost()
    act(() => useSessionManagerStore.getState().show())
    await settle(() => container?.textContent?.includes('空闲会话') === true)

    const search = container?.querySelector('#session-search') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(search, '空闲')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(() => container?.querySelectorAll('article').length === 1)
    expect(container?.textContent).not.toContain('运行会话')

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(search, '')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle(() => container?.querySelectorAll('article').length === 2)
    const cards = () => Array.from(container?.querySelectorAll('article') ?? [])
    const activeCard = cards().find((item) => item.textContent?.includes('session-active'))!
    const idleCard = cards().find((item) => item.textContent?.includes('session-idle'))!
    const activeDelete = Array.from(activeCard.querySelectorAll('button')).find((item) => item.textContent === '删除') as HTMLButtonElement
    expect(activeDelete.disabled).toBe(true)
    expect(activeDelete.title).toContain('先停止')

    const rename = Array.from(idleCard.querySelectorAll('button')).find((item) => item.textContent === '重命名') as HTMLButtonElement
    act(() => rename.click())
    const title = idleCard.querySelector('input[aria-label="会话标题"]') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(title, '已重命名会话')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => (Array.from(idleCard.querySelectorAll('button')).find((item) => item.textContent === '保存') as HTMLButtonElement).click())
    await settle(() => apiMock.updateSession.mock.calls.length === 1)
    expect(apiMock.updateSession).toHaveBeenCalledWith('session-idle', { title: '已重命名会话' })

    const refreshedIdle = cards().find((item) => item.textContent?.includes('session-idle'))!
    act(() => (Array.from(refreshedIdle.querySelectorAll('button')).find((item) => item.textContent === '删除') as HTMLButtonElement).click())
    expect(refreshedIdle.querySelector('[role="alertdialog"]')).not.toBeNull()
    expect(apiMock.deleteSession).not.toHaveBeenCalled()
    act(() => (Array.from(refreshedIdle.querySelectorAll('button')).find((item) => item.textContent === '确认删除') as HTMLButtonElement).click())
    await settle(() => apiMock.deleteSession.mock.calls.length === 1)
    expect(apiMock.deleteSession).toHaveBeenCalledWith('session-idle')
    expect(refreshedIdle.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('opens a selected session by persisting it, navigating, and closing the modal', async () => {
    renderHost()
    act(() => useSessionManagerStore.getState().show())
    await settle(() => container?.textContent?.includes('空闲会话') === true)

    const idleCard = Array.from(container?.querySelectorAll('article') ?? []).find((item) => item.textContent?.includes('session-idle'))
    const open = Array.from(idleCard?.querySelectorAll('button') ?? []).find((item) => item.textContent === '打开') as HTMLButtonElement
    act(() => open.click())

    expect(localStorage.getItem('gahub.currentSessionId')).toBe('session-idle')
    expect(locationText).toBe('/chat?session=session-idle')
    expect(useSessionManagerStore.getState()).toMatchObject({ open: false, conflict: null })
    expect(container?.querySelector('[role="dialog"]')).toBeNull()
  })
})
