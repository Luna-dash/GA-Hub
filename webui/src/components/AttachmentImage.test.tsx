// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PasteAttachment } from '@/api/types'
const mocks = vi.hoisted(() => ({ native: vi.fn(), read: vi.fn(), fileUrl: vi.fn() }))
vi.mock('@/utils/desktop', () => ({ canReferenceLocalFiles: mocks.native, localAttachmentImageUrl: mocks.read }))
vi.mock('@/api/client', () => ({ api: { fileUrlByPath: mocks.fileUrl } }))
import { AttachmentImage, isImageAttachment } from './AttachmentImage'
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let host: HTMLDivElement
let root: Root
const file: PasteAttachment = { file_id: 'local:x', path: 'D:/Pictures/test.png', name: 'test.png', mime: 'image/png', url: '', size: 123, source: 'local_ref' }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.native.mockReturnValue(true)
  mocks.read.mockResolvedValue('blob:preview')
  mocks.fileUrl.mockReturnValue('/api/files-by-path?path=x')
  vi.stubGlobal('URL', Object.assign(URL, { revokeObjectURL: vi.fn() }))
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render(a = file, linked = false) {
  await act(async () => { root.render(<AttachmentImage attachment={a} linked={linked} />) })
}
it('previews local refs without persisted preview and links the image in messages', async () => {
  await render(file, true)
  expect(mocks.read).toHaveBeenCalledWith(file.path)
  expect(mocks.fileUrl).not.toHaveBeenCalled()
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:preview')
  expect(host.querySelector('a')?.getAttribute('href')).toBe('blob:preview')
  act(() => root.render(null))
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview')
})
it('rebuilds stale persisted blob previews from paths after reload', async () => {
  await render({ ...file, preview: 'blob:old-process' })
  expect(mocks.read).toHaveBeenCalledWith(file.path)
  expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:preview')
})
it('retains browser data previews without native calls', async () => {
  await render({ ...file, preview: 'data:image/png;base64,test' })
  expect(mocks.read).not.toHaveBeenCalled()
  expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,test')
})
it('uses the execution host HTTP path in remote/browser sessions', async () => {
  mocks.native.mockReturnValue(false)
  await render()
  expect(mocks.read).not.toHaveBeenCalled()
  expect(mocks.fileUrl).toHaveBeenCalledWith(file.path)
  expect(host.querySelector('img')?.getAttribute('src')).toContain('/api/files-by-path')
})
it('shows a useful placeholder instead of a broken image when reading fails', async () => {
  mocks.read.mockRejectedValue(new Error('deleted or oversized'))
  await render()
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).toContain('图片预览不可用')
  expect(host.querySelector('[role=status]')?.getAttribute('title')).toContain(file.path)
})
it('handles invalid image decoding without leaving a broken img', async () => {
  await render()
  act(() => host.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(host.querySelector('img')).toBeNull()
  expect(host.textContent).toContain('图片预览不可用')
})
it('revokes late preview reads after removal', async () => {
  let resolve!: (s: string) => void
  mocks.read.mockReturnValue(new Promise<string>((r) => { resolve = r }))
  await render()
  expect(host.textContent).toContain('加载预览')
  act(() => root.render(null))
  await act(async () => { resolve('blob:late') })
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:late')
})
it('recognizes historical image refs by extension even with generic MIME', () => {
  expect(isImageAttachment({ ...file, mime: 'application/octet-stream', name: 'a.JPEG' })).toBe(true)
  expect(isImageAttachment({ ...file, mime: 'application/pdf', name: 'a.pdf' })).toBe(false)
})
