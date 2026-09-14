// SubagentSettingsModal — the ⚙ trigger in the header cluster plus its
// settings dialog. Drafts live here: opening seeds them from the current
// values, saving hands the resolved triple to the page (which owns the
// persistence calls) and closes. Focus returns to the trigger on close.
import { useRef, useState } from 'react'
import { Settings2, X } from 'lucide-react'
import clsx from 'clsx'
import { SubagentModelSelect } from '@/components/ModelSelect'
import { ModalOverlay } from '@/components/ModalOverlay'

export type SubagentSettingsValue = {
  llmKey: string | null
  locked: boolean
  autoAccept: boolean
}

export function SubagentSettingsModal({ llms, value, locked, autoAccept, open, onOpenChange, onSave }: {
  llms: ReadonlyArray<{ key: string; name: string }>
  value: string | null
  locked: boolean
  autoAccept: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (next: SubagentSettingsValue) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const [draftKey, setDraftKey] = useState<string | null>(value)
  const [draftLocked, setDraftLocked] = useState(locked)
  const [draftAutoAccept, setDraftAutoAccept] = useState(autoAccept)

  const openDialog = () => {
    setDraftKey(value)
    setDraftLocked(value !== null && locked)
    setDraftAutoAccept(autoAccept)
    onOpenChange(true)
  }

  const closeDialog = () => {
    onOpenChange(false)
    requestAnimationFrame(() => triggerRef.current?.focus())
  }

  const save = () => {
    onSave({ llmKey: draftKey, locked: draftKey !== null && draftLocked, autoAccept: draftAutoAccept })
    closeDialog()
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="conductor-icon-button"
        title="子代理设置"
        aria-label="子代理设置"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openDialog}
      >
        <Settings2 size={17} />
      </button>
      {open && (
        <ModalOverlay
          onClose={closeDialog}
          panelRef={dialogRef}
          labelledBy="subagent-settings-title"
          panelClassName="w-full max-w-md"
        >
          <div className="flex items-center justify-between border-b border-line/70 px-5 py-4">
            <h2 id="subagent-settings-title" className="text-base font-semibold text-ink">子代理设置</h2>
            <button
              type="button"
              onClick={closeDialog}
              className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none text-ink-muted hover:bg-bg-soft hover:text-ink"
              aria-label="关闭子代理设置"
              title="关闭"
            >
              <X size={18} />
            </button>
          </div>
          <div className="space-y-5 px-5 py-5">
            <label className="block text-sm font-medium text-ink">
              默认模型
              <SubagentModelSelect
                llms={llms}
                value={draftKey}
                onChange={(key) => {
                  setDraftKey(key)
                  if (key === null) setDraftLocked(false)
                }}
                className="mt-2 w-full"
                aria-label="子代理默认模型"
                autoFocus
              />
            </label>
            <label
              className={clsx(
                'flex items-center gap-2 text-sm text-ink',
                draftKey === null && 'opacity-50',
              )}
            >
              <input
                type="checkbox"
                checked={draftLocked}
                disabled={draftKey === null}
                onChange={(event) => setDraftLocked(event.target.checked)}
              />
              固定使用所选模型
            </label>
            <div className="border-t border-line/70 pt-4">
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={draftAutoAccept}
                  onChange={(event) => setDraftAutoAccept(event.target.checked)}
                  aria-label="质检通过自动验收"
                />
                <span className="font-medium text-ink">质检通过自动验收</span>
              </label>
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-line/70 px-5 py-4">
            <button type="button" className="ga-btn" onClick={closeDialog}>取消</button>
            <button type="button" className="ga-btn ga-btn-primary" onClick={save}>保存</button>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
