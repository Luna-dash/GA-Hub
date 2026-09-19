import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { HubSession } from '@/api/types'
import { queryKeys } from './queryKeys'
import { markSessionUsed, type SessionListData } from './sessions'

function row(id: string, updatedAt: string): HubSession {
  return {
    id,
    title: id,
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
