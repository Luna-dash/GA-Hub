import { useEffect } from 'react'
import { useDialogStore, cancelResult } from '@/stores/dialogStore'
import { ModalOverlay } from '@/components/ModalOverlay'
import { MessageDialog } from './MessageDialog'

// The browser/failure renderer; desktop requests normally never enter this store.
export function DialogHost() {
  const { open, config, resolve, resolveCurrent } = useDialogStore()
  if (!open || !config) return null
  // A resolver identity distinguishes identical consecutive configs too.
  return <DialogRequest key={String(requestKey(resolve))} config={config} onResult={resolveCurrent} />
}
const requestKeys = new WeakMap<object, number>()
let nextKey = 0
function requestKey(resolve: object | null) {
  if (!resolve) return 0
  if (!requestKeys.has(resolve)) requestKeys.set(resolve, ++nextKey)
  return requestKeys.get(resolve)
}
function DialogRequest({ config, onResult }: React.ComponentProps<typeof MessageDialog>) {
  useEffect(() => {
    if (config.kind !== 'notification') return
    const timer = window.setTimeout(() => onResult(null), 12_000)
    return () => window.clearTimeout(timer)
  }, [config.kind, onResult])
  if (config.kind === 'notification') return <div role="dialog" aria-modal="false" aria-labelledby="message-dialog-title" className="fixed bottom-5 right-5 z-[100] w-[480px] max-w-[94vw] overflow-hidden rounded-xl shadow-2xl border border-line">
    <MessageDialog config={config} onResult={onResult} />
  </div>
  return <ModalOverlay onClose={() => onResult(cancelResult(config))} labelledBy="message-dialog-title" closeOnBackdrop={false} panelClassName="w-[480px] max-w-[94vw] overflow-hidden">
    <MessageDialog config={config} onResult={onResult} />
  </ModalOverlay>
}
