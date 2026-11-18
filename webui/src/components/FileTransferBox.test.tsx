// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { FileTransferBox } from './FileTransferBox'

vi.mock('@/runtime/runtimeConfig', () => ({ resolveApiUrl: (path: string) => path }))

it('inserts an available file into the active draft and shares confirmed clearing across views', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const file = { id: 1, path: 'D:/project/final.md', name: 'final.md', size: 1, engine: 'chat', project: null, available: true }
  const stale = { ...file, id: 2, path: 'D:/project/stale.md', name: 'stale.md', available: false }
  let files = [file, stale]
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    expect(path).toBe('/api/file-transfer')
    if (init?.method === 'DELETE') files = []
    return { ok: true, json: async () => files }
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const chatDraft = vi.fn(), antiDraft = vi.fn()
  const render = (key: string, insert: typeof chatDraft) => act(async () => {
    root.render(<QueryClientProvider client={client}><FileTransferBox key={key} canInsert onInsert={insert} /></QueryClientProvider>)
  })
  const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click())
  const settle = (assertion: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assertion()
  })
  try {
    await render('chat', chatDraft)
    await click('[aria-label="文件传递箱"]')
    await settle(() => expect(host.querySelector<HTMLButtonElement>(`[title="${stale.path}"]`)?.disabled).toBe(true))
    await click(`[title="${file.path}"]`)
    expect(chatDraft.mock.calls).toEqual([[file]])
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await render('anti', antiDraft)
    await click('[aria-label="文件传递箱"]')
    await settle(() => expect(host.querySelector(`[title="${file.path}"]`)).not.toBeNull())
    await click(`[title="${file.path}"]`)
    expect(antiDraft.mock.calls).toEqual([[file]])
    await click('[aria-label="文件传递箱"]')
    await click('[aria-label="清空索引"]')
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '确认清空')!.click())
    await settle(() => expect(host.textContent).toContain('暂无手动放入的文件'))
    await render('chat', chatDraft)
    await click('[aria-label="文件传递箱"]')
    await settle(() => expect(host.textContent).toContain('暂无手动放入的文件'))
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})
