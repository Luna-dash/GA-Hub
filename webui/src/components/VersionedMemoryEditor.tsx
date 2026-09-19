import { useEffect, useRef, useState } from 'react'
import type { MemoryWriteRequest, MemoryWriteResponse } from '@/api/types'
import { MarkdownEditor } from './MarkdownEditor'

export interface MemorySnapshot {
  content: string
  mtime_ns: string | null
  sha256: string | null
}

interface Props {
  label: string
  snapshot: MemorySnapshot
  onSave: (body: MemoryWriteRequest) => Promise<MemoryWriteResponse>
  onReload: () => Promise<MemorySnapshot>
  onSaved?: () => void
  onError?: (error: unknown) => void
}

export function VersionedMemoryEditor({ label, snapshot, onSave, onReload, onSaved, onError }: Props) {
  const [baseline, setBaseline] = useState(snapshot)
  const [value, setValue] = useState(snapshot.content)
  const [remoteChanged, setRemoteChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const dirty = value !== baseline.content
  const snapshotVersion = `${snapshot.mtime_ns ?? ''}:${snapshot.sha256 ?? ''}`
  const observedVersion = useRef(snapshotVersion)

  useEffect(() => {
    if (snapshotVersion === observedVersion.current) return
    observedVersion.current = snapshotVersion
    if (dirty) {
      setRemoteChanged(true)
      return
    }
    setBaseline(snapshot)
    setValue(snapshot.content)
    setRemoteChanged(false)
  }, [snapshot, snapshotVersion, dirty])

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    try {
      const result = await onSave({
        content: value,
        expected_mtime_ns: baseline.mtime_ns,
        expected_sha256: baseline.sha256,
      })
      setBaseline({ content: value, mtime_ns: result.mtime_ns, sha256: result.sha256 })
      setRemoteChanged(false)
      onSaved?.()
    } catch (error) {
      if ((error as { status?: number })?.status === 409) setRemoteChanged(true)
      onError?.(error)
    } finally {
      setSaving(false)
    }
  }

  const reload = async () => {
    if (reloading) return
    setReloading(true)
    try {
      const latest = await onReload()
      setBaseline(latest)
      setValue(latest.content)
      setRemoteChanged(false)
    } catch (error) {
      onError?.(error)
    } finally {
      setReloading(false)
    }
  }

  return (
    <div className="h-full flex flex-col space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 text-xs text-slate-500 font-mono truncate">{label}</div>
        <div className="flex items-center gap-2 shrink-0">
          {remoteChanged && (
            <>
              <span role="alert" className="text-xs text-amber-400">磁盘版本已变化，草稿未覆盖</span>
              <button
                disabled={reloading}
                onClick={reload}
                className="px-2.5 py-1.5 rounded-lg border border-amber-500/50 text-amber-300 text-xs disabled:opacity-40"
              >{reloading ? '重载中…' : '放弃草稿并重载'}</button>
            </>
          )}
          <button
            disabled={!dirty || saving}
            onClick={save}
            className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
          >{saving ? '保存中…' : dirty ? '保存' : '已保存'}</button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <MarkdownEditor value={value} onChange={setValue} />
      </div>
    </div>
  )
}
