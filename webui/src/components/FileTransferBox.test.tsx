// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { Z_LAYERS } from '@/config/zLayers'
import { registerOverlay } from '@/utils/overlayStack'
import { FileTransferBox, fileTransferQueryKey, guessTransferMime, type TransferredFile } from './FileTransferBox'

vi.mock('@/runtime/runtimeConfig', () => ({ resolveApiUrl: (path: string) => path }))
vi.mock('@/utils/desktop', () => ({
  canReferenceLocalFiles: () => false,
  selectAttachmentPaths: vi.fn(async () => []),
}))

it('inserts an available file into the active draft and supports clearing list and staged documents separately', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const file: TransferredFile = { id: 1, path: 'D:/project/final.md', name: 'final.md', size: 1, engine: 'chat', project: 'Alpha', available: true }
  const imageFile: TransferredFile = { id: 3, path: 'D:/project/chart.png', name: 'chart.png', size: 2048, engine: 'anti', project: 'Alpha', available: true }
  const docFile: TransferredFile = { id: 4, path: 'D:/admin/transfer_documents/结论-1126-1254.md', name: '结论-1126-1254.md', size: 512, engine: 'anti', project: 'Alpha', available: true }
  const stale: TransferredFile = { ...file, id: 2, path: 'D:/project/stale.md', name: 'stale.md', project: null, available: false }
  let files: TransferredFile[] = []
  const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
    if (path === '/api/file-transfer/documents' && init?.method === 'DELETE') {
      files = files.filter(item => item.id !== docFile.id)
      return { ok: true, json: async () => ({ deleted: 1 }) }
    }
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
    root.render(
      <QueryClientProvider client={client}>
        <FileTransferBox key={key} canInsert onInsert={insert} source={{ engine: 'anti', sessionId: 's1', project: 'Alpha' }} />
      </QueryClientProvider>,
    )
  })
  const click = (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click())
  const settle = (assertion: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assertion()
  })
  const trigger = () => host.querySelector('[aria-label="中转箱"]')!
  try {
    await render('chat', chatDraft)
    await settle(() => expect(host.querySelector('[role="status"]')?.textContent).toBe('箱内有 0 个文件'))
    expect(trigger().textContent).toBe('')
    expect(trigger().querySelector('svg')).not.toBeNull()
    files = [file, imageFile, docFile, stale]
    await act(async () => { await client.invalidateQueries({ queryKey: fileTransferQueryKey }) })
    await settle(() => expect(trigger().textContent).toBe('4'))
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    await click('[aria-label="中转箱"]')
    await settle(() => expect(host.querySelector<HTMLButtonElement>(`[title="${stale.path}"]`)?.disabled).toBe(true))
    expect(host.querySelector('section[aria-label="项目：Alpha"]')?.textContent).toContain('final.md')
    expect(host.querySelector('section[aria-label="项目：Alpha"]')?.textContent).toContain('chart.png')
    expect(host.querySelector('section[aria-label="项目：未绑定项目"]')?.textContent).toContain('stale.md')
    expect(host.querySelector('[aria-label="添加文件"]')).not.toBeNull()

    await click(`[title="${file.path}"]`)
    expect(chatDraft.mock.calls).toEqual([[file]])
    expect(host.querySelector('[role="dialog"]')).toBeNull()

    await render('anti', antiDraft)
    expect(trigger().textContent).toBe('4')
    await click('[aria-label="中转箱"]')
    await settle(() => expect(host.querySelector(`[title="${imageFile.path}"]`)).not.toBeNull())
    await click(`[title="${imageFile.path}"]`)
    expect(antiDraft.mock.calls).toEqual([[imageFile]])

    // Clear staged documents while preserving external files
    await click('[aria-label="中转箱"]')
    await click('[aria-label="清空暂存文档"]')
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/file-transfer/documents' && init?.method === 'DELETE')).toBe(false)
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '确认')!.click())
    await settle(() => expect(host.querySelector(`[title="${docFile.path}"]`)).toBeNull())
    expect(host.querySelector(`[title="${imageFile.path}"]`)).not.toBeNull()

    // Clear list completely; 清空暂存文档 remains clickable even when list is empty
    await click('[aria-label="清空列表"]')
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/file-transfer' && init?.method === 'DELETE')).toBe(false)
    await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === '确认')!.click())
    await settle(() => expect(host.textContent).toContain('暂无文件'))
    expect(trigger().textContent).toBe('')
    expect(host.querySelector<HTMLButtonElement>('[aria-label="清空暂存文档"]')?.disabled).toBe(false)
    await render('chat', chatDraft)
    await click('[aria-label="中转箱"]')
    await settle(() => expect(host.textContent).toContain('暂无文件'))
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('dismisses the open panel on outside click without stealing focus and keeps it open for internal clicks', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const file: TransferredFile = { id: 1, path: 'D:/project/final.md', name: 'final.md', size: 1, engine: 'chat', project: 'Alpha', available: true }
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [file] })))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  const host = document.createElement('div')
  const outsideTextarea = document.createElement('textarea')
  document.body.append(host, outsideTextarea)
  const root = createRoot(host)
  const settle = (assertion: () => void) => vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assertion()
  })
  const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="中转箱"]')!
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <FileTransferBox canInsert onInsert={vi.fn()} source={{ engine: 'chat', sessionId: 's1', project: 'Alpha' }} />
        </QueryClientProvider>,
      )
    })
    await settle(() => expect(trigger().textContent).toBe('1'))

    await act(async () => { trigger().click() })
    await settle(() => expect(host.querySelector('[role="dialog"]')).not.toBeNull())
    expect(trigger().getAttribute('aria-expanded')).toBe('true')

    // Clicks inside the panel (e.g. opening confirm bar or pressing header) must not dismiss it.
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label="清空列表"]')!.click()
    })
    const panel = host.querySelector<HTMLElement>('[role="dialog"]')!
    await act(async () => {
      panel.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    expect(host.textContent).toContain('清空列表？')

    // Pointerdown inside the trigger button also does not dismiss prematurely before click toggle runs.
    await act(async () => {
      trigger().dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()

    // Clicking an outside control dismisses the panel, resets confirm state, and lets focus stay outside.
    await act(async () => {
      outsideTextarea.focus()
      outsideTextarea.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(outsideTextarea)

    // Re-opening after outside dismiss resets pending confirm state and works normally.
    await act(async () => { trigger().click() })
    await settle(() => expect(host.querySelector('[role="dialog"]')).not.toBeNull())
    expect(host.textContent).not.toContain('清空列表？')

    // Escape closes via overlayStack even when focus is outside the panel, and yields to higher overlays.
    outsideTextarea.focus()
    const modalEsc = vi.fn()
    const modalReg = registerOverlay({ zIndex: Z_LAYERS.dialog, getPanel: () => null, onEscape: modalEsc })
    try {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(modalEsc).toHaveBeenCalledTimes(1)
      expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    } finally {
      modalReg.unregister()
    }

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  } finally {
    await act(async () => root.unmount())
    client.clear()
    host.remove()
    outsideTextarea.remove()
    vi.unstubAllGlobals()
  }
})

it('resolves MIME types across images, PDFs, audio, video, and binary artifacts', () => {
  expect(guessTransferMime('chart.png')).toBe('image/png')
  expect(guessTransferMime('photo.jpg')).toBe('image/jpeg')
  expect(guessTransferMime('diagram.webp')).toBe('image/webp')
  expect(guessTransferMime('report.pdf')).toBe('application/pdf')
  expect(guessTransferMime('clip.mp4')).toBe('video/mp4')
  expect(guessTransferMime('voice.mp3')).toBe('audio/mpeg')
  expect(guessTransferMime('bundle.zip')).toBe('application/octet-stream')
})
