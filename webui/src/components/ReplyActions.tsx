import { useContext, useRef, useState } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import { toast } from '@/stores/toastStore'
import { useCopy } from '@/utils/clipboard'
import { errorMessageFromError } from '@/utils/sessionUi'
import { CopyIcon, FileText } from './ActionIcons'
import { FileLinkContext } from './FileCitation'
import { fileTransferQueryKey, saveTransferReply } from './FileTransferBox'

const actionClass = 'ga-btn-chip'

export function ReplyActions({ text, engine, canSave, project }: {
  text: string; engine: 'chat' | 'anti'; canSave: boolean; project?: string
}) {
  const { copied, copy } = useCopy()
  const { sessionId } = useContext(FileLinkContext)
  const cache = useContext(QueryClientContext)
  const inFlight = useRef(false)
  const [saving, setSaving] = useState(false)

  if (!text.trim()) return null
  const save = async () => {
    if (!canSave || !sessionId || inFlight.current) return
    inFlight.current = true
    setSaving(true)
    try {
      await saveTransferReply({ text, engine, session_id: sessionId, project })
      void cache?.invalidateQueries({ queryKey: fileTransferQueryKey })
      toast.success('回复文档已放入传递箱')
    } catch (error) {
      toast.error(errorMessageFromError(error, '保存回复文档失败'))
    } finally {
      inFlight.current = false
      setSaving(false)
    }
  }

  return <>
    <button type="button" onClick={() => copy(text)} title="复制结论" className={actionClass}>
      <CopyIcon copied={copied} size={12} />
      <span>{copied ? '已复制' : '复制'}</span>
    </button>
    {canSave && sessionId && (
      <button type="button" onClick={() => void save()} disabled={saving}
        title="将回复结论保存为 Markdown 并放入传递箱" className={actionClass}>
        <FileText size={12} strokeWidth={1.85} aria-hidden="true" className="shrink-0" />
        <span>{saving ? '保存中…' : '转成文档'}</span>
      </button>
    )}
  </>
}
