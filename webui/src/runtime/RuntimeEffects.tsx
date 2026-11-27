import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hubEventClient } from '@/runtime/hubEventClient'
import { useConductorRuntimeEffects } from '@/hooks/useConductorRuntimeEffects'
import { useDesktopNotifyEffects } from '@/hooks/useDesktopNotifyEffects'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useSessionUnreadEffects } from '@/hooks/useSessionUnreadEffects'
import { useThemeCompletionEffects } from '@/hooks/useThemeCompletionEffects'
import { installChatSelectionGuard } from '@/utils/chatSelection'

/** Long-lived effects isolated from the visual application shell. */
export function RuntimeEffects() {
  const queryClient = useQueryClient()
  useDocumentTitle()
  useDesktopNotifyEffects()
  useSessionUnreadEffects()
  useThemeCompletionEffects()
  useConductorRuntimeEffects()

  useEffect(() => installChatSelectionGuard(), [])

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
