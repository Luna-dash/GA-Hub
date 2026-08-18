// useDesktopNotifyEffects — runtime subscriber that fires desktop notifications
// for three events:
//   1. An assistant stream just finished (chatStore.streaming flipped false)
//   2. A new wechat message arrived in the bus event stream
//   3. A Conductor assistant result arrived, even while its page is unmounted
//
// Throttling + visibility checks live inside notify() itself; this module
// only translates state transitions into notify() calls.

import { useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { hubEventClient } from '@/runtime/hubEventClient'
import { notify } from './notify'

export function useDesktopNotifyEffects() {
  useEffect(() => {
    let lastWxAnnounced = Math.floor(Date.now() / 1000)

    const unsubscribeChat = useChatStore.subscribe(
      (state) => state.streaming,
      (streaming, previousStreaming) => {
        if (!previousStreaming || streaming) return
        const lastAssistant = [...useChatStore.getState().msgs]
          .reverse()
          .find((message) => message.role === 'assistant')
        const preview = (lastAssistant?.content || '').replace(/\s+/g, ' ').slice(0, 140)
        notify('Agent 已回复', { body: preview, tag: 'agent-stream-done' })
      },
    )

    const unsubscribeWechat = hubEventClient.subscribe('wechat:message_in', (event) => {
      if (event.ts <= lastWxAnnounced) return
      const uid = event.payload?.uid || ''
      const message = event.payload?.text || '(媒体消息)'
      notify(`💬 微信 · ${uid.slice(0, 16) || '联系人'}`, {
        body: message.slice(0, 140),
        tag: `wechat-${uid}`,
      })
      lastWxAnnounced = event.ts
    })

    const unsubscribeConductor = hubEventClient.subscribe('conductor:request_outcome', (event) => {
      if (event.payload?.status !== 'ok') return
      const item = event.payload?.item
      const preview = String(item?.msg || '任务已完成').replace(/\s+/g, ' ').slice(0, 140)
      notify('Conductor 任务完成', { body: preview, tag: 'conductor-task-done' })
    })

    return () => {
      unsubscribeChat()
      unsubscribeWechat()
      unsubscribeConductor()
    }
  }, [])
}
