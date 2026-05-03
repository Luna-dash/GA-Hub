// useDesktopNotifyEffects — App-level subscriber that fires desktop notifs
// for two events:
//   1. An assistant stream just finished (chatStore.streaming flipped false)
//   2. A new wechat message arrived in the bus event stream
//
// Throttling + visibility checks live inside notify() itself; this module
// only translates state transitions into notify() calls.

import { useEffect, useRef } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useAgentStore } from '@/stores/agentStore'
import { notify } from './notify'

export function useDesktopNotifyEffects() {
  const streaming = useChatStore((s) => s.streaming)
  const msgs = useChatStore((s) => s.msgs)
  const recent = useAgentStore((s) => s.recent)

  // ── (1) stream done ──
  const wasStreamingRef = useRef(false)
  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant')
      const preview = (lastAssistant?.content || '').replace(/\s+/g, ' ').slice(0, 140)
      notify('Agent 已回复', { body: preview, tag: 'agent-stream-done' })
    }
    wasStreamingRef.current = streaming
  }, [streaming, msgs])

  // ── (2) wechat new message ──
  // We watch the head of `recent` for `wechat:message_in` topics. To avoid
  // re-firing on store rehydration, we remember the timestamp of the last
  // event we already announced.
  const lastWxAnnouncedRef = useRef<number>(Math.floor(Date.now() / 1000))
  useEffect(() => {
    for (const e of recent) {
      if (e.topic !== 'wechat:message_in') continue
      if (e.ts <= lastWxAnnouncedRef.current) break    // recent is newest-first
      const uid = e.payload?.uid || ''
      const text = e.payload?.text || '(媒体消息)'
      notify(`💬 微信 · ${uid.slice(0, 16) || '联系人'}`, {
        body: text.slice(0, 140),
        tag: `wechat-${uid}`,
      })
      lastWxAnnouncedRef.current = Math.max(lastWxAnnouncedRef.current, e.ts)
    }
  }, [recent])
}
