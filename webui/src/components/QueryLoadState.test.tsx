// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryLoadState } from './QueryLoadState'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('QueryLoadState', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
  })

  it('renders loading, default error with retry, and children states cleanly', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <QueryLoadState
        query={{ isLoading: true, isError: false, isFetching: false, refetch }}
        label="模型列表"
      >
        <div>内容</div>
      </QueryLoadState>,
    ))
    expect(host.querySelector('[role="status"]')?.textContent).toBe('正在载入模型列表…')

    await act(async () => root.render(
      <QueryLoadState
        query={{ isLoading: false, isError: true, isFetching: false, error: { body: { detail: '后端不可达' } }, refetch }}
        label="模型列表"
      >
        <div>内容</div>
      </QueryLoadState>,
    ))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('模型列表加载失败')
    const btn = host.querySelector<HTMLButtonElement>('button')!
    expect(btn.type).toBe('button')
    expect(btn.className).toContain('ga-btn-sm')
    act(() => { btn.click() })
    expect(refetch).toHaveBeenCalledTimes(1)

    await act(async () => root.render(
      <QueryLoadState
        query={{ isLoading: false, isError: false, isFetching: false, refetch }}
        label="模型列表"
      >
        <div>内容</div>
      </QueryLoadState>,
    ))
    expect(host.textContent).toContain('内容')
  })

  it('supports compact and showDetail modes using extractErrorMessage', async () => {
    const refetch = vi.fn().mockResolvedValue(undefined)
    await act(async () => root.render(
      <QueryLoadState
        query={{
          isLoading: false,
          isError: true,
          isFetching: true,
          error: { body: { detail: '凭证已失效' } },
          refetch,
        }}
        label="额度"
        compact
        showDetail
      />,
    ))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('额度加载失败：凭证已失效')
    const btn = host.querySelector<HTMLButtonElement>('button')!
    expect(btn.className).toContain('ga-btn-xs')
    expect(btn.disabled).toBe(true)
    expect(btn.textContent).toBe('重试中…')
  })
})
