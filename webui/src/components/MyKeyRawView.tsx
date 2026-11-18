import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { MyKeyBackup, MyKeyData, MyKeyWriteResult } from '@/api/types'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { queryKeys } from '@/queries/queryKeys'
import { ModalOverlay } from '@/components/ModalOverlay'
import { myKeyParseErrorFromError } from '@/utils/sessionUi'
import { errorMessageFromError } from '@/utils/sessionUi'
import { formatDateTime } from '@/utils/formatTime'

// ── raw view ────────────────────────────────────────────────────────
export function RawView({ data, onWrite, onDirtyChange }: {
  data: MyKeyData
  onWrite: (r: MyKeyWriteResult) => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [baseline, setBaseline] = useState(data.raw)
  const [text, setText] = useState(data.raw)
  const [remoteChanged, setRemoteChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showBackups, setShowBackups] = useState(false)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const lineNumbersRef = useRef<HTMLPreElement>(null)
  const observedRaw = useRef(data.raw)
  const syncLineNumbers = useCallback(() => {
    if (editorRef.current && lineNumbersRef.current) {
      // Transform instead of scrolling the gutter: a horizontal scrollbar can
      // give the textarea a different maximum scrollTop from the gutter.
      lineNumbersRef.current.style.transform = `translateY(${-editorRef.current.scrollTop}px)`
    }
  }, [])

  const dirty = text !== baseline
  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (data.raw === observedRaw.current) return
    observedRaw.current = data.raw
    if (text !== baseline) {
      if (data.raw === text) {
        setBaseline(data.raw)
        setRemoteChanged(false)
      } else {
        setRemoteChanged(true)
      }
      return
    }
    setText(data.raw)
    setBaseline(data.raw)
    setRemoteChanged(false)
  }, [data.raw, text, baseline])

  useLayoutEffect(syncLineNumbers, [text, syncLineNumbers])

  const lines = useMemo(() => text.split('\n'), [text])
  const pad = String(lines.length).length

  const save = async () => {
    if (saving) return
    setErr(null); setSaving(true)
    try {
      const r = await api.putMyKeyRaw(text)
      setBaseline(text)
      setRemoteChanged(false)
      onWrite(r)
    } catch (e: unknown) {
      setErr(myKeyParseErrorFromError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-slate-400">
          <span className="font-mono break-all">{data.path}</span>
          {dirty && <span className="text-status-warning">(未保存)</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowBackups(true)}
            className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5">备份历史</button>
          <button onClick={() => { setText(data.raw); setBaseline(data.raw); setRemoteChanged(false) }} disabled={!dirty && !remoteChanged}
            className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 disabled:opacity-40">还原</button>
          <button onClick={save} disabled={!dirty || saving}
            className="px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-40">
            {saving ? '保存中…' : '保存并热更新'}
          </button>
        </div>
      </div>

      {remoteChanged && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-status-warning-line bg-status-warning-soft px-3 py-2 text-xs text-status-warning">
          <span>外部 mykey.py 已更新，未保存草稿已保留。</span>
          <button
            type="button"
            onClick={() => { setText(data.raw); setBaseline(data.raw); setRemoteChanged(false) }}
            className="rounded border border-status-warning-line px-2 py-1 text-status-warning hover:bg-bg-card"
          >
            采用最新原文
          </button>
        </div>
      )}

      {err && (
        <div className="text-xs text-status-danger bg-status-danger-soft border border-status-danger-line rounded p-2 break-words">
          ✗ {err}
        </div>
      )}

      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex max-h-[70vh]">
        <div aria-hidden="true" className="select-none shrink-0 overflow-hidden bg-bg-soft border-r border-line">
          <pre ref={lineNumbersRef} className="text-right pr-2 pl-3 py-3 text-xs font-mono leading-6 text-slate-600">
            {lines.map((_, i) => <div key={i} style={{ minWidth: `${pad}ch` }}>{i + 1}</div>)}
          </pre>
        </div>
        <textarea
          ref={editorRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onScroll={syncLineNumbers}
          spellCheck={false}
          wrap="off"
          className="flex-1 min-w-0 p-3 bg-bg-card outline-none font-mono text-xs leading-6 resize-none overflow-x-auto whitespace-pre"
          rows={Math.max(20, lines.length)}
          style={{ minHeight: '60vh' }}
        />
      </div>

      {showBackups && (
        <BackupDrawer onClose={() => setShowBackups(false)} onRestored={onWrite} />
      )}
    </div>
  )
}

function BackupDrawer({ onClose, onRestored }: {
  onClose: () => void
  onRestored: (r: MyKeyWriteResult) => void
}) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: queryKeys.mykey.backups,
    queryFn: api.mykeyBackups,
  })
  const [busy, setBusy] = useState<string | null>(null)
  const backups = data?.backups ?? []

  const restore = async (name: string) => {
    const ok = await dialog.confirm(
      '回滚到此备份？',
      `当前内容会先被保存为新的备份再被覆盖（不会丢失）。`,
      { confirmText: '回滚' },
    )
    if (!ok) return
    setBusy(name)
    try {
      const r = await api.restoreMyKeyBackup(name)
      onRestored(r)
      toast.success('已回滚到该备份')
      onClose()
    } catch (e: any) {
      dialog.alert('回滚失败', errorMessageFromError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <ModalOverlay onClose={onClose} align="right" panelClassName="w-[28rem] h-full border-l flex flex-col">
        <header className="px-5 py-3 border-b border-line flex items-baseline justify-between">
          <div>
            <h3 className="text-base font-semibold">备份历史</h3>
            <p className="text-xs text-slate-500 mt-0.5">最近 10 份；保存在 admin 数据目录，与 GA 仓库无关</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-xl leading-none">×</button>
        </header>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {isLoading && <div className="text-slate-500 text-sm p-4">载入中…</div>}
          {!isLoading && backups.length === 0 && (
            <div className="text-slate-500 text-sm p-6 text-center">尚无备份</div>
          )}
          {backups.map((b) => (
            <div key={b.name} className="rounded-lg border border-line bg-bg-card p-3">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="text-xs text-slate-400 font-mono truncate" title={b.name}>{b.name}</div>
                <button onClick={() => restore(b.name)} disabled={busy !== null}
                  className="text-xs px-2.5 py-1 rounded bg-accent text-white disabled:opacity-40">
                  {busy === b.name ? '回滚中…' : '↩ 回滚'}
                </button>
              </div>
              <div className="text-[10px] text-slate-500">
                {formatDateTime(b.mtime)} · {(b.size / 1024).toFixed(1)} KB
              </div>
            </div>
          ))}
        </div>
        <footer className="border-t border-line px-4 py-2 text-xs text-slate-500 flex items-center justify-end">
          <button onClick={() => refetch()} className="text-accent hover:underline">↻ 刷新</button>
        </footer>
    </ModalOverlay>
  )
}

