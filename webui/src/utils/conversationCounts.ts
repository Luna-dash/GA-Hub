import type { ConversationSummary } from '@/api/types'

export function conversationCountsText(c: Pick<ConversationSummary, 'dialogue_count' | 'turn_count' | 'message_count'>): string {
  const dialogues = c.dialogue_count == null ? '对话次数待统计' : `${c.dialogue_count} 次对话`
  return `${dialogues} · ${c.turn_count ?? c.message_count} turns`
}

export const CONVERSATION_COUNTS_HELP = '对话次数：真实用户发起的输入，不含工具结果与自动重试；turns：模型响应总轮数，含工具续轮和重试，待回复输入不计。'
