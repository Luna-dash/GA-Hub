import { ArrowUp, ChevronDown, ChevronUp, Clock, Paperclip, PauseCircle, X } from 'lucide-react'
import clsx from 'clsx'
import type { AntiQueuedPromptItem } from '@/api/client'

export interface AntiQueuedDockProps {
  items: AntiQueuedPromptItem[]
  paused: boolean
  pauseReason: string | null
  hasActiveRun: boolean
  canNativeSteer: boolean
  collapsed: boolean
  busy?: boolean
  steerPending?: boolean
  dispatchPending?: boolean
  pendingEditItem: AntiQueuedPromptItem | null
  onToggleCollapsed: () => void
  onClearAll: () => void
  onMoveItem: (id: string, direction: 'up' | 'down' | 'top') => void
  onSteerItem: (item: AntiQueuedPromptItem) => void
  onDispatchItem: (item: AntiQueuedPromptItem) => void
  onEditItem: (item: AntiQueuedPromptItem) => void
  onRemoveItem: (id: string) => void
  onConfirmEditStashDraft: () => void
  onConfirmEditOverwriteDraft: () => void
  onCancelPendingEdit: () => void
}

export function AntiQueuedDock({
  items,
  paused,
  pauseReason,
  hasActiveRun,
  canNativeSteer,
  collapsed,
  busy = false,
  steerPending = false,
  dispatchPending = false,
  pendingEditItem,
  onToggleCollapsed,
  onClearAll,
  onMoveItem,
  onSteerItem,
  onDispatchItem,
  onEditItem,
  onRemoveItem,
  onConfirmEditStashDraft,
  onConfirmEditOverwriteDraft,
  onCancelPendingEdit,
}: AntiQueuedDockProps) {
  if (items.length === 0) return null

  const statusText = paused
    ? (pauseReason || '上一轮未完成，已暂停自动发送')
    : '本轮完成后按顺序自动发送'

  return (
    <section
      role="region"
      aria-label="待发队列"
      data-anti-queued-dock
      className={clsx(
        'mx-3 mt-2 flex shrink-0 flex-col rounded-xl border bg-bg-card shadow-[0_-4px_16px_rgba(45,34,22,0.08)]',
        paused ? 'border-status-warning-line/85' : 'border-accent/35',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {paused ? (
            <PauseCircle size={15} className="shrink-0 text-status-warning" aria-hidden="true" />
          ) : (
            <Clock size={15} className="shrink-0 text-accent" aria-hidden="true" />
          )}
          <span className="shrink-0 font-semibold text-ink">待发队列</span>
          <span
            className={clsx(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums',
              paused
                ? 'bg-status-warning-soft text-status-warning'
                : 'bg-accent-soft/80 text-accent',
            )}
          >
            {items.length} 条
          </span>
          <span
            className={clsx(
              'min-w-0 truncate text-[11px]',
              paused ? 'text-status-warning' : 'text-ink-muted',
            )}
            title={statusText}
          >
            {statusText}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {paused && items[0] && (
            <button
              type="button"
              className="ga-btn-sm-primary"
              disabled={busy || dispatchPending}
              onClick={() => onDispatchItem(items[0])}
            >
              继续发送
            </button>
          )}
          <button
            type="button"
            className="ga-btn-link inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-ink"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开待发队列' : '收起待发队列'}
            onClick={onToggleCollapsed}
          >
            <span>{collapsed ? '展开' : '收起'}</span>
            {collapsed
              ? <ChevronUp size={13} aria-hidden="true" />
              : <ChevronDown size={13} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="ga-btn-link shrink-0 px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-status-danger disabled:opacity-45"
            disabled={busy}
            onClick={onClearAll}
          >
            清空
          </button>
        </div>
      </div>

      {pendingEditItem && (
        <div
          data-anti-queue-edit-conflict
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 border-t border-status-warning-line/60 bg-status-warning-soft/55 px-3.5 py-2 text-xs text-ink"
        >
          <span className="min-w-0 flex-1 text-status-warning">
            输入框已有未发送草稿，选择如何处理后回填排队消息：
          </span>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              className="ga-btn-sm-primary"
              disabled={busy}
              onClick={onConfirmEditStashDraft}
            >
              草稿先入队再编辑
            </button>
            <button
              type="button"
              className="ga-btn-sm"
              disabled={busy}
              onClick={onConfirmEditOverwriteDraft}
            >
              覆盖当前草稿
            </button>
            <button
              type="button"
              className="ga-btn-sm"
              disabled={busy}
              onClick={onCancelPendingEdit}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="max-h-44 overflow-y-auto divide-y divide-line/45 border-t border-line/45">
          {items.map((item, idx) => {
            const totalAtts = (item.attachments?.length ?? 0) + (item.references?.length ?? 0)
            const attNames = [
              ...(item.attachments ?? []).map(a => a.name || a.path),
              ...(item.references ?? []).map(r => r.path),
            ].filter(Boolean).join('\n')
            const preview = item.prompt.trim()
            return (
              <div
                key={item.id}
                data-anti-queued-item={item.id}
                className="flex items-start justify-between gap-2 px-3.5 py-2 text-xs"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <span
                    className={clsx(
                      'mt-0.5 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums',
                      idx === 0
                        ? 'bg-accent-soft/80 text-accent'
                        : 'bg-bg-soft text-ink-muted',
                    )}
                  >
                    {idx === 0 ? '下一条' : `#${idx + 1}`}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={clsx('line-clamp-2 break-words text-xs leading-5', preview ? 'text-ink' : 'italic text-ink-muted')}
                      title={preview || '（仅附件）'}
                    >
                      {preview || '（仅附件）'}
                    </p>
                    {totalAtts > 0 && (
                      <span
                        className="mt-1 inline-flex items-center gap-1 rounded-md border border-line/65 bg-bg-soft px-1.5 py-0.5 text-[10px] text-ink-muted"
                        title={attNames || `${totalAtts} 个附件`}
                      >
                        <Paperclip size={11} aria-hidden="true" />
                        <span>{totalAtts} 个附件</span>
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1">
                  {idx > 0 && (
                    <button
                      type="button"
                      className="ga-btn-icon h-6 w-6 rounded-md text-ink-muted hover:text-ink"
                      title="上移"
                      aria-label="上移排队消息"
                      disabled={busy}
                      onClick={() => onMoveItem(item.id, 'up')}
                    >
                      <ArrowUp size={12} aria-hidden="true" />
                    </button>
                  )}
                  {hasActiveRun && canNativeSteer && (
                    <button
                      type="button"
                      className="ga-btn-sm-primary"
                      disabled={busy || steerPending}
                      onClick={() => onSteerItem(item)}
                    >
                      立即插话
                    </button>
                  )}
                  {!hasActiveRun && (
                    <button
                      type="button"
                      className="ga-btn-sm-primary"
                      disabled={busy || dispatchPending}
                      onClick={() => onDispatchItem(item)}
                    >
                      立即发送
                    </button>
                  )}
                  <button
                    type="button"
                    className="ga-btn-sm"
                    disabled={busy}
                    onClick={() => onEditItem(item)}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="ga-btn-icon h-6 w-6 rounded-md text-ink-muted hover:text-status-danger"
                    title="取消排队"
                    aria-label="取消排队"
                    disabled={busy}
                    onClick={() => onRemoveItem(item.id)}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
