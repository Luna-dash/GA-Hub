import { describe, expect, it } from 'vitest'
import {
  filterSlashCommands,
  findLatestRewindStreamId,
  handleSlashMenuKey,
  rewindTurnCountFromAssistant,
  SLASH_COMMANDS,
} from './slashCommands'

describe('filterSlashCommands', () => {
  it('opens on a leading slash and lists every supported command', () => {
    expect(filterSlashCommands('/')).toEqual(SLASH_COMMANDS)
  })

  it('filters by command name or description, case-insensitively', () => {
    expect(filterSlashCommands('/NEW').map((item) => item.name)).toEqual(['/new'])
    expect(filterSlashCommands('/旁路').map((item) => item.name)).toEqual(['/btw'])
  })

  it('stays closed for ordinary text, command arguments, and no matches', () => {
    expect(filterSlashCommands('hello /new')).toEqual([])
    expect(filterSlashCommands('/new title')).toEqual([])
    expect(filterSlashCommands('/missing')).toEqual([])
  })
})

describe('handleSlashMenuKey', () => {
  it('wraps arrow navigation through the visible items', () => {
    expect(handleSlashMenuKey('ArrowDown', 2, 3)).toEqual({ handled: true, activeIndex: 0 })
    expect(handleSlashMenuKey('ArrowUp', 0, 3)).toEqual({ handled: true, activeIndex: 2 })
  })

  it('selects with Enter or Tab and closes with Escape', () => {
    expect(handleSlashMenuKey('Enter', 1, 3)).toEqual({ handled: true, activeIndex: 1, selectIndex: 1 })
    expect(handleSlashMenuKey('Tab', 0, 3)).toEqual({ handled: true, activeIndex: 0, selectIndex: 0 })
    expect(handleSlashMenuKey('Escape', 2, 3)).toEqual({ handled: true, activeIndex: 2, close: true })
  })

  it('does not intercept keys when closed or unrelated keys', () => {
    expect(handleSlashMenuKey('Enter', 0, 0)).toEqual({ handled: false, activeIndex: 0 })
    expect(handleSlashMenuKey('a', 1, 3)).toEqual({ handled: false, activeIndex: 1 })
  })
})

describe('findLatestRewindStreamId', () => {
  it('returns the latest completed assistant stream', () => {
    expect(findLatestRewindStreamId([
      { role: 'assistant', streamId: 'older', streaming: false },
      { role: 'user' },
      { role: 'assistant', streamId: 'latest', streaming: false },
    ])).toBe('latest')
  })

  it('skips streaming replies and retry notices', () => {
    expect(findLatestRewindStreamId([
      { role: 'assistant', streamId: 'valid', streaming: false },
      { role: 'assistant', streamId: 'retry', streaming: false, source: 'chat_error_retry_notice' },
      { role: 'assistant', streamId: 'running', streaming: true },
    ])).toBe('valid')
  })

  it('returns null when no reply can be rewound', () => {
    expect(findLatestRewindStreamId([
      { role: 'user', streamId: 'not-an-assistant' },
      { role: 'assistant', streaming: false },
    ])).toBeNull()
  })
})

describe('rewindTurnCountFromAssistant', () => {
  it('counts the selected assistant turn and every later user turn', () => {
    expect(rewindTurnCountFromAssistant([
      { role: 'user', streamId: 'u1' },
      { role: 'assistant', streamId: 'a1', streaming: false },
      { role: 'assistant', streamId: 'a1-extra', streaming: false },
      { role: 'user', streamId: 'u2' },
      { role: 'assistant', streamId: 'a2', streaming: false },
      { role: 'user', streamId: 'u3' },
      { role: 'assistant', streamId: 'a3', streaming: false },
    ], 'a1-extra')).toBe(3)
  })

  it('rejects unknown, streaming, notice, and assistant-only candidates', () => {
    const messages = [
      { role: 'assistant', streamId: 'orphan', streaming: false },
      { role: 'user', streamId: 'u1' },
      { role: 'assistant', streamId: 'running', streaming: true },
      { role: 'assistant', streamId: 'notice', streaming: false, source: 'chat_error_retry_notice' },
    ]
    expect(rewindTurnCountFromAssistant(messages, 'missing')).toBeNull()
    expect(rewindTurnCountFromAssistant(messages, 'orphan')).toBeNull()
    expect(rewindTurnCountFromAssistant(messages, 'running')).toBeNull()
    expect(rewindTurnCountFromAssistant(messages, 'notice')).toBeNull()
  })
})
