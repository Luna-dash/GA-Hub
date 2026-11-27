import { ArrowDownToLine, ChevronDown, ChevronUp } from './ActionIcons'

export interface TranscriptNavDockProps {
  stuckBottom: boolean
  canPrev: boolean
  canNext: boolean
  unread?: number
  onJumpToBottom: () => void
  onPrev: () => void
  onNext: () => void
  prevTitle?: string
  nextTitle?: string
}

/**
 * 悬浮于聊天/归档阅读区右下角的纯图形位置导航组。
 * 到达底部时自动收起，离开底部后保持“跳到底部 + 上一节/下一节胶囊”固定锚位。
 */
export function TranscriptNavDock({
  stuckBottom,
  canPrev,
  canNext,
  unread = 0,
  onJumpToBottom,
  onPrev,
  onNext,
  prevTitle = '定位到上一轮问答',
  nextTitle = '定位到下一轮问答',
}: TranscriptNavDockProps) {
  if (stuckBottom) return null

  return (
    <nav
      aria-label="对话位置导航"
      className="pointer-events-auto mt-auto flex shrink-0 flex-col items-center gap-2.5 pb-1"
    >
      <button
        type="button"
        onClick={onJumpToBottom}
        className={`relative inline-flex h-10 w-10 items-center justify-center rounded-full border transition-[background-color,border-color,color,transform,box-shadow] active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
          unread > 0
            ? 'border-accent/60 bg-bg-card text-accent shadow-[inset_0_1px_0_var(--c-inset-highlight),0_4px_14px_rgba(166,91,42,0.18)] hover:border-accent hover:bg-bg-soft'
            : 'border-line/75 bg-bg-card text-ink shadow-[inset_0_1px_0_var(--c-inset-highlight),0_4px_12px_rgba(45,34,22,0.12)] hover:border-accent/55 hover:bg-bg-soft hover:text-accent'
        }`}
        aria-label={unread > 0 ? `跳到底部（${unread} 条新消息）` : '跳到底部'}
        title={unread > 0 ? `${unread} 条新消息，跳到最新` : '跳到最新消息'}
      >
        <ArrowDownToLine className="h-[17px] w-[17px] shrink-0" strokeWidth={2} aria-hidden="true" />
        {unread > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none tabular-nums text-[var(--c-accent-fg)] shadow-sm ring-2 ring-bg-soft"
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      <div className="flex flex-col items-center rounded-full border border-line/75 bg-bg-card p-1 shadow-[inset_0_1px_0_var(--c-inset-highlight),0_4px_14px_rgba(45,34,22,0.11)]">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canPrev}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink transition-[background-color,color,transform] hover:bg-bg-soft hover:text-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="上一节"
          title={prevTitle}
        >
          <ChevronUp className="h-[18px] w-[18px] shrink-0" strokeWidth={2} aria-hidden="true" />
        </button>
        <div aria-hidden="true" className="my-0.5 h-px w-5 bg-line/45" />
        <button
          type="button"
          onClick={onNext}
          disabled={!canNext}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-ink transition-[background-color,color,transform] hover:bg-bg-soft hover:text-accent active:scale-95 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          aria-label="下一节"
          title={nextTitle}
        >
          <ChevronDown className="h-[18px] w-[18px] shrink-0" strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
    </nav>
  )
}
