import { useCallback, useRef, useState } from 'react'
import { dialog } from '@/stores/dialogStore'

export interface UseDirtyCloseOptions {
  dirty: boolean
  busy?: boolean
  onClose: () => void
  title?: string
  message?: string
  confirmText?: string
  cancelText?: string
}

/**
 * Guards modal/popover dismissal against accidental loss of unsaved edits.
 * - Clean (`dirty === false`): calls `onClose` synchronously so Escape/Cancel remain instant.
 * - Dirty (`dirty === true`): prompts via `dialog.confirm` with a synchronous re-entrancy lock.
 */
export function useDirtyClose({
  dirty,
  busy = false,
  onClose,
  title = '放弃未保存的修改？',
  message = '当前表单包含尚未保存的改动，关闭后将丢失这些内容。',
  confirmText = '放弃修改',
  cancelText = '继续编辑',
}: UseDirtyCloseOptions) {
  const [confirming, setConfirming] = useState(false)
  const confirmingRef = useRef(false)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const busyRef = useRef(busy)
  busyRef.current = busy
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const requestClose = useCallback(() => {
    if (busyRef.current || confirmingRef.current) return
    if (!dirtyRef.current) {
      onCloseRef.current()
      return
    }
    confirmingRef.current = true
    setConfirming(true)
    void dialog
      .confirm(title, message, {
        confirmText,
        cancelText,
        tone: 'danger',
      })
      .then((discard) => {
        if (discard) onCloseRef.current()
      })
      .finally(() => {
        confirmingRef.current = false
        setConfirming(false)
      })
  }, [title, message, confirmText, cancelText])

  return { requestClose, confirming }
}
