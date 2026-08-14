import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, HttpTimeoutError } from './client'

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
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('honors a signal that was aborted before the request starts', async () => {
    const fetchMock = pendingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort()

    await expect(api.getSessionMessages('already-cancelled', controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('preserves AbortError when a request is cancelled in flight', async () => {
    const fetchMock = pendingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const request = api.getSessionMessages('cancel-in-flight', controller.signal)
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
})
