import { useContext, useRef, useState } from 'react'
import { QueryClientContext } from '@tanstack/react-query'
import { toast } from '@/stores/toastStore'
import { useCopy } from '@/utils/clipboard'
import { errorMessageFromError } from '@/utils/sessionUi'
import { FileLinkContext } from './FileCitation'
import { fileTransferQueryKey, saveTransferReply } from './FileTransferBox'

const actionClass = 'rounded-md border border-line bg-bg-soft px-2.5 py-1 text-[11px] leading-none text-ink-muted transition-colors hover:bg-bg-card hover:text-ink disabled:opacity-50'

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
      {copied ? '✓ 已复制' : '⧉ 复制'}
    </button>
    {canSave && sessionId && (
      <button type="button" onClick={() => void save()} disabled={saving}
        title="将回复结论保存为 Markdown 并放入传递箱" className={actionClass}>
        {saving ? '保存中…' : '转成文档'}
      </button>
    )}
  </>
}
