import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { hubEventClient } from '@/runtime/hubEventClient'
import { useDesktopNotifyEffects } from '@/utils/useDesktopNotifyEffects'
import { useDocumentTitle } from '@/utils/useDocumentTitle'

/** Long-lived effects isolated from the visual application shell. */
export function RuntimeEffects() {
  const queryClient = useQueryClient()
  useDocumentTitle()
  useDesktopNotifyEffects()

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
