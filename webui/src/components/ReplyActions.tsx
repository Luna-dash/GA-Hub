import { useContext, useRef, useState } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import { LoaderCircle, PackagePlus } from 'lucide-react'
import { toast } from '@/stores/toastStore'
import { useCopy } from '@/utils/clipboard'
import { errorMessageFromError } from '@/utils/sessionUi'
import { CopyIcon } from './ActionIcons'
import { FileLinkContext } from './FileCitation'
import { fileTransferQueryKey, saveTransferReply } from './FileTransferBox'

const actionClass = 'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line/80 bg-bg-card/95 text-ink-muted transition-colors hover:border-accent/60 hover:bg-bg-soft hover:text-ink disabled:cursor-not-allowed disabled:opacity-45'

export function ReplyActions({ text, engine, canSave, project }: {
  text: string; engine: 'chat' | 'anti'; canSave: boolean; project?: string
}) {
  const { copied, copy } = useCopy()
  const { sessionId, project: contextProject } = useContext(FileLinkContext)
  const resolvedProject = project || contextProject
  const cache = useContext(QueryClientContext)
  const inFlight = useRef(false)
  const [saving, setSaving] = useState(false)

  if (!text.trim()) return null
  const save = async () => {
    if (!canSave || !sessionId || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    try {
      await saveTransferReply({
        text,
        engine,
        session_id: sessionId,
        ...(resolvedProject ? { project: resolvedProject } : {}),
      })
      void cache?.invalidateQueries({ queryKey: fileTransferQueryKey })
      toast.success('已放入中转箱')
    } catch (error) {
      toast.error(errorMessageFromError(error, '放入中转箱失败'))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <>
    <button
      type="button"
      onClick={() => copy(text)}
      title="复制结论"
      aria-label={copied ? '已复制结论' : '复制结论'}
      className={actionClass}
    >
      <CopyIcon copied={copied} size={12} />
    </button>
    {canSave && sessionId && (
      <button
        type="button"
        onClick={() => void save()}
        disabled={saving}
        title="放入中转箱"
        aria-label={saving ? '正在放入中转箱…' : '放入中转箱'}
        className={actionClass}
      >
        {saving
          ? <LoaderCircle size={12} strokeWidth={1.85} aria-hidden="true" className="shrink-0 animate-spin" />
          : <PackagePlus size={12} strokeWidth={1.85} aria-hidden="true" className="shrink-0" />}
      </button>
    )}
  </>
}
