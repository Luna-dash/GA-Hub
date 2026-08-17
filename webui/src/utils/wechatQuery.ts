import type { WxLogEntry, WxLogListResponse, WxStatus } from '@/api/types'

function asEntry(payload: Record<string, any>): WxLogEntry | null {
  if (!Number.isFinite(payload.ts) || !payload.uid || !payload.direction) return null
  return {
    ts: Number(payload.ts),
    direction: String(payload.direction),
    uid: String(payload.uid),
    text: String(payload.text ?? ''),
    media: Array.isArray(payload.media) ? payload.media.map(String) : [],
    context_token: String(payload.context_token ?? ''),
    nickname: String(payload.nickname ?? ''),
  }
}

function sameEntry(left: WxLogEntry, right: WxLogEntry): boolean {
  return left.ts === right.ts
    && left.direction === right.direction
    && left.uid === right.uid
    && left.text === right.text
    && left.context_token === right.context_token
    && left.nickname === right.nickname
    && left.media.length === right.media.length
    && left.media.every((item, index) => item === right.media[index])
}

export function applyWechatMessageEvent(
  current: WxLogListResponse | undefined,
  topic: string,
  payload: Record<string, any>,
  limit = 1000,
): WxLogListResponse | undefined {
  if (topic === 'wechat:log_cleared') return { messages: [] }
  if (topic !== 'wechat:message_in' && topic !== 'wechat:message_out') return current
  const entry = asEntry(payload)
  if (!entry) return current
  const messages = current?.messages ?? []
  if (messages.length > 0 && sameEntry(messages[messages.length - 1], entry)) return current
  return { messages: [...messages, entry].slice(-limit) }
}

export function applyWechatStatusEvent(
  current: WxStatus | undefined,
  topic: string,
  payload: Record<string, any>,
): WxStatus | undefined {
  if (!current) return current
  if (topic === 'wechat:qr_status') {
    const status = String(payload.status ?? current.qr.status)
    return {
      ...current,
      logged_in: status === 'confirmed' ? true : current.logged_in,
      bot_id: payload.bot_id ? String(payload.bot_id) : current.bot_id,
      qr: { ...current.qr, ...payload, status },
    }
  }
  if (topic === 'wechat:logout') {
    return { ...current, logged_in: false, polling: false, bot_id: '', qr: { status: 'idle' } }
  }
  if (topic === 'wechat:polling' && typeof payload.running === 'boolean') {
    return { ...current, polling: payload.running }
  }
  if (topic === 'wechat:allowlist' && Array.isArray(payload.allowlist)) {
    return { ...current, allowlist: payload.allowlist.map(String) }
  }
  return current
}
