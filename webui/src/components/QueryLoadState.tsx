import type { ReactNode } from 'react'
import { extractErrorMessage } from '@/utils/errors'

type QueryState = {
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  error?: unknown
  refetch: () => Promise<unknown>
}

export function QueryLoadState({
  query,
  label,
  compact = false,
  showDetail = false,
  children,
}: {
  query: QueryState
  label: string
  compact?: boolean
  showDetail?: boolean
  children?: ReactNode
}) {
  if (query.isLoading) {
    return (
      <div
        role="status"
        className={compact ? 'px-2 py-1 text-xs text-ink-faint' : 'p-3 text-sm text-ink-faint'}
      >
        正在载入{label}…
      </div>
    )
  }
  if (!query.isError) return <>{children}</>

  const detail = showDetail && query.error != null ? extractErrorMessage(query.error, '') : ''
  const errorText = detail ? `${label}加载失败：${detail}` : `${label}加载失败`

  return (
    <div
      className={
        compact
          ? 'flex flex-wrap items-center gap-2 py-1 text-xs'
          : 'flex flex-wrap items-center justify-center gap-2 p-3 text-sm'
      }
    >
      <span role="alert" className="text-status-danger">{errorText}</span>
      <button
        type="button"
        className={compact ? 'ga-btn-xs' : 'ga-btn-sm'}
        disabled={query.isFetching}
        onClick={() => { void query.refetch() }}
      >
        {query.isFetching ? '重试中…' : '重试'}
      </button>
    </div>
  )
}
