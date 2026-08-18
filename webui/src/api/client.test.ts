import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  api,
  DEFAULT_HTTP_TIMEOUT_MS,
  HttpTimeoutError,
  MYKEY_SYNC_HTTP_TIMEOUT_MS,
} from './client'

function pendingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal?.aborted) rejectAbort()
    else signal?.addEventListener('abort', rejectAbort, { once: true })
  }))
}

describe('api request failure handling', () => {
  afterEach(() => {
    delete window.__GA_HUB_RUNTIME__
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('honors a signal that was aborted before the request starts', async () => {
    const fetchMock = pendingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(api.getSessionMessages('already-cancelled', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('preserves AbortError when a request is cancelled in flight', async () => {
    const fetchMock = pendingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const request = api.getSessionMessages('cancel-in-flight', { signal: controller.signal })
    controller.abort()

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('classifies an internal deadline as HttpTimeoutError', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', pendingFetch())
    const request = api.upload(new File(['data'], 'sample.txt'), { timeoutMs: 25 })
    const assertion = expect(request).rejects.toBeInstanceOf(HttpTimeoutError)
    await vi.advanceTimersByTimeAsync(25)

    await assertion
  })

  it('allows mykey sync to outlive the normal request deadline', async () => {
    vi.useFakeTimers()
    const fetchMock = pendingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const request = api.uploadMyKeySync()
    const assertion = expect(request).rejects.toBeInstanceOf(HttpTimeoutError)

    await vi.advanceTimersByTimeAsync(DEFAULT_HTTP_TIMEOUT_MS)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(MYKEY_SYNC_HTTP_TIMEOUT_MS - DEFAULT_HTTP_TIMEOUT_MS)
    await assertion
  })

  it('classifies fetch TypeError as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    await expect(api.sessions()).rejects.toMatchObject({
      name: 'NetworkError',
      code: 'network_error',
    })
  })

  it('preserves the paginated project-list contract', async () => {
    const payload = {
      total: 1,
      items: [{ name: 'alpha', path: 'D:/projects/alpha', dangling: false }],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))

    await expect(api.projects()).resolves.toEqual(payload)
  })

  it('routes API and returned file URLs through an injected runtime origin', async () => {
    window.__GA_HUB_RUNTIME__ = { apiOrigin: 'http://127.0.0.1:43123' }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      file_id: 'file-1',
      name: 'sample.png',
      path: 'D:/uploads/sample.png',
      url: '/api/files/sample.png',
      mime: 'image/png',
      size: 4,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const upload = await api.upload(new File(['data'], 'sample.png'))

    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:43123/api/upload')
    expect(upload.url).toBe('http://127.0.0.1:43123/api/files/sample.png')
    expect(api.fileUrlByPath('D:/a b.png')).toBe(
      'http://127.0.0.1:43123/api/files-by-path?path=D%3A%2Fa%20b.png',
    )
    expect(api.exportConversation('a/b', 'md')).toBe(
      'http://127.0.0.1:43123/api/conversations/a%2Fb/export?format=md',
    )
  })

  it('encodes bounded session-history paging options', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      session_id: 'session/with space',
      archive_bound: true,
      revision: 'rev-1',
      items: [],
      total: 10,
      has_more: true,
      next_before: 4,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.getSessionMessages('session/with space', {
      before: 8,
      limit: 32,
      maxChars: 400_000,
    })

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/sessions/session%2Fwith%20space/messages?before=8&limit=32&max_chars=400000',
    )
  })

  it('marks an explicit Feishu refresh as forced', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ready: true,
      ok: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await api.fsCheck(false, true)

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/api/feishu/check?init_agent=false&force=true',
    )
  })

  it('routes BTW and rewind through the encoded session runtime endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, content: 'side answer' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        removed_sids: [], kept: 2, history_lines: 4,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(api.sessionBtw('session/with space', 'why?')).resolves.toMatchObject({
      ok: true,
      content: 'side answer',
    })
    await expect(api.rewindSession('session/with space', { n: 2 })).resolves.toMatchObject({
      kept: 2,
    })

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/sessions/session%2Fwith%20space/btw', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ text: 'why?' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/sessions/session%2Fwith%20space/rewind', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ n: 2 }),
    }))
  })

  it('sends project creation and index deletion with the backend-only name encoded', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: 'alpha-1234', path: 'D:/projects/alpha', dangling: false,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await api.createProject('D:/projects/alpha')
    await api.deleteProject('alpha name-1234')

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/projects', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: 'D:/projects/alpha' }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/projects/alpha%20name-1234', expect.objectContaining({
      method: 'DELETE',
    }))
  })

  it('sends Conductor model policy on chat and approval dispatches', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chat-1', role: 'user', msg: 'plan', ts: 1,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'worker-1', status: 'running', instruction: 'ok',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const models = {
      llmIndex: 1,
      subagentLlmIndex: 5,
      subagentModelPolicy: 'locked' as const,
    }
    const chatMessage = '请规划中文任务 🚀'
    const workerPrompt = '检查 D:\\项目\\资料，保留 emoji 🧪'
    await api.conductorSendChat(chatMessage, 'user', models)
    await api.conductorStartSubagent(workerPrompt, 3, models)

    expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/conductor/chat', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        msg: chatMessage,
        role: 'user',
        llm_index: 1,
        subagent_llm_index: 5,
        subagent_model_policy: 'locked',
      }),
    }))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/conductor/subagent', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        prompt: workerPrompt,
        llm_index: 3,
        conductor_llm_index: 1,
        subagent_llm_index: 5,
        subagent_model_policy: 'locked',
      }),
    }))
  })
})
