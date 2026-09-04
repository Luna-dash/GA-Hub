// MessageContent — the single place that decides how message *text* becomes
// visible nodes. Pages keep their own bubble/card chrome, alignment, labels
// and virtualization; they choose only a content format:
//   text     → literal pre-wrapped text (user prompts everywhere)
//   markdown → MarkdownView with an explicit mode + cache policy
//   pre      → literal <pre> (GoalHive's intentionally raw output)
import clsx from 'clsx'
import { MarkdownView, type MarkdownMode } from './MarkdownView'

export type MessageContentFormat = 'text' | 'markdown' | 'pre'

export function MessageContent({
  content,
  format,
  markdownMode = 'auto',
  cache = true,
  className,
}: {
  content: string
  format: MessageContentFormat
  markdownMode?: MarkdownMode
  /** Streaming content changes every chunk and must not enter the LRU. */
  cache?: boolean
  className?: string
}) {
  if (format === 'markdown') {
    return (
      <div className={className}>
        <MarkdownView mode={markdownMode} cache={cache}>{content || ''}</MarkdownView>
      </div>
    )
  }
  if (format === 'pre') {
    return <pre className={clsx('whitespace-pre-wrap break-words', className)}>{content || ''}</pre>
  }
  return <div className={clsx('whitespace-pre-wrap break-words', className)}>{content || ''}</div>
}
