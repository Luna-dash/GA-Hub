import { describe, expect, it } from 'vitest'
import { toFeishuMsg } from './feishuMessage'
import { useFeishuStore } from '@/stores/feishuStore'

describe('Feishu event mapping', () => {
  it('preserves the source event id for deduplication', () => {
    const message = toFeishuMsg({
      topic: 'feishu:chat',
      payload: {
        event_id: 'remote-1',
        task_id: 'task-1',
        role: 'assistant',
        type: 'summary',
        content: 'same content',
        ts: 10,
      },
      ts: 10,
    })

    expect(message?.eventId).toBe('remote-1')
  })

  it('keeps distinct source events with identical content', () => {
    useFeishuStore.setState({ msgs: [] })
    const first = toFeishuMsg({
      topic: 'feishu:chat',
      payload: { event_id: 'remote-1', task_id: 'task-1', role: 'assistant', content: 'same' },
      ts: 10,
    })!
    const second = { ...first, eventId: 'remote-2' }

    useFeishuStore.getState().addMsgs([first, second])

    expect(useFeishuStore.getState().msgs).toHaveLength(2)
    useFeishuStore.setState({ msgs: [] })
  })
})
