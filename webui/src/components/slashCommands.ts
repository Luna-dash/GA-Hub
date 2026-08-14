export interface SlashCommand {
  name: '/new' | '/btw' | '/rewind'
  description: string
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: '/new', description: '新建对话' },
  { name: '/btw', description: '旁路提问，不打断主任务' },
  { name: '/rewind', description: '回退到历史消息' },
]

export interface SlashMenuKeyResult {
  handled: boolean
  activeIndex: number
  selectIndex?: number
  close?: boolean
}

export function handleSlashMenuKey(
  key: string,
  activeIndex: number,
  itemCount: number,
): SlashMenuKeyResult {
  if (itemCount <= 0) return { handled: false, activeIndex }
  if (key === 'ArrowDown') {
    return { handled: true, activeIndex: (activeIndex + 1) % itemCount }
  }
  if (key === 'ArrowUp') {
    return { handled: true, activeIndex: (activeIndex - 1 + itemCount) % itemCount }
  }
  if (key === 'Enter' || key === 'Tab') {
    return { handled: true, activeIndex, selectIndex: activeIndex }
  }
  if (key === 'Escape') {
    return { handled: true, activeIndex, close: true }
  }
  return { handled: false, activeIndex }
}

export interface RewindCandidate {
  role: string
  streamId?: string
  streaming?: boolean
  source?: string
}

export function findLatestRewindStreamId(messages: readonly RewindCandidate[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (
      message.role === 'assistant'
      && message.streamId
      && !message.streaming
      && message.source !== 'chat_error_retry_notice'
    ) {
      return message.streamId
    }
  }
  return null
}

/**
 * Translate a UI assistant bubble into the durable archive's turn-count form.
 * Archive message ids are intentionally unrelated to runtime stream ids, so
 * the frontend identifies the owning user turn by position and asks the
 * backend to remove that turn plus every later user turn.
 */
export function rewindTurnCountFromAssistant(
  messages: readonly RewindCandidate[],
  streamId: string,
): number | null {
  const assistantIndex = messages.findIndex((message) => (
    message.role === 'assistant'
    && message.streamId === streamId
    && !message.streaming
    && message.source !== 'chat_error_retry_notice'
  ))
  if (assistantIndex < 0) return null

  let owningUserIndex = -1
  for (let index = assistantIndex; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      owningUserIndex = index
      break
    }
  }
  if (owningUserIndex < 0) return null

  const turnCount = messages
    .slice(owningUserIndex)
    .reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0)
  return turnCount > 0 ? turnCount : null
}

export function filterSlashCommands(text: string): readonly SlashCommand[] {
  if (!text.startsWith('/') || /\s/.test(text)) return []
  const query = text.toLocaleLowerCase()
  return SLASH_COMMANDS.filter((item) =>
    item.name.toLocaleLowerCase().includes(query)
    || item.description.toLocaleLowerCase().includes(query.slice(1)),
  )
}
