import { useEffect, useRef, useState } from 'react'
import type { MemoryWriteRequest, MemoryWriteResponse } from '@/api/types'
import { useDirtyRouteGuard } from '@/stores/navigationGuardStore'
import { MarkdownEditor } from './MarkdownEditor'
import { FileText, RotateCcw, Save } from './ActionIcons'

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
  onDirtyChange?: (dirty: boolean) => void
}

export function VersionedMemoryEditor({ label, snapshot, onSave, onReload, onSaved, onError, onDirtyChange }: Props) {
  const [baseline, setBaseline] = useState(snapshot)
  const [value, setValue] = useState(snapshot.content)
  const [remoteChanged, setRemoteChanged] = useState(false)
  const [saving, setSaving] = useState(false)
  const [reloading, setReloading] = useState(false)
  const dirty = value !== baseline.content
  const snapshotVersion = `${snapshot.mtime_ns ?? ''}:${snapshot.sha256 ?? ''}`
  const observedVersion = useRef(snapshotVersion)
  const ignoredSavedVersion = useRef<string | null>(null)

  useEffect(() => {
    onDirtyChange?.(dirty)
    return () => onDirtyChange?.(false)
  }, [dirty, onDirtyChange])

  useDirtyRouteGuard('memory-editor', dirty, '当前记忆文档有未保存的编辑，离开将丢失这些修改。')

  useEffect(() => {
    if (snapshotVersion === observedVersion.current) return
    observedVersion.current = snapshotVersion
    if (ignoredSavedVersion.current === snapshotVersion) {
      ignoredSavedVersion.current = null
      return
    }
    ignoredSavedVersion.current = null
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
      const savedVersion = `${result.mtime_ns ?? ''}:${result.sha256 ?? ''}`
      ignoredSavedVersion.current = savedVersion === observedVersion.current ? null : savedVersion
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
      const reloadedVersion = `${latest.mtime_ns ?? ''}:${latest.sha256 ?? ''}`
      ignoredSavedVersion.current = reloadedVersion === observedVersion.current ? null : reloadedVersion
      setBaseline(latest)
      setValue(latest.content)
      setRemoteChanged(false)
    } catch (error) {
      onError?.(error)
    } finally {
      setReloading(false)
    }
  }

  const lineCount = value ? value.split('\n').length : 0

  return (
    <div className="ga-paper-card h-full flex flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line/70 bg-bg-soft/65 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-line/75 bg-bg-card text-accent">
            <FileText className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate font-mono text-xs font-medium text-ink" title={label}>{label}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                dirty
                  ? 'border-status-warning-line bg-status-warning-soft text-status-warning'
                  : 'border-line/70 bg-bg-card text-ink-faint'
              }`}>
                {dirty ? '未保存更改' : '已同步'}
              </span>
            </div>
            <div className="mt-0.5 text-[11px] tabular-nums text-ink-faint">
              {lineCount} 行 · {value.length} 字符
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {remoteChanged && (
            <>
              <span role="alert" className="text-xs text-status-warning">磁盘版本已变化，草稿未覆盖</span>
              <button
                type="button"
                disabled={reloading}
                onClick={reload}
                className="ga-btn-warning-sm"
              >
                <RotateCcw className="h-3 w-3" aria-hidden="true" />
                <span>{reloading ? '重载中…' : '放弃草稿并重载'}</span>
              </button>
            </>
          )}
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="ga-btn-primary"
          >
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{saving ? '保存中…' : dirty ? '保存' : '已保存'}</span>
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 p-3 bg-bg-card/45">
        <MarkdownEditor value={value} onChange={setValue} />
      </div>
    </div>
  )
}
