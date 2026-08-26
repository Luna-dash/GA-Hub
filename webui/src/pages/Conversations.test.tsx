// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Conversations from './Conversations'
import { resetPageState } from '@/utils/pageState'

const apiMock = vi.hoisted(() => ({
  conversations: vi.fn(),
  conversation: vi.fn(),
  deleteConversation: vi.fn(),
  exportConversation: vi.fn(),
  restoreConversation: vi.fn(),
  updateConversation: vi.fn(),
}))
const dialogMock = vi.hoisted(() => ({
  alert: vi.fn(),
  confirm: vi.fn(),
  prompt: vi.fn(),
}))

vi.mock('@/api/client', () => ({ api: apiMock }))
vi.mock('@/components/PageShell', () => ({
  PageShell: ({ actions, children }: { actions?: ReactNode; children: ReactNode }) => (
    <div>{actions}{children}</div>
  ),
}))
vi.mock('@/components/ConversationIndexRail', () => ({
  ConversationIndexRail: ({ children }: { children: (collapsed: boolean) => ReactNode }) => (
    <div>{children(false)}</div>
  ),
}))
vi.mock('@/components/MarkdownView', () => ({
  MarkdownView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('@/utils/desktop', () => ({
  saveTextExport: vi.fn(),
}))
vi.mock('@/stores/dialogStore', () => ({
  dialog: dialogMock,
}))
vi.mock('@/stores/toastStore', () => ({
  toast: { success: vi.fn() },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function LocationProbe() {
  const location = useLocation()
  return <output data-route-path>{location.pathname}</output>
}

function Harness({ initialEntry, client }: { initialEntry: string; client: QueryClient }) {
  const page = (
    <>
      <Conversations />
      <LocationProbe />
    </>
  )
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/conversations" element={page} />
          <Route path="/conversations/:id" element={page} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )
}

describe('conversation route selection', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    resetPageState()
    apiMock.conversations.mockReset().mockResolvedValue({
      total: 1,
      offset: 0,
      limit: 50,
      items: [{
        id: 'alpha beta',
        title: 'Alpha conversation',
        message_count: 1,
        last_user_preview: 'hello',
        original_user_preview: 'hello',
      }],
    })
    apiMock.conversation.mockReset().mockImplementation(async (id: string) => ({
      id,
      title: `Detail ${id}`,
      messages: [{ role: 'user', content: `message for ${id}` }],
    }))
    apiMock.deleteConversation.mockReset().mockResolvedValue({ ok: true, id: 'alpha beta' })
    dialogMock.alert.mockReset()
    dialogMock.confirm.mockReset().mockResolvedValue(true)
    dialogMock.prompt.mockReset()
    client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    client.clear()
    host.remove()
  })

  async function renderAt(path: string) {
    await act(async () => {
      root.render(<Harness initialEntry={path} client={client} />)
      await Promise.resolve()
    })
  }

  async function waitFor(assertion: () => void) {
    let failure: unknown
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      })
      try {
        assertion()
        return
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }

  it('keeps the collection route unselected and puts a clicked id in the clean URL', async () => {
    await renderAt('/conversations')
    await waitFor(() => expect(host.textContent).toContain('Alpha conversation'))

    expect(apiMock.conversation).not.toHaveBeenCalled()
    expect(host.textContent).toContain('选择左侧会话查看详情')

    const row = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Alpha conversation'))
    expect(row).toBeDefined()
    act(() => row?.click())

    await waitFor(() => {
      expect(host.querySelector('[data-route-path]')?.textContent)
        .toBe('/conversations/alpha%20beta')
      expect(apiMock.conversation).toHaveBeenCalledWith('alpha beta')
      expect(host.textContent).toContain('Detail alpha beta')
    })
  })

  it('loads a conversation id directly from a deep link even when it is absent from the list', async () => {
    await renderAt('/conversations/deep%20thread')

    await waitFor(() => {
      expect(apiMock.conversation).toHaveBeenCalledWith('deep thread')
      expect(host.textContent).toContain('Detail deep thread')
    })
  })

  it('windows a large conversation instead of mounting every markdown row', async () => {
    const messages = Array.from({ length: 80 }, (_, index) => ([
      { role: 'user', content: `question ${index}` },
      { role: 'assistant', content: `answer ${index}` },
    ])).flat()
    apiMock.conversation.mockResolvedValueOnce({
      id: 'large-thread',
      title: 'Large conversation',
      messages,
    })

    await renderAt('/conversations/large-thread')
    await waitFor(() => {
      expect(host.textContent).toContain('Large conversation')
      expect(host.querySelector('[data-chat-virtual-list]')).not.toBeNull()
    })

    const list = host.querySelector('[data-chat-virtual-list]')
    expect(list?.getAttribute('data-virtualized')).toBe('true')
    expect(list?.getAttribute('data-total-count')).toBe('80')
    const rendered = Number(list?.getAttribute('data-rendered-count'))
    expect(rendered).toBeGreaterThan(0)
    expect(rendered).toBeLessThan(80)
    expect(host.querySelectorAll('[data-chat-message]')).toHaveLength(rendered)
  })

  it('returns to the collection route after deleting the active deep-linked conversation', async () => {
    await renderAt('/conversations/alpha%20beta')
    await waitFor(() => expect(host.textContent).toContain('Detail alpha beta'))

    const deleteButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '删除')
    expect(deleteButton).toBeDefined()
    act(() => deleteButton?.click())

    await waitFor(() => {
      expect(apiMock.deleteConversation).toHaveBeenCalledWith('alpha beta')
      expect(host.querySelector('[data-route-path]')?.textContent).toBe('/conversations')
      expect(host.textContent).toContain('选择左侧会话查看详情')
    })
  })
})
