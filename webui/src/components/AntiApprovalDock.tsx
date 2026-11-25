import type { RefObject } from 'react'
import { ChevronDown, ChevronUp, CircleHelp, ShieldAlert } from 'lucide-react'
import clsx from 'clsx'
import type { AntiApprovalPrompt } from '@/api/client'

export interface AntiApprovalDockProps {
  approval: AntiApprovalPrompt
  pending: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onDecide: (decision: 'allow' | 'allow_always' | 'reject', optionId?: string) => void
  dockRef?: RefObject<HTMLElement>
}

export function AntiApprovalDock({
  approval,
  pending,
  collapsed,
  onToggleCollapsed,
  onDecide,
  dockRef,
}: AntiApprovalDockProps) {
  const isQuestion = approval.prompt_type === 'question'
  const questionOptions = isQuestion ? (approval.question?.options ?? []) : []
  const questionText = isQuestion ? approval.question?.question?.trim() : undefined
  const detailText = approval.details?.trim()
  const showQuestionText = Boolean(questionText && questionText !== detailText)
  const hasBody = Boolean(detailText || showQuestionText || approval.diff || approval.security_warning)
  const Icon = isQuestion ? CircleHelp : ShieldAlert

  return (
    <section
      ref={dockRef}
      tabIndex={-1}
      role="region"
      aria-label="交互审批"
      data-anti-approval-dock
      className={clsx(
        'mx-3 mt-2 flex max-h-[42vh] shrink-0 flex-col rounded-xl border bg-bg-card shadow-[0_-4px_16px_rgba(45,34,22,0.08)] outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        isQuestion ? 'border-accent/45' : 'border-status-warning-line/85',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span
            aria-hidden="true"
            className={clsx(
              'h-2 w-2 shrink-0 animate-pulse rounded-full',
              isQuestion ? 'bg-accent' : 'bg-status-warning',
            )}
          />
          <Icon
            size={15}
            className={clsx('shrink-0', isQuestion ? 'text-accent' : 'text-status-warning')}
            aria-hidden="true"
          />
          <span
            className={clsx(
              'shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none',
              isQuestion
                ? 'bg-accent-soft/80 text-accent'
                : 'bg-status-warning-soft text-status-warning',
            )}
          >
            {isQuestion ? '待选择' : '待审批'}
          </span>
          <span className="min-w-0 truncate font-semibold text-ink" title={approval.title}>
            {approval.title}
          </span>
        </div>
        {hasBody && (
          <button
            type="button"
            className="ga-btn-link inline-flex shrink-0 items-center gap-1 px-1.5 py-0.5 text-[11px] text-ink-muted hover:text-ink"
            aria-expanded={!collapsed}
            aria-label={collapsed ? '展开审批详情' : '收起审批详情'}
            onClick={onToggleCollapsed}
          >
            <span>{collapsed ? '展开详情' : '收起详情'}</span>
            {collapsed
              ? <ChevronUp size={13} aria-hidden="true" />
              : <ChevronDown size={13} aria-hidden="true" />}
          </button>
        )}
      </div>

      {!collapsed && hasBody && (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3.5 pb-2.5 text-xs">
          {detailText && (
            <div className="break-all font-mono text-[11px] text-ink-muted">{detailText}</div>
          )}
          {showQuestionText && (
            <p className="text-xs text-ink">{questionText}</p>
          )}
          {approval.diff && (
            <pre className="max-h-40 overflow-auto rounded-lg border border-line/60 bg-bg-soft p-2 font-mono text-[11px] text-ink whitespace-pre-wrap break-all">
              {approval.diff}
            </pre>
          )}
          {approval.security_warning && (
            <p className="rounded-md border border-status-warning-line/60 bg-status-warning-soft/60 px-2 py-1 text-[11px] text-status-warning">
              {approval.security_warning}
            </p>
          )}
        </div>
      )}

      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 rounded-b-xl border-t border-line/45 bg-bg-soft/55 px-3.5 py-2">
        {isQuestion && questionOptions.length > 0 ? (
          questionOptions.map(opt => (
            <button
              key={opt.id}
              type="button"
              className="ga-btn-sm-primary"
              disabled={pending}
              onClick={() => onDecide('allow', opt.id)}
            >
              {opt.label}
            </button>
          ))
        ) : (
          <>
            <button
              type="button"
              className="ga-btn-sm-danger"
              disabled={pending}
              onClick={() => onDecide('reject')}
            >
              拒绝
            </button>
            {approval.allow_always && (
              <button
                type="button"
                className="ga-btn-sm"
                disabled={pending}
                onClick={() => onDecide('allow_always')}
              >
                本会话始终允许
              </button>
            )}
            <button
              type="button"
              className="ga-btn-sm-primary"
              disabled={pending}
              onClick={() => onDecide('allow')}
            >
              允许一次
            </button>
          </>
        )}
      </div>
    </section>
  )
}
