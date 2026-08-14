import { QueryClient } from '@tanstack/react-query'
import type { ConversationListResponse, Conversation } from '@/api/types'

export type ConversationListData = ConversationListResponse

export const conversationKeys = {
  all: ['conversations'] as const,
  lists: () => [...conversationKeys.all, 'list'] as const,
  list: (q: string, offset: number, limit: number) =>
    [...conversationKeys.lists(), q, offset, limit] as const,
  detail: (id: string) => [...conversationKeys.all, 'detail', id] as const,
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
