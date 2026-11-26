import { useEffect } from 'react'
import { useDialogStore, cancelResult } from '@/stores/dialogStore'
import { ModalOverlay } from '@/components/ModalOverlay'
import { Z_LAYERS } from '@/config/zLayers'
import { MessageDialog } from './MessageDialog'

// The browser/failure renderer; desktop requests normally never enter this store.
export function DialogHost() {
  const { config, resolve, resolveCurrent, notificationConfig, notificationResolve, resolveNotification } = useDialogStore()
  if (!config && !notificationConfig) return null
  // A resolver identity distinguishes identical consecutive configs too.
  return (
    <>
      {config && <ModalDialogRequest key={String(requestKey(resolve))} config={config} onResult={resolveCurrent} />}
      {notificationConfig && (
        <NotificationDialogRequest
          key={String(requestKey(notificationResolve))}
          config={notificationConfig}
          onResult={resolveNotification}
        />
      )}
    </>
  )
}
const requestKeys = new WeakMap<object, number>()
let nextKey = 0
function requestKey(resolve: object | null) {
  if (!resolve) return 0
  if (!requestKeys.has(resolve)) requestKeys.set(resolve, ++nextKey)
  return requestKeys.get(resolve)
}
function ModalDialogRequest({ config, onResult }: React.ComponentProps<typeof MessageDialog>) {
  return <ModalOverlay zIndex={Z_LAYERS.dialog} onClose={() => onResult(cancelResult(config))} labelledBy="message-dialog-title" closeOnBackdrop={false} panelClassName="w-[480px] max-w-[94vw] overflow-hidden">
    <MessageDialog config={config} onResult={onResult} />
  </ModalOverlay>
}
function NotificationDialogRequest({ config, onResult }: React.ComponentProps<typeof MessageDialog>) {
  useEffect(() => {
    const timer = window.setTimeout(() => onResult(null), 12_000)
    return () => window.clearTimeout(timer)
  }, [onResult])
  return <div role="dialog" aria-modal="false" aria-labelledby="message-dialog-title" style={{ zIndex: Z_LAYERS.dialog }} className="fixed bottom-5 right-5 w-[480px] max-w-[94vw] overflow-hidden rounded-xl shadow-2xl border border-line">
    <MessageDialog config={config} onResult={onResult} />
  </div>
}
