import type { BusEvent } from '@/api/types'
import type { FeishuMsg } from '@/stores/feishuStore'

/** Convert one EventBus or recent-event envelope into the Feishu UI shape. */
export function toFeishuMsg(event: BusEvent): FeishuMsg | null {
  const payload = event.payload || {}
  if (
    event.topic !== 'feishu:chat'
    || !payload.task_id
    || !payload.role
    || payload.content === undefined
  ) return null

  const rawType = String(payload.type || 'summary')
  const payloadEventId = payload.event_id
  const eventId = typeof payloadEventId === 'string' || typeof payloadEventId === 'number'
    ? String(payloadEventId)
    : typeof event.event_id === 'number' && event.epoch
      ? `${event.epoch}:${event.event_id}`
      : undefined

  return {
    taskId: String(payload.task_id),
    chatId: String(payload.chat_id || ''),
    role: payload.role === 'user' ? 'user' : 'assistant',
    type: rawType === 'done' ? 'final' : (rawType as FeishuMsg['type']),
    content: String(payload.content || ''),
    ts: typeof payload.ts === 'number' ? payload.ts * 1000 : event.ts ? event.ts * 1000 : Date.now(),
    eventId,
  }
}
