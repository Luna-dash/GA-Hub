import { QueryClient } from '@tanstack/react-query'
import type { ConversationListResponse, Conversation, ConversationSource } from '@/api/types'

export type ConversationListData = ConversationListResponse

export const conversationKeys = {
  all: ['conversations'] as const,
  lists: () => [...conversationKeys.all, 'list'] as const,
  list: (q: string, offset: number, limit: number, source: 'all' | ConversationSource = 'all') =>
    (source === 'all'
      ? [...conversationKeys.lists(), q, offset, limit] as const
      : [...conversationKeys.lists(), q, offset, limit, source] as const),
  details: () => [...conversationKeys.all, 'detail'] as const,
  detail: (id: string) => [...conversationKeys.details(), id] as const,
}

/** Keep rendered summaries/details coherent, then revalidate list membership. */
export async function applyConversationTitle(
  client: QueryClient,
  id: string,
  title: string,
): Promise<void> {
  client.setQueryData<Conversation>(conversationKeys.detail(id), (current) =>
    current ? { ...current, title } : current,
  )
  client.setQueriesData<ConversationListData>({ queryKey: conversationKeys.lists() }, (current) =>
    current
      ? {
          ...current,
          items: current.items.map((item) => item.id === id ? { ...item, title } : item),
        }
      : current,
  )
  await client.invalidateQueries({ queryKey: conversationKeys.lists() })
}

export async function removeConversationFromCache(
  client: QueryClient,
  id: string,
): Promise<void> {
  client.removeQueries({ queryKey: conversationKeys.detail(id), exact: true })
  await client.invalidateQueries({ queryKey: conversationKeys.lists() })
}
