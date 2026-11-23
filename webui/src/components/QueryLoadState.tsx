import type { ReactNode } from 'react'

type QueryState = {
  isLoading: boolean
  isError: boolean
  isFetching: boolean
  refetch: () => Promise<unknown>
}

export function QueryLoadState({ query, label, children }: { query: QueryState; label: string; children?: ReactNode }) {
  if (query.isLoading) return <div role="status" className="p-3 text-sm text-ink-faint">正在载入{label}…</div>
  if (!query.isError) return <>{children}</>
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 p-3 text-sm">
      <span role="alert" className="text-status-danger">{label}加载失败</span>
      <button type="button" className="ga-btn-sm" disabled={query.isFetching} onClick={() => { void query.refetch() }}>
        {query.isFetching ? '重试中…' : '重试'}
      </button>
    </div>
  )
}
