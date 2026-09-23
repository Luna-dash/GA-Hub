// AskUserCard — interactive picker for an archived ask_user payload.
//
// GA dumps ask_user as a tool block inside the assistant message; the
// transcript projection hands the structured payload here so the question
// renders as a highlighted card with one-click candidate rows instead of a
// plain text list. Clicking a row fills the composer draft (the same
// `liveChat:<id>` draft key the page submits), never sends by itself.
//
// Visual contract: picker cards must read as an interactive element, not as
// ordinary conclusion prose — accent double border + soft accent surface.
// Archived cards (the session moved past this turn) keep the surface but go
// inert: disabled rows, muted header, no composer hint.
import { useState } from 'react'
import clsx from 'clsx'
import { useDraftStore } from '@/stores/draftStore'
import { MessageContent } from './MessageContent'

export function AskUserCard({
  question,
  candidates,
  draftKey,
  interactive = true,
}: {
  question: string
  candidates: string[]
  /** Draft-store key of the composer that should receive the picked label. */
  draftKey?: string
  /** false = 归档展示态：会话已推进过该轮，卡片只作记录，不可再点选。 */
  interactive?: boolean
}) {
  const [picked, setPicked] = useState<string | null>(null)

  const pick = (label: string) => {
    if (!interactive) return
    setPicked(label)
    if (draftKey) useDraftStore.getState().setText(draftKey, label)
  }

  return (
    <section
      data-ask-user-card
      className="ask-card mt-3 rounded-xl px-4 py-3 shadow-[0_2px_6px_rgba(45,34,22,0.08)]"
    >
      <div
        className={clsx(
          'mb-2 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide',
          interactive ? 'text-accent' : 'text-ink-faint',
        )}
      >
        <span className={clsx('h-1.5 w-1.5 rounded-full', interactive ? 'bg-accent' : 'bg-ink-faint')} />
        {interactive ? '待回答' : '历史提问'}
      </div>
      <div className="text-sm leading-6 text-ink">
        <MessageContent content={question} format="markdown" />
      </div>
      <div className="mt-3 flex flex-col gap-1.5">
        {candidates.map((label, index) => (
          <button
            key={`${index}-${label}`}
            type="button"
            disabled={!interactive}
            onClick={() => pick(label)}
            className={clsx(
              'group/pick flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm leading-5 transition-colors',
              interactive && picked === label ? 'ask-option ask-option--picked text-ink' : 'ask-option text-ink',
              !interactive && 'cursor-default opacity-75',
            )}
          >
            <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{index + 1}</span>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{label}</span>
            {interactive && picked === label ? (
              <span className="shrink-0 text-[11px] text-accent">已填入</span>
            ) : interactive ? (
              <span className="shrink-0 text-ink-faint transition-colors group-hover/pick:text-accent">›</span>
            ) : null}
          </button>
        ))}
      </div>
      {interactive && (
        <p className="mt-2 text-[11px] leading-4 text-ink-faint">点击选项将填入输入框，也可直接输入回答。</p>
      )}
    </section>
  )
}
