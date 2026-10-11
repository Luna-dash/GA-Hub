// @vitest-environment jsdom

import { act, forwardRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LiveChat from './LiveChat'
import { api } from '@/api/client'
import { applyEvent, useChatStore } from '@/stores/chatStore'
import { useDraftStore } from '@/stores/draftStore'
import { storageKeys } from '@/config/storageKeys'
import { queryKeys } from '@/queries/queryKeys'

type CreatedSession = Awaited<ReturnType<typeof api.createSession>>
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/api/client', () => ({ api: {
  sessions: vi.fn(), llms: vi.fn(), projects: vi.fn(), sessionRuntimes: vi.fn(), sessionRuntime: vi.fn(),
  scheduledChats: vi.fn(), createSession: vi.fn(), sessionRun: vi.fn(),
} }))
vi.mock('@/hooks/useHubEvent', () => ({ useHubEvent: vi.fn() }))
vi.mock('@/components/PageShell', () => ({ PageShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }))
vi.mock('@/components/SessionRail', () => ({ SessionRail: ({ onCreate }: { onCreate: () => void }) => <button data-create onClick={onCreate}>Create</button> }))
vi.mock('@/components/ModelSelect', () => ({ MainModelSelect: () => null }))
vi.mock('@/components/LiveChatTranscript', () => ({ LiveChatTranscript: forwardRef(() => null) }))
vi.mock('@/components/LiveChatComposer', () => ({
  LiveChatComposer: ({ draftKey, onSubmit, onSlashCommand }: {
    draftKey: string
    onSubmit: (draft: { draftKey: string; text: string; attachments: [] }) => void
    onSlashCommand: (command: '/new', draft: { draftKey: string; text: string; attachments: [] }) => void
  }) => <>
    <button data-submit onClick={() => onSubmit({ draftKey, text: 'hello', attachments: [] })}>Send</button>
    <button data-slash onClick={() => onSlashCommand('/new', { draftKey, text: '/new', attachments: [] })}>New</button>
  </>,
  readLiveChatDraftSnapshot: vi.fn(),
}))

function row(id: string): CreatedSession {
  return { id, title: id, kind: 'chat', status: 'idle', archive_path: null, llm_key: 'model', llm_index: 0, project_path: null, created_at: '', updated_at: '' }
}
function Navigation() {
  const location = useLocation()
  const navigate = useNavigate()
  return <>
    <output>{location.pathname}{location.search}</output>
    <button data-leave onClick={() => navigate('/settings')}>Leave</button>
  </>
}

// Keep the real page, stores and router. Only network,
// WebSocket side effects and the unrelated visual subcomponents are stubbed.
describe('LiveChat draft submissions', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient
  let finish: (session: CreatedSession) => void

  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    vi.spyOn(useChatStore.getState(), 'start').mockImplementation((id) => {
      useChatStore.setState({ sessionId: id })
    })
    vi.spyOn(useChatStore.getState(), 'teardown').mockImplementation(() => {
      useChatStore.setState({ sessionId: null })
    })
    useChatStore.setState({ sessionId: null, msgs: [], streaming: false, retryPending: false })
    useDraftStore.setState({ texts: {}, attachments: {}, revisions: {}, submissions: {} })
    vi.mocked(api.sessions).mockResolvedValue({ total: 1, items: [row('old')] })
    vi.mocked(api.llms).mockResolvedValue({ llms: [{ key: 'model', index: 0, name: 'Model', current: true }] } as Awaited<ReturnType<typeof api.llms>>)
    vi.mocked(api.projects).mockResolvedValue({ total: 0, items: [] })
    vi.mocked(api.sessionRuntimes).mockResolvedValue({})
    vi.mocked(api.sessionRuntime).mockResolvedValue({} as Awaited<ReturnType<typeof api.sessionRuntime>>)
    vi.mocked(api.scheduledChats).mockResolvedValue({ total: 0, items: [] })
    vi.mocked(api.createSession).mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    client.clear()
    vi.restoreAllMocks()
  })

  async function mount(empty = false) {
    if (empty) vi.mocked(api.sessions).mockResolvedValue({ total: 0, items: [] })
    else localStorage.setItem(storageKeys.currentSessionId, 'old')
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[empty ? '/chat' : '/chat?session=old']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Navigation />
          <Routes>
            <Route path="/chat" element={<LiveChat />} />
            <Route path="/settings" element={<div>Settings</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ))
  }
  async function click(selector: string) {
    await act(async () => (host.querySelector(selector) as HTMLButtonElement).click())
  }

  async function sendExisting() {
    await mount()
    act(() => useDraftStore.getState().setText('liveChat:old', 'hello'))
    await click('[data-submit]')
  }
  const rejection = () => Object.assign(new Error('refused'), { status: 409 })

  it('clears immediately while HTTP is pending and never clears a subsequent draft on success', async () => {
    let done!: (result: Awaited<ReturnType<typeof api.sessionRun>>) => void
    vi.mocked(api.sessionRun).mockImplementation(() => new Promise((resolve) => { done = resolve }))
    await sendExisting()
    expect(useDraftStore.getState().texts['liveChat:old'] ?? '').toBe('')
    act(() => useDraftStore.getState().setText('liveChat:old', 'next'))
    await click('[data-submit]')
    expect(api.sessionRun).toHaveBeenCalledOnce()
    await act(async () => done({} as Awaited<ReturnType<typeof api.sessionRun>>))
    expect(useDraftStore.getState().texts['liveChat:old']).toBe('next')
    expect(useDraftStore.getState().submissions).toEqual({})
  })

  it('restores an unchanged draft on an explicit refusal', async () => {
    vi.mocked(api.sessionRun).mockRejectedValue(rejection())
    await sendExisting()
    expect(useDraftStore.getState().texts['liveChat:old']).toBe('hello')
    expect(useChatStore.getState().msgs.some((m) => m.pendingWebui)).toBe(false)
  })

  it('does not overwrite a newer draft when a refusal arrives late', async () => {
    let reject!: (error: Error) => void
    vi.mocked(api.sessionRun).mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    await sendExisting()
    act(() => useDraftStore.getState().setText('liveChat:old', 'next'))
    await act(async () => reject(rejection()))
    expect(useDraftStore.getState().texts['liveChat:old']).toBe('next')
    expect(Object.values(useDraftStore.getState().submissions)[0].status).toBe('failed')
  })

  it('restores only the original session draft when the request fails after leaving', async () => {
    let reject!: (error: Error) => void
    vi.mocked(api.sessionRun).mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    await sendExisting()
    await click('[data-leave]')
    await act(async () => reject(rejection()))
    expect(host.querySelector('output')?.textContent).toBe('/settings')
    expect(useDraftStore.getState().texts['liveChat:old']).toBe('hello')
    expect(useDraftStore.getState().texts['liveChat:pending'] ?? '').toBe('')
  })

  it.each(['before', 'after'])('WS receipt %s HTTP failure suppresses false recovery', async (order) => {
    let reject!: (error: Error) => void
    vi.mocked(api.sessionRun).mockImplementation(() => new Promise((_, fail) => { reject = fail }))
    await sendExisting()
    const receipt = () => useChatStore.setState((state) => ({
      msgs: applyEvent(state.msgs, { type: 'started', stream_id: 'accepted', source: 'webui', query: 'hello' }),
    }))
    if (order === 'before') act(receipt)
    await act(async () => reject(new Error('network')))
    if (order === 'after') {
      expect(Object.values(useDraftStore.getState().submissions)[0].status).toBe('uncertain')
      act(receipt)
    }
    expect(useDraftStore.getState().submissions).toEqual({})
    expect(useDraftStore.getState().texts['liveChat:old'] ?? '').toBe('')
    expect(useChatStore.getState().msgs.some((m) => m.streamId === 'accepted')).toBe(true)
  })

  it('preserves the new pending draft while a first-send creates its session', async () => {
    await mount(true)
    act(() => useDraftStore.getState().setText('liveChat:pending', 'hello'))
    await click('[data-submit]')
    expect(useDraftStore.getState().texts['liveChat:pending'] ?? '').toBe('')
    act(() => useDraftStore.getState().setText('liveChat:pending', 'next'))
    vi.mocked(api.sessionRun).mockRejectedValue(rejection())
    await act(async () => finish(row('new')))
    expect(useDraftStore.getState().texts['liveChat:pending']).toBe('next')
    expect(useDraftStore.getState().texts['liveChat:new']).toBe('hello')
  })

})
