// useDesktopNotifyEffects — App-level subscriber that fires desktop notifs
// for two events:
//   1. An assistant stream just finished (chatStore.streaming flipped false)
//   2. A new wechat message arrived in the bus event stream
//
// Throttling + visibility checks live inside notify() itself; this module
// only translates state transitions into notify() calls.

import { useEffect } from 'react'
import { useChatStore } from '@/stores/chatStore'
import { useConductorStore } from '@/stores/conductorStore'
import { hubEventClient } from '@/runtime/hubEventClient'
import { notify } from './notify'

export function useDesktopNotifyEffects() {
  useEffect(() => {
    let lastWxAnnounced = Math.floor(Date.now() / 1000)
    let conductorAssistantCount = useConductorStore
      .getState()
      .chatMessages
      .filter((message) => message.role === 'assistant').length

    const unsubscribeChat = useChatStore.subscribe((state, previous) => {
      if (!previous.streaming || state.streaming) return
      const lastAssistant = [...state.msgs].reverse().find((message) => message.role === 'assistant')
      const preview = (lastAssistant?.content || '').replace(/\s+/g, ' ').slice(0, 140)
      notify('Agent 已回复', { body: preview, tag: 'agent-stream-done' })
    })

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

    const unsubscribeConductor = useConductorStore.subscribe((state, previous) => {
      if (state.chatMessages === previous.chatMessages) return
      const assistantMessages = state.chatMessages.filter((message) => message.role === 'assistant')
      const nextCount = assistantMessages.length
      if (nextCount > conductorAssistantCount && conductorAssistantCount > 0) {
        const lastMessage = assistantMessages[assistantMessages.length - 1]
        const preview = (lastMessage?.msg || '').replace(/\s+/g, ' ').slice(0, 140)
        notify('Conductor 任务完成', { body: preview, tag: 'conductor-task-done' })
      }
      conductorAssistantCount = nextCount
    })

    return () => {
      unsubscribeChat()
      unsubscribeWechat()
      unsubscribeConductor()
    }
  }, [])
}
