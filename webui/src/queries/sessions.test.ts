import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HubSession } from '@/api/types'
import { api } from '@/api/client'
import { queryKeys } from './queryKeys'
import { createAndOpenSession, markSessionUsed, type SessionListData } from './sessions'

vi.mock('@/api/client', () => ({ api: { createSession: vi.fn() } }))
afterEach(() => vi.resetAllMocks())

function row(id: string, updatedAt: string): Awaited<ReturnType<typeof api.createSession>> {
  return {
    id,
    title: id,
    kind: 'chat',
    status: 'active',
    llm_key: null,
    llm_index: null,
    archive_path: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: updatedAt,
  }
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function seed(qc: QueryClient, items: HubSession[]) {
  const data: SessionListData = { total: items.length, items }
  qc.setQueryData(queryKeys.sessions, data)
  return data
}

describe('session query cache', () => {
  it('creates an independent session and preserves the previous cached session', async () => {
    const qc = client()
    const old = row('old', '2026-09-18T05:00:00Z')
    seed(qc, [old])
    const next = row('new', '2026-10-10T05:00:00Z')
    vi.mocked(api.createSession).mockResolvedValue(next)
    const navigate = vi.fn()

    expect(await createAndOpenSession(qc, navigate, 'stable-model')).toBe(true)
    expect(api.createSession).toHaveBeenCalledWith({ title: '', llm_key: 'stable-model' })
    expect(navigate).toHaveBeenCalledWith('/chat?session=new')
    expect(qc.getQueryData(queryKeys.sessions)).toEqual({ total: 2, items: [next, old] })
  })

  it('keeps a created session discoverable when the caller has switched away', async () => {
    const qc = client()
    const next = row('new', '2026-10-10T05:00:00Z')
    vi.mocked(api.createSession).mockResolvedValue(next)
    const navigate = vi.fn()

    expect(await createAndOpenSession(qc, navigate, 'model', () => false)).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(qc.getQueryData(queryKeys.sessions)).toEqual({ total: 1, items: [next] })
  })

  it('does not duplicate a created session already returned by a list refresh', async () => {
    const qc = client()
    const next = row('new', '2026-10-10T05:00:00Z')
    vi.mocked(api.createSession).mockImplementation(async () => {
      seed(qc, [next])
      return next
    })
    await createAndOpenSession(qc, vi.fn(), 'model')
    expect(qc.getQueryData(queryKeys.sessions)).toEqual({ total: 1, items: [next] })
  })

  it('keeps the new session when an older in-flight list response arrives', async () => {
    const qc = client()
    const old = row('old', '2026-09-18T05:00:00Z')
    const before = seed(qc, [old])
    let finish!: (value: SessionListData) => void
    const refresh = qc.fetchQuery({
      queryKey: queryKeys.sessions,
      queryFn: () => new Promise<SessionListData>((resolve) => { finish = resolve }),
    }).catch(() => undefined)
    const next = row('new', '2026-10-10T05:00:00Z')
    vi.mocked(api.createSession).mockResolvedValue(next)
    await createAndOpenSession(qc, vi.fn(), 'model')
    finish(before)
    await refresh
    expect(qc.getQueryData(queryKeys.sessions)).toEqual({ total: 2, items: [next, old] })
  })

  it('keeps the selection and cache intact when creation fails or no model exists', async () => {
    const qc = client()
    const initial = seed(qc, [row('old', '2026-09-18T05:00:00Z')])
    const navigate = vi.fn()
    await expect(createAndOpenSession(qc, navigate, null)).rejects.toThrow('当前没有可用模型')
    expect(api.createSession).not.toHaveBeenCalled()
    vi.mocked(api.createSession).mockRejectedValue(new Error('unavailable'))
    await expect(createAndOpenSession(qc, navigate, 'model')).rejects.toThrow('unavailable')
    expect(navigate).not.toHaveBeenCalled()
    expect(qc.getQueryData(queryKeys.sessions)).toEqual(initial)
  })

  it('bumps only the target row and leaves the list shape intact', () => {
    const qc = client()
    seed(qc, [row('a', '2026-09-18T05:00:00Z'), row('b', '2026-09-18T06:00:00Z')])

    markSessionUsed(qc, 'a', new Date('2026-09-18T07:00:00Z'))

    const data = qc.getQueryData<SessionListData>(queryKeys.sessions)!
    expect(data.total).toBe(2)
    expect(data.items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(data.items[0].updated_at).toBe('2026-09-18T07:00:00.000Z')
    expect(data.items[1].updated_at).toBe('2026-09-18T06:00:00Z')
  })

  it('leaves an unpopulated cache alone', () => {
    const qc = client()

    markSessionUsed(qc, 'a')

    expect(qc.getQueryData(queryKeys.sessions)).toBeUndefined()
  })

  it('does not mutate the object it replaces', () => {
    const qc = client()
    const before = seed(qc, [row('a', '2026-09-18T05:00:00Z')])

    markSessionUsed(qc, 'a', new Date('2026-09-18T07:00:00Z'))

    expect(before.items[0].updated_at).toBe('2026-09-18T05:00:00Z')
  })
})
