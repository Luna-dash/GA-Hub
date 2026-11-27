import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Clock, HardDrive, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react'
import {
  storageApi,
  type AgyGcPolicy,
  type AgyGcPolicyStatus,
  type StorageCategory,
  type StorageSummary,
} from '@/api/client'
import { RefreshIcon } from '@/components/ActionIcons'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import { extractErrorMessage } from '@/utils/errors'

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

function formatTime(iso: string | null): string {
  if (!iso) return '尚未执行'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export function StorageSettingsPanel({ active = true }: { active?: boolean } = {}) {
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [gcStatus, setGcStatus] = useState<AgyGcPolicyStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [cleaningId, setCleaningId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [policyError, setPolicyError] = useState('')
  const [showPolicy, setShowPolicy] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    setPolicyError('')
    try {
      const [summaryRes, policyRes] = await Promise.allSettled([
        storageApi.summary(signal),
        storageApi.agyGcPolicy(signal),
      ])
      if (summaryRes.status === 'fulfilled') {
        setSummary(summaryRes.value)
      } else if ((summaryRes.reason as { name?: string })?.name !== 'AbortError') {
        setError(extractErrorMessage(summaryRes.reason, '无法读取磁盘占用统计'))
      }
      if (policyRes.status === 'fulfilled') {
        setGcStatus(policyRes.value)
      } else if ((policyRes.reason as { name?: string })?.name !== 'AbortError') {
        setPolicyError(extractErrorMessage(policyRes.reason, '无法读取自动清理策略'))
      }
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        setError(extractErrorMessage(e, '无法读取磁盘占用统计'))
      }
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

  const patchPolicy = async (patch: Partial<AgyGcPolicy>) => {
    setSavingPolicy(true)
    try {
      const updated = await storageApi.updateAgyGcPolicy(patch)
      setGcStatus(updated)
      const nextSummary = await storageApi.summary()
      setSummary(nextSummary)
    } catch (e) {
      toast.error(extractErrorMessage(e, '保存自动清理策略失败'))
    } finally {
      setSavingPolicy(false)
    }
  }

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
        ? `即将清理所选项目（共 ${formatBytes(cleanable.reduce((s, c) => s + c.bytes, 0))}），可能包含聊天附件或冷门 Agy 会话的底层状态库（聊天文字仍保留）。清理无法撤销，确认继续吗？`
        : `即将清理 ${formatBytes(cleanable.reduce((s, c) => s + c.bytes, 0))} 的临时缓存、重复副本或已结束子会话存档，不影响活跃主会话核心与个人配置。`,
      {
        confirmText: hasCaution ? '确认永久清理' : '确认清理',
        tone: hasCaution ? 'danger' : undefined,
      },
    )
    if (!ok) return

    const busyKey = cleanable.length === 1 ? cleanable[0].id : '__safe_all__'
    setCleaningId(busyKey)
    try {
      const result = await storageApi.cleanup(cleanable.map(c => c.id))
      setSummary(result.summary)
      if (result.failed_entries > 0) {
        toast.info(`已释放 ${formatBytes(result.reclaimed_bytes)}，有 ${result.failed_entries} 项正被占用未能删除`)
      } else {
        toast.success(`已释放 ${formatBytes(result.reclaimed_bytes)}`)
      }
    } catch (e) {
      toast.error(extractErrorMessage(e, '清理失败'))
    } finally {
      setCleaningId(null)
    }
  }

  const safeCleanable = (summary?.categories ?? []).filter(c => c.cleanable && !c.caution && c.bytes > 0)
  const safeBytes = safeCleanable.reduce((sum, item) => sum + item.bytes, 0)
  const policy = gcStatus?.policy

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
              活跃主会话核心与聊天上传文件受保护；L0~L2 次要/重复存档支持空闲定时自动清理，L3 需手动确认或主动开启。
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {policy && (
            <button
              type="button"
              onClick={() => setShowPolicy(v => !v)}
              className="ga-btn-sm"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{showPolicy ? '收起自动策略' : '自动清理策略'}</span>
            </button>
          )}
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
            onClick={() => void cleanCategories(safeCleanable, '全部安全项（含 L0~L2）')}
            disabled={loading || cleaningId !== null || safeCleanable.length === 0}
            className="ga-btn-primary"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>
              {cleaningId === '__safe_all__'
                ? '清理中…'
                : safeBytes > 0
                  ? `一键清理安全项 (${formatBytes(safeBytes)})`
                  : '安全项已清空'}
            </span>
          </button>
        </div>
      </div>

      {policyError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-status-warning-line bg-status-warning-soft px-4 py-2.5 text-xs text-status-warning">
          <span>自动清理策略加载失败：{policyError}</span>
          <button
            type="button"
            className="ga-btn-xs"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? '重试中…' : '重试'}
          </button>
        </div>
      )}

      {policy && showPolicy && (
        <div className="ga-paper-card p-4 space-y-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/60 pb-2.5">
            <div className="flex items-center gap-2">
              <Clock className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              <span className="text-sm font-medium text-ink">Agy 分层定时自动清理</span>
              <span className="text-ink-faint">
                上次执行：{formatTime(gcStatus?.last_run_at ?? null)}
                {gcStatus && gcStatus.last_reclaimed_bytes > 0
                  ? `（释放 ${formatBytes(gcStatus.last_reclaimed_bytes)}）`
                  : ''}
              </span>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={policy.auto_enabled}
                disabled={savingPolicy}
                onChange={e => void patchPolicy({ auto_enabled: e.target.checked })}
              />
              <span className="font-medium text-ink">启用空闲自动清理</span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-bg-soft/50 px-3 py-2">
              <span className="text-ink">L0 孤儿存档与过期日志</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={policy.l0_log_retention_days}
                  disabled={savingPolicy}
                  onChange={e => {
                    const v = Number(e.target.value)
                    if (Number.isInteger(v) && v >= 1) void patchPolicy({ l0_log_retention_days: v })
                  }}
                  className="w-14 rounded border border-line bg-surface px-1.5 py-0.5 text-right tabular-nums"
                  aria-label="L0 日志保留天数"
                />
                <span className="text-ink-faint">天</span>
                <input
                  type="checkbox"
                  checked={policy.l0_orphans_enabled}
                  disabled={savingPolicy}
                  onChange={e => void patchPolicy({ l0_orphans_enabled: e.target.checked })}
                  aria-label="启用 L0 自动清理"
                />
              </span>
            </label>

            <label className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-bg-soft/50 px-3 py-2">
              <span className="text-ink">L1 活跃会话冗余副本（宽限小时）</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={720}
                  value={policy.l1_grace_hours}
                  disabled={savingPolicy}
                  onChange={e => {
                    const v = Number(e.target.value)
                    if (Number.isInteger(v) && v >= 0) void patchPolicy({ l1_grace_hours: v })
                  }}
                  className="w-14 rounded border border-line bg-surface px-1.5 py-0.5 text-right tabular-nums"
                  aria-label="L1 宽限小时"
                />
                <span className="text-ink-faint">小时</span>
                <input
                  type="checkbox"
                  checked={policy.l1_redundant_enabled}
                  disabled={savingPolicy}
                  onChange={e => void patchPolicy({ l1_redundant_enabled: e.target.checked })}
                  aria-label="启用 L1 自动清理"
                />
              </span>
            </label>

            <label className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-bg-soft/50 px-3 py-2">
              <span className="text-ink">L2 已结束子会话（已完结保留天数）</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={policy.l2_idle_retention_days}
                  disabled={savingPolicy}
                  onChange={e => {
                    const v = Number(e.target.value)
                    if (Number.isInteger(v) && v >= 1) void patchPolicy({ l2_idle_retention_days: v })
                  }}
                  className="w-14 rounded border border-line bg-surface px-1.5 py-0.5 text-right tabular-nums"
                  aria-label="L2 已完结子会话保留天数"
                />
                <span className="text-ink-faint">天</span>
                <input
                  type="checkbox"
                  checked={policy.l2_subagents_enabled}
                  disabled={savingPolicy}
                  onChange={e => void patchPolicy({ l2_subagents_enabled: e.target.checked })}
                  aria-label="启用 L2 自动清理"
                />
              </span>
            </label>

            <label className="flex items-center justify-between gap-2 rounded-lg border border-line/60 bg-bg-soft/50 px-3 py-2">
              <span className="text-ink">L3 冷门主会话降级（默认关闭）</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={7}
                  max={3650}
                  value={policy.l3_cold_root_days}
                  disabled={savingPolicy}
                  onChange={e => {
                    const v = Number(e.target.value)
                    if (Number.isInteger(v) && v >= 7) void patchPolicy({ l3_cold_root_days: v })
                  }}
                  className="w-14 rounded border border-line bg-surface px-1.5 py-0.5 text-right tabular-nums"
                  aria-label="L3 冷门主会话天数"
                />
                <span className="text-ink-faint">天</span>
                <input
                  type="checkbox"
                  checked={policy.l3_cold_roots_enabled}
                  disabled={savingPolicy}
                  onChange={e => void patchPolicy({ l3_cold_roots_enabled: e.target.checked })}
                  aria-label="启用 L3 自动清理"
                />
              </span>
            </label>
          </div>
        </div>
      )}

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
            const isProtectedCore = category.id === 'agy_active_core'
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
                    {!category.cleanable && isProtectedCore && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 text-[10px] font-medium text-accent">
                        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                        <span>受保护（主要信息）</span>
                      </span>
                    )}
                    {!category.cleanable && !isProtectedCore && (
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
                    className={category.caution ? 'ga-btn-sm-danger shrink-0' : 'ga-btn-sm shrink-0'}
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
