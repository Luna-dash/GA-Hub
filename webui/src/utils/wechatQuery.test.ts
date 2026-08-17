import { describe, expect, it } from 'vitest'
import type { WxLogListResponse, WxStatus } from '@/api/types'
import { applyWechatMessageEvent, applyWechatStatusEvent } from './wechatQuery'

const entry = {
  ts: 1,
  direction: 'in',
  uid: 'user-1',
  text: 'hello',
  media: [],
  context_token: 'ctx',
  nickname: 'User',
}

describe('wechat query event projection', () => {
  it('appends events without refetching and ignores the adjacent replay duplicate', () => {
    const initial: WxLogListResponse = { messages: [] }
    const appended = applyWechatMessageEvent(initial, 'wechat:message_in', entry)

    expect(appended?.messages).toEqual([entry])
    expect(applyWechatMessageEvent(appended, 'wechat:message_in', entry)).toBe(appended)
  })

  it('caps the cache and clears it from the log event', () => {
    const initial: WxLogListResponse = {
      messages: [
        { ...entry, ts: 1, text: 'one' },
        { ...entry, ts: 2, text: 'two' },
      ],
    }
    const appended = applyWechatMessageEvent(
      initial,
      'wechat:message_out',
      { ...entry, ts: 3, direction: 'out', text: 'three' },
      2,
    )

    expect(appended?.messages.map((item) => item.text)).toEqual(['two', 'three'])
    expect(applyWechatMessageEvent(appended, 'wechat:log_cleared', {})).toEqual({ messages: [] })
  })

  it('projects status payloads directly into the cached status', () => {
    const status: WxStatus = {
      logged_in: false,
      bot_id: '',
      polling: false,
      qr: { status: 'waiting' },
      contacts: 0,
      allowlist: ['*'],
      log_count: 0,
    }
    const confirmed = applyWechatStatusEvent(status, 'wechat:qr_status', {
      status: 'confirmed',
      bot_id: 'bot-1',
    })

    expect(confirmed).toMatchObject({ logged_in: true, bot_id: 'bot-1', qr: { status: 'confirmed' } })
    expect(applyWechatStatusEvent(confirmed, 'wechat:polling', { running: true })?.polling).toBe(true)
    expect(applyWechatStatusEvent(confirmed, 'wechat:logout', {})).toMatchObject({
      logged_in: false,
      polling: false,
      qr: { status: 'idle' },
    })
  })
})
