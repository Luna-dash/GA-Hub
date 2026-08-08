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
})
