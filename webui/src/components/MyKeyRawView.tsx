import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { MyKeyBackup, MyKeyData, MyKeyWriteResult } from '@/api/types'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { queryKeys } from '@/queries/queryKeys'

// ── raw view ────────────────────────────────────────────────────────
export function RawView({ data, onWrite }: { data: MyKeyData; onWrite: (r: MyKeyWriteResult) => void }) {
  const [text, setText] = useState(data.raw)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [showBackups, setShowBackups] = useState(false)

  useEffect(() => setText(data.raw), [data.raw])

  const dirty = text !== data.raw
  const lines = useMemo(() => text.split('\n'), [text])
  const pad = String(lines.length).length

  const save = async () => {
    setErr(null); setSaving(true)
    try {
      const r = await api.putMyKeyRaw(text)
      onWrite(r)
    } catch (e: any) {
      const body = e?.body?.detail
      const msg = (body && typeof body === 'object')
        ? `第 ${body.line}:${body.col} 行 — ${body.message}`
        : (e?.body || e?.message || String(e))
      setErr(typeof msg === 'string' ? msg : JSON.stringify(msg))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 text-slate-400">
          <span className="font-mono break-all">{data.path}</span>
          {dirty && <span className="text-amber-300">(未保存)</span>}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowBackups(true)}
            className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5">备份历史</button>
          <button onClick={() => setText(data.raw)} disabled={!dirty}
            className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 disabled:opacity-40">还原</button>
          <button onClick={save} disabled={!dirty || saving}
            className="px-3 py-1.5 rounded-lg bg-accent text-white disabled:opacity-40">
            {saving ? '保存中…' : '保存并热更新'}
          </button>
        </div>
      </div>

      {err && (
        <div className="text-xs text-rose-400 bg-rose-900/20 border border-rose-700/40 rounded p-2 break-words">
          ✗ {err}
        </div>
      )}

      <div className="rounded-lg border border-line bg-bg-card overflow-hidden flex">
        <pre className="select-none text-right pr-2 pl-3 py-3 text-xs font-mono leading-6 text-slate-600 bg-bg-soft border-r border-line">
          {lines.map((_, i) => <div key={i} style={{ minWidth: `${pad}ch` }}>{i + 1}</div>)}
        </pre>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="flex-1 p-3 bg-bg-card outline-none font-mono text-xs leading-6 resize-none"
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
      dialog.alert('回滚失败', e?.body?.detail || e?.message || String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/55 flex items-end justify-end" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-[28rem] h-full bg-bg-soft border-l border-line flex flex-col"
           onClick={(e) => e.stopPropagation()}>
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
                {new Date(b.mtime * 1000).toLocaleString()} · {(b.size / 1024).toFixed(1)} KB
              </div>
            </div>
          ))}
        </div>
        <footer className="border-t border-line px-4 py-2 text-xs text-slate-500 flex items-center justify-end">
          <button onClick={() => refetch()} className="text-accent hover:underline">↻ 刷新</button>
        </footer>
      </div>
    </div>
  )
}

