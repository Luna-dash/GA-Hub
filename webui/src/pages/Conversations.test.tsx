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
  importConversation: vi.fn(),
  sessions: vi.fn(),
  updateConversation: vi.fn(),
}))
const dialogMock = vi.hoisted(() => ({
  alert: vi.fn(),
  confirm: vi.fn(),
  prompt: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
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
  toast: toastMock,
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function sessionRow(id: string, title: string) {
  return {
    id,
    title,
    llm_key: null,
    llm_index: null,
    archive_path: null,
    created_at: '2026-09-15T08:00:00Z',
    updated_at: '2026-09-15T08:00:00Z',
  }
}

function LocationProbe() {
  const location = useLocation()
  return (
    <>
      <output data-route-path>{location.pathname}</output>
      <output data-route-search>{location.search}</output>
    </>
  )
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
          {/* Where the primary action lands: the chat page resolves ?session=. */}
          <Route path="/chat" element={<LocationProbe />} />
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
    localStorage.clear()
    apiMock.conversations.mockReset().mockResolvedValue({
      total: 1,
      offset: 0,
      limit: 50,
      items: [{
        id: 'alpha beta',
        title: 'Alpha conversation',
        message_count: 1,
        mtime: 0,
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
    apiMock.importConversation.mockReset()
    // The primary action refreshes the session list before switching pages, so
    // the chat page finds the target instead of falling back to entry 0.
    apiMock.sessions.mockReset().mockResolvedValue({ total: 1, items: [sessionRow('sess-1', '已有会话')] })
    dialogMock.alert.mockReset()
    dialogMock.confirm.mockReset().mockResolvedValue(true)
    dialogMock.prompt.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
    toastMock.info.mockReset()
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
    for (let attempt = 0; attempt < 30; attempt += 1) {
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

  const buttonByText = (text: string) => [...host.querySelectorAll('button')]
    .find((button) => button.textContent?.trim() === text)
  const routedSessionId = () => new URLSearchParams(
    host.querySelector('[data-route-search]')?.textContent || '',
  ).get('session')

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

  it('deduplicates repeated turn summaries from archived assistant snapshots', async () => {
    apiMock.conversation.mockResolvedValueOnce({
      id: 'snapshot-thread',
      title: 'Snapshot thread',
      messages: [
        { role: 'user', content: '完成任务' },
        {
          role: 'assistant',
          content: [
            '**LLM Running (Turn 1) ...**',
            '<summary>读取配置</summary>',
            '中间过程',
          ].join('\n'),
        },
        {
          role: 'assistant',
          content: [
            '**LLM Running (Turn 1) ...**',
            '<summary>读取配置（已完成）</summary>',
            '## 最终结果',
            '',
            '任务已完成。',
          ].join('\n'),
        },
      ],
    })

    await renderAt('/conversations/snapshot-thread')
    await waitFor(() => expect(host.textContent).toContain('Snapshot thread'))

    const processButton = [...host.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '展开过程')
    expect(processButton).toBeDefined()
    act(() => processButton?.click())

    await waitFor(() => {
      expect(host.textContent).toContain('读取配置（已完成）')
      expect(host.textContent).not.toContain('读取配置中间过程')
    })
    expect(host.textContent?.match(/Turn 1/g)).toHaveLength(1)
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

  it('offers import for an unbound archive and switches to the session it mints', async () => {
    apiMock.importConversation.mockResolvedValue({
      ok: true,
      session_id: 'sess-imported',
      title: '外部归档',
      imported_lines: 12,
    })
    apiMock.sessions.mockResolvedValue({
      total: 1,
      items: [sessionRow('sess-imported', '外部归档')],
    })

    await renderAt('/conversations/alpha%20beta')
    await waitFor(() => expect(buttonByText('导入为会话')).toBeDefined())
    expect(buttonByText('打开该会话')).toBeUndefined()

    await act(async () => { buttonByText('导入为会话')?.click() })

    await waitFor(() => {
      expect(apiMock.importConversation).toHaveBeenCalledWith('alpha beta')
      expect(host.querySelector('[data-route-path]')?.textContent).toBe('/chat')
      expect(routedSessionId()).toBe('sess-imported')
    })
    // The chat page restores the stored id on a plain /chat boot, so the
    // selection is persisted as well as routed.
    expect(localStorage.getItem('gahub.currentSessionId')).toBe('sess-imported')
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('已导入为会话'))
    expect(dialogMock.alert).not.toHaveBeenCalled()
  })

  it('opens the owning session when the archive is already bound', async () => {
    apiMock.importConversation.mockRejectedValue({
      status: 409,
      body: {
        detail: {
          code: 'archive_already_bound',
          detail: '该归档已属于一条会话，请直接打开该会话。',
          session_id: 'sess-owner',
        },
      },
    })
    apiMock.sessions.mockResolvedValue({
      total: 1,
      items: [sessionRow('sess-owner', '归属会话')],
    })

    await renderAt('/conversations/alpha%20beta')
    await waitFor(() => expect(buttonByText('导入为会话')).toBeDefined())

    await act(async () => { buttonByText('导入为会话')?.click() })

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('该归档已属于某条会话'))
      expect(host.querySelector('[data-route-path]')?.textContent).toBe('/chat')
      expect(routedSessionId()).toBe('sess-owner')
    })
  })

  it('switches to the bound session without importing when the row is bound', async () => {
    apiMock.conversation.mockResolvedValue({
      id: 'alpha beta',
      title: 'Alpha conversation',
      messages: [{ role: 'user', content: 'message for alpha beta' }],
      bound_session_id: 'sess-bound',
    })
    apiMock.sessions.mockResolvedValue({
      total: 1,
      items: [sessionRow('sess-bound', '已绑定会话')],
    })

    await renderAt('/conversations/alpha%20beta')
    await waitFor(() => expect(buttonByText('打开该会话')).toBeDefined())
    expect(buttonByText('导入为会话')).toBeUndefined()

    await act(async () => { buttonByText('打开该会话')?.click() })

    await waitFor(() => {
      expect(apiMock.sessions).toHaveBeenCalled()
      expect(host.querySelector('[data-route-path]')?.textContent).toBe('/chat')
      expect(routedSessionId()).toBe('sess-bound')
    })
    expect(apiMock.importConversation).not.toHaveBeenCalled()
  })

  it('maps an unimportable archive and a missing archive to their own messages', async () => {
    await renderAt('/conversations/alpha%20beta')
    await waitFor(() => expect(buttonByText('导入为会话')).toBeDefined())

    apiMock.importConversation.mockRejectedValueOnce({
      status: 409,
      body: { detail: { code: 'archive_not_importable', detail: '该归档没有完整的对话轮次，无法导入。' } },
    })
    await act(async () => { buttonByText('导入为会话')?.click() })
    await waitFor(() => expect(dialogMock.alert)
      .toHaveBeenCalledWith('无法导入', '该归档没有可导入的完整对话。'))

    apiMock.importConversation.mockRejectedValueOnce({
      status: 404,
      body: { detail: 'conversation not found' },
    })
    await act(async () => { buttonByText('导入为会话')?.click() })
    await waitFor(() => expect(dialogMock.alert)
      .toHaveBeenCalledWith('归档不存在', expect.stringContaining('可能已被删除')))
    // Neither failure leaves the page or mints a session.
    expect(host.querySelector('[data-route-path]')?.textContent).toBe('/conversations/alpha%20beta')
  })

  it('refuses to navigate when the target session is missing from a refreshed list', async () => {
    apiMock.importConversation.mockResolvedValue({
      ok: true,
      session_id: 'sess-vanished',
      title: '已消失',
      imported_lines: 3,
    })

    await renderAt('/conversations/alpha%20beta')
    await waitFor(() => expect(buttonByText('导入为会话')).toBeDefined())

    await act(async () => { buttonByText('导入为会话')?.click() })

    await waitFor(() => expect(dialogMock.alert)
      .toHaveBeenCalledWith('无法打开会话', expect.stringContaining('已不存在')))
    expect(host.querySelector('[data-route-path]')?.textContent).toBe('/conversations/alpha%20beta')
  })
})
