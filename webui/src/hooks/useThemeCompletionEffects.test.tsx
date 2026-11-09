// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useThemeCompletionEffects } from './useThemeCompletionEffects'
import { hasUnreadThemeCompletions, readThemeCompletion } from '@/stores/themeCompletionStore'
import type { ThemeRun } from '@/api/types'
const mocks = vi.hoisted(() => ({ sessions: vi.fn(), run: vi.fn(), runtime: null as any, state: null as any, control: null as any }))
vi.mock('@/api/client', () => ({ api: { sessions: mocks.sessions, themeRun: mocks.run } }))
vi.mock('@/runtime/hubEventClient', () => ({ hubEventClient: {
  subscribe: (_: string, fn: any) => { mocks.runtime = fn; return vi.fn() },
  subscribeState: (fn: any) => { mocks.state = fn; return vi.fn() },
  subscribeControl: (fn: any) => { mocks.control = fn; return vi.fn() },
} }))
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
const completed: ThemeRun = { session_id: 's', run_id: 'r', started_at: 1, finished_at: 2, turns: 1, model_key: null, model_name: null, outcome: 'completed', report: 'done' }
let root: Root, host: HTMLDivElement
function Harness() { useThemeCompletionEffects(); return null }
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 10)) })
beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks()
  mocks.sessions.mockResolvedValue({ items: [{ id: 's', theme_task: true }, { id: 'chat', theme_task: false }] })
  mocks.run.mockResolvedValue({ run: null })
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove() })
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
  await flush()
}
it('recovers completed tasks at startup, preserves read state across reconnect and ignores ordinary chats', async () => {
  mocks.run.mockResolvedValue({ run: completed })
  await mount()
  expect(hasUnreadThemeCompletions()).toBe(true)
  expect(mocks.run).toHaveBeenCalledTimes(1)
  readThemeCompletion('s', completed)
  mocks.state('open'); await flush()
  expect(hasUnreadThemeCompletions()).toBe(false)
  mocks.runtime({ payload: { session_id: 'chat', runtime: { status: 'completed', completed_run_id: 'r' } } }); await flush()
  expect(mocks.run).toHaveBeenCalledTimes(2)
})
it('lights on a terminal event outside the theme page, and ignores running events', async () => {
  await mount()
  mocks.runtime({ payload: { session_id: 's', runtime: { status: 'running' } } }); await flush()
  expect(mocks.run).toHaveBeenCalledTimes(1)
  mocks.run.mockResolvedValue({ run: completed })
  mocks.runtime({ payload: { session_id: 's', runtime: { status: 'completed', completed_run_id: 'r' } } }); await flush()
  expect(hasUnreadThemeCompletions()).toBe(true)
})
it('reconciles after resync and does not mark failed or interrupted runs', async () => {
  await mount()
  mocks.run.mockResolvedValue({ run: { ...completed, outcome: 'failed' } })
  mocks.control({ type: 'resync_required' }); await flush()
  expect(hasUnreadThemeCompletions()).toBe(false)
  mocks.run.mockResolvedValue({ run: { ...completed, interrupted: true } })
  mocks.state('open'); await flush()
  expect(hasUnreadThemeCompletions()).toBe(false)
})

it('clears unread when a task is moved out and session data refreshes', async () => {
  mocks.run.mockResolvedValue({ run: completed })
  await mount()
  expect(hasUnreadThemeCompletions()).toBe(true)
  mocks.sessions.mockResolvedValue({ items: [{ id: 's', theme_task: null }] })
  await new Promise(r => setTimeout(r, 1050))
  mocks.state('open'); await flush()
  expect(hasUnreadThemeCompletions()).toBe(false)
})
it('refetches a completion arriving while an older run lookup is pending', async () => {
  let resolve!: (value: { run: null }) => void
  mocks.run.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  await mount()
  mocks.run.mockResolvedValue({ run: completed })
  mocks.runtime({ payload: { session_id: 's', runtime: { status: 'completed', completed_run_id: 'r' } } })
  await flush()
  resolve({ run: null }); await flush()
  expect(hasUnreadThemeCompletions()).toBe(true)
  expect(mocks.run).toHaveBeenCalledTimes(2)
})
