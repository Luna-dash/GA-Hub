import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/api/types'
import {
  applyConversationTitle,
  conversationKeys,
  removeConversationFromCache,
  type ConversationListData,
} from './conversations'

function client() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 5_000 } },
  })
}

describe('conversation query cache', () => {
  it('coalesces concurrent requests for the same detail key', async () => {
    const qc = client()
    let release!: (value: Conversation) => void
    const pending = new Promise<Conversation>((resolve) => { release = resolve })
    const queryFn = vi.fn(() => pending)

    const first = qc.fetchQuery({ queryKey: conversationKeys.detail('a'), queryFn })
    const second = qc.fetchQuery({ queryKey: conversationKeys.detail('a'), queryFn })
    release({ id: 'a', title: 'A', messages: [] })

    expect(await first).toEqual(await second)
    expect(queryFn).toHaveBeenCalledOnce()
  })

  it('does not turn a failed request into cached data', async () => {
    const qc = client()
    const key = conversationKeys.detail('broken')

    await expect(qc.fetchQuery({
      queryKey: key,
      queryFn: () => Promise.reject(new Error('boom')),
    })).rejects.toThrow('boom')

    expect(qc.getQueryData(key)).toBeUndefined()
  })

  it('keeps list and detail titles coherent and invalidates list membership', async () => {
    const qc = client()
    const listKey = conversationKeys.list('', 0, 50)
    const detailKey = conversationKeys.detail('a')
    qc.setQueryData<ConversationListData>(listKey, {
      total: 1,
      offset: 0,
      limit: 50,
      items: [{ id: 'a', title: 'Old', message_count: 1, last_user_preview: 'hi' }],
    })
    qc.setQueryData<Conversation>(detailKey, { id: 'a', title: 'Old', messages: [] })

    await applyConversationTitle(qc, 'a', 'New')

    expect(qc.getQueryData<ConversationListData>(listKey)?.items[0].title).toBe('New')
    expect(qc.getQueryData<Conversation>(detailKey)?.title).toBe('New')
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true)
  })

  it('keeps request parameters in list keys', () => {
    expect(conversationKeys.list('', 0, 30)).not.toEqual(conversationKeys.list('', 0, 50))
    expect(conversationKeys.list('term', 0, 50)).not.toEqual(conversationKeys.list('', 0, 50))
    expect(conversationKeys.list('', 50, 50)).not.toEqual(conversationKeys.list('', 0, 50))
  })

  it('removes only the deleted detail and invalidates lists', async () => {
    const qc = client()
    const listKey = conversationKeys.list('', 0, 50)
    qc.setQueryData(listKey, { total: 1, offset: 0, limit: 50, items: [] })
    qc.setQueryData(conversationKeys.detail('a'), { id: 'a', title: 'A', messages: [] })
    qc.setQueryData(conversationKeys.detail('b'), { id: 'b', title: 'B', messages: [] })

    await removeConversationFromCache(qc, 'a')

    expect(qc.getQueryData(conversationKeys.detail('a'))).toBeUndefined()
    expect(qc.getQueryData(conversationKeys.detail('b'))).toBeDefined()
    expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true)
  })
})
