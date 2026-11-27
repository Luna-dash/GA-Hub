import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, HardDrive, Trash2 } from 'lucide-react'
import { storageApi, type StorageCategory, type StorageSummary } from '@/api/client'
import { RefreshIcon } from '@/components/ActionIcons'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError } from '@/utils/sessionUi'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx += 1
  }
  return `${value >= 100 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

export function StorageSettingsPanel({ active = true }: { active?: boolean } = {}) {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [cleaningId, setCleaningId] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const data = await storageApi.summary(signal)
      setSummary(data)
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') return
      setError(errorMessageFromError(e, '无法读取磁盘占用统计'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void refresh(controller.signal)
    return () => controller.abort()
  }, [active, refresh])

  const cleanCategories = async (categories: StorageCategory[], label: string) => {
    const cleanable = categories.filter(item => item.cleanable && item.bytes > 0)
    if (cleanable.length === 0) {
      toast.info('当前没有可清理的内容')
      return
    }
    const hasCaution = cleanable.some(item => item.caution)
    const ok = await dialog.confirm(
      `确认清理「${label}」？`,
      hasCaution
        ? `即将删除所选目录中的文件（共 ${formatBytes(cleanable.reduce((s, c) => s + c.bytes, 0))}），包含会话附件或 Agy 历史记录等不可恢复数据。清理操作无法撤销，确认继续吗？`
        : `即将清理 ${formatBytes(cleanable.reduce((s, c) => s + c.bytes, 0))} 的临时文件或工具链缓存，不影响对话历史与个人配置。`,
      {
        confirmText: hasCaution ? '确认永久删除' : '确认清理',
        tone: hasCaution ? 'danger' : undefined,
      },
    )
    if (!ok) return

    const busyKey = cleanable.length === 1 ? cleanable[0].id : '__safe_all__'
    setCleaningId(busyKey)
    setError('')
    try {
      const result = await storageApi.cleanup(cleanable.map(c => c.id))
      setSummary(result.summary)
      if (result.failed_entries > 0) {
        toast.info(`已释放 ${formatBytes(result.reclaimed_bytes)}，有 ${result.failed_entries} 项正被占用未能删除`)
      } else {
        toast.success(`已释放 ${formatBytes(result.reclaimed_bytes)}`)
      }
    } catch (e) {
      const msg = errorMessageFromError(e, '清理失败')
      setError(msg)
      toast.error(msg)
    } finally {
      setCleaningId(null)
    }
  }

  const safeCleanable = (summary?.categories ?? []).filter(c => c.cleanable && !c.caution && c.bytes > 0)
  const safeBytes = safeCleanable.reduce((sum, item) => sum + item.bytes, 0)

  return (
    <section className="space-y-4" aria-label="存储与缓存管理">
      <div className="ga-paper-card p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
            <HardDrive className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-ink">
              本地缓存与运行数据
              {summary && (
                <span className="ml-2 text-xs font-normal tabular-nums text-ink-muted">
                  共 {formatBytes(summary.total_bytes)}
                </span>
              )}
            </div>
            <div className="text-xs text-ink-faint mt-0.5">
              Agy 历史记录（.gemini）与聊天上传文件绝不会自动删除，仅在您手动确认后清理。
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading || cleaningId !== null}
            className="ga-btn-sm"
          >
            <RefreshIcon spinning={loading} size={13} />
            <span>{loading ? '扫描中…' : '重新扫描'}</span>
          </button>
          <button
            type="button"
            onClick={() => void cleanCategories(safeCleanable, '全部安全缓存')}
            disabled={loading || cleaningId !== null || safeCleanable.length === 0}
            className="ga-btn-primary"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {cleaningId === '__safe_all__'
                ? '清理中…'
                : safeBytes > 0
                  ? `一键清理安全缓存 (${formatBytes(safeBytes)})`
                  : '安全缓存已清空'}
            </span>
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-xl border border-status-danger-line bg-status-danger-soft px-4 py-3 text-xs text-status-danger">
          {error}
        </div>
      )}

      {!summary && loading && (
        <div className="ga-paper-card p-6 text-center text-xs text-ink-faint">正在统计本地磁盘占用…</div>
      )}

      {summary && (
        <div className="space-y-2.5">
          {summary.categories.map(category => {
            const busy = cleaningId === category.id || cleaningId === '__safe_all__'
            return (
              <div key={category.id} className="ga-paper-card p-3.5 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{category.label}</span>
                    <span className="rounded-full bg-bg-soft px-2 py-0.5 text-[11px] font-medium tabular-nums text-ink">
                      {formatBytes(category.bytes)}
                    </span>
                    <span className="text-[11px] tabular-nums text-ink-faint">
                      {category.file_count.toLocaleString()} 个文件
                    </span>
                    {category.caution && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-status-warning-line bg-status-warning-soft px-2 py-0.5 text-[10px] font-medium text-status-warning">
                        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                        <span>需谨慎清理</span>
                      </span>
                    )}
                    {!category.cleanable && (
                      <span className="rounded-full border border-line/60 bg-bg-soft px-2 py-0.5 text-[10px] text-ink-faint">
                        仅查看（运行中占用）
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-muted leading-relaxed">{category.description}</p>
                  <p className="font-mono text-[11px] text-ink-faint break-all">{category.path}</p>
                </div>
                {category.cleanable && (
                  <button
                    type="button"
                    onClick={() => void cleanCategories([category], category.label)}
                    disabled={loading || busy || category.bytes <= 0}
                    className={category.caution
                      ? 'ga-btn-sm shrink-0 text-status-danger hover:border-status-danger/60 hover:bg-status-danger-soft disabled:opacity-45'
                      : 'ga-btn-sm shrink-0 disabled:opacity-45'}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                    <span>{busy ? '清理中…' : '清理'}</span>
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
