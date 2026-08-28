import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hubEventClient } from '@/runtime/hubEventClient'
import { useDesktopNotifyEffects } from '@/utils/useDesktopNotifyEffects'
import { useDocumentTitle } from '@/utils/useDocumentTitle'
import { useConductorStore } from '@/stores/conductorStore'

/** Long-lived effects isolated from the visual application shell. */
export function RuntimeEffects() {
  const queryClient = useQueryClient()
  const addChatMessage = useConductorStore((state) => state.addChatMessage)
  const replaceSubagents = useConductorStore((state) => state.replaceSubagents)
  const addLogItem = useConductorStore((state) => state.addLogItem)
  const clearConductor = useConductorStore((state) => state.clear)
  useDocumentTitle()
  useDesktopNotifyEffects()

  // Keep the Conductor projection alive while its page is not mounted. This
  // closes the HTTP bootstrap/subscription gap and lets remounts render from
  // the same bounded store immediately.
  useEffect(() => hubEventClient.subscribe('conductor:', (event) => {
    if (event.topic === 'conductor:chat' && event.payload.item) {
      addChatMessage(event.payload.item)
    }
    if (event.topic === 'conductor:subagents' && event.payload.items) {
      replaceSubagents(event.payload.items)
    }
    if (event.topic === 'conductor:log' && event.payload.item) {
      addLogItem(event.payload.item)
    }
  }), [addChatMessage, addLogItem, replaceSubagents])

  useEffect(() => hubEventClient.subscribeControl((control) => {
    if (control.type === 'resync_required') {
      clearConductor()
    }
  }), [clearConductor])

  useEffect(() => {
    let hasOpened = false
    let disconnectedAfterOpen = false
    return hubEventClient.subscribeState((state) => {
      if (state === 'open') {
        if (hasOpened && disconnectedAfterOpen) {
          void queryClient.invalidateQueries({ refetchType: 'active' })
        }
        hasOpened = true
        disconnectedAfterOpen = false
        return
      }
      if (hasOpened && (state === 'connecting' || state === 'closed')) {
        disconnectedAfterOpen = true
      }
    })
  }, [queryClient])

  return null
}
