// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from './CommandPalette'
import { useChatStore } from '@/stores/chatStore'
import { storageKeys } from '@/config/storageKeys'
import { queryKeys } from '@/queries/queryKeys'
import type { SessionListData } from '@/queries/sessions'

const api = vi.hoisted(() => ({
  llms: vi.fn(), schedules: vi.fn(), sops: vi.fn(), conversations: vi.fn(),
  sessions: vi.fn(), createSession: vi.fn(),
  agentNew: vi.fn(), // regression tripwire for the removed legacy endpoint
}))
const dialog = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn() }))
vi.mock('@/api/client', () => ({ api, ChatSocket: vi.fn() }))
vi.mock('@/stores/dialogStore', () => ({ dialog }))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function row(id: string) {
  return {
    id, title: id, llm_key: 'session-model', llm_index: null, archive_path: null,
    created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
  }
}

function LocationProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return <>
    <output>{location.pathname}{location.search}</output>
    <button data-nav="leave" onClick={() => navigate('/settings')}>Leave</button>
    <button data-nav="back" onClick={() => navigate(-1)}>Back</button>
  </>
}

describe('command palette new conversation', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(async () => {
    vi.resetAllMocks()
    localStorage.clear()
    localStorage.setItem(storageKeys.currentSessionId, 'old')
    Element.prototype.scrollIntoView = vi.fn()
    useChatStore.setState({ sessionId: 'old', msgs: [{ role: 'user', content: 'previous conversation' }] })
    api.llms.mockResolvedValue({ llms: [
      { key: 'global-model', index: 0, name: 'Global', current: true },
      { key: 'session-model', index: 1, name: 'Session', current: false },
    ] })
    api.schedules.mockResolvedValue({ schedules: [] })
    api.sops.mockResolvedValue({ sops: [] })
    api.conversations.mockResolvedValue({ items: [] })
    api.sessions.mockResolvedValue({ total: 1, items: [row('old')] })
    api.createSession.mockResolvedValue(row('new'))
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/chat?session=old']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <CommandPalette /><LocationProbe />
        </MemoryRouter>
      </QueryClientProvider>,
    ))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    client.clear()
    useChatStore.setState({ sessionId: null, msgs: [] })
    vi.restoreAllMocks()
  })

  async function newConversation() {
    await act(async () => { window.dispatchEvent(new Event('gahub:command-palette')) })
    const button = Array.from(host.querySelectorAll('button')).find((item) => item.textContent?.includes('新对话'))!
    expect(button).toBeDefined()
    await act(async () => button.click())
  }

  it('uses the current session model, selects the new session, and preserves old history', async () => {
    const previous = useChatStore.getState().msgs
    await newConversation()
    expect(api.createSession).toHaveBeenCalledWith({ title: '', llm_key: 'session-model' })
    expect(api.agentNew).not.toHaveBeenCalled()
    expect(host.querySelector('output')?.textContent).toBe('/chat?session=new')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('new')
    expect(useChatStore.getState().msgs).toEqual(previous)
    expect(client.getQueryData<SessionListData>(queryKeys.sessions)?.items.map((item) => item.id)).toEqual(['new', 'old'])
  })

  it('leaves the old conversation selected and visible when the API refuses creation', async () => {
    api.createSession.mockRejectedValue(new Error('core unavailable'))
    await newConversation()
    expect(host.querySelector('output')?.textContent).toBe('/chat?session=old')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('old')
    expect(useChatStore.getState().msgs[0].content).toBe('previous conversation')
    expect(dialog.alert).toHaveBeenCalledWith('操作失败', 'core unavailable')
  })

  it.each([false, true])('does not steal navigation after leaving (back=%s)', async (back) => {
    let finish!: (value: ReturnType<typeof row>) => void
    api.createSession.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await newConversation()
    await act(async () => (host.querySelector('[data-nav="leave"]') as HTMLButtonElement).click())
    if (back) await act(async () => (host.querySelector('[data-nav="back"]') as HTMLButtonElement).click())
    const expected = back ? '/chat?session=old' : '/settings'
    expect(host.querySelector('output')?.textContent).toBe(expected)
    await act(async () => finish(row('new')))
    expect(host.querySelector('output')?.textContent).toBe(expected)
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('old')
    expect(client.getQueryData<SessionListData>(queryKeys.sessions)?.items[0].id).toBe('new')
  })

  it('does not regain selection permission after switching away and back in one tick', async () => {
    let finish!: (value: ReturnType<typeof row>) => void
    api.createSession.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await newConversation()
    await act(async () => {
      useChatStore.setState({ sessionId: 'other' })
      useChatStore.setState({ sessionId: 'old' })
    })
    await act(async () => finish(row('new')))
    expect(host.querySelector('output')?.textContent).toBe('/chat?session=old')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('old')
    expect(client.getQueryData<SessionListData>(queryKeys.sessions)?.items[0].id).toBe('new')
  })

  it('updates the cache but not selection after unmount', async () => {
    let finish!: (value: ReturnType<typeof row>) => void
    api.createSession.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await newConversation()
    await act(async () => root.render(null))
    await act(async () => finish(row('new')))
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('old')
    expect(client.getQueryData<SessionListData>(queryKeys.sessions)?.items[0].id).toBe('new')
  })

  it('does not replace a different session selected during the create request', async () => {
    let finish!: (value: ReturnType<typeof row>) => void
    api.createSession.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await newConversation()
    await act(async () => useChatStore.setState({ sessionId: 'other' }))
    localStorage.setItem(storageKeys.currentSessionId, 'other')
    await act(async () => finish(row('new')))
    expect(host.querySelector('output')?.textContent).toBe('/chat?session=old')
    expect(localStorage.getItem(storageKeys.currentSessionId)).toBe('other')
    expect(client.getQueryData<SessionListData>(queryKeys.sessions)?.items[0].id).toBe('new')
  })
})
