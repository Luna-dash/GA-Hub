import type { ConversationSummary } from '@/api/types'

export function conversationCountsText(c: Pick<ConversationSummary, 'dialogue_count' | 'turn_count' | 'message_count'>): string {
  if (c.dialogue_count != null) {
    return `${c.dialogue_count} 次对话 · ${c.turn_count ?? c.message_count} turns`
  }
  const turns = c.turn_count ?? c.message_count
  return turns > 0 ? `${turns} turns` : ''
}

export const CONVERSATION_COUNTS_HELP = '对话次数：用户提问次数；turns：模型响应总轮数。'
