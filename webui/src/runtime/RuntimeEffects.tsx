import { useDesktopNotifyEffects } from '@/utils/useDesktopNotifyEffects'
import { useDocumentTitle } from '@/utils/useDocumentTitle'

/** Long-lived effects isolated from the visual application shell. */
export function RuntimeEffects() {
  useDocumentTitle()
  useDesktopNotifyEffects()
  return null
}
