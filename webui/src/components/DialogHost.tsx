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
  return <ModalOverlay onClose={() => onResult(cancelResult(config))} labelledBy="message-dialog-title" closeOnBackdrop={false} panelClassName="w-[480px] max-w-[94vw] overflow-hidden">
    <MessageDialog config={config} onResult={onResult} />
  </ModalOverlay>
}
