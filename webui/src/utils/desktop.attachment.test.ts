// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
import { canReferenceLocalFiles, localAttachmentImageUrl } from './desktop'

afterEach(() => {
  delete window.__TAURI_INTERNALS__; delete window.__GA_HUB_RUNTIME__
  vi.unstubAllGlobals(); vi.clearAllMocks()
})
it('allows native paths only for an authenticated local desktop backend', () => {
  expect(canReferenceLocalFiles()).toBe(false)
  window.__TAURI_INTERNALS__ = {}
  expect(canReferenceLocalFiles()).toBe(false)
  window.__GA_HUB_RUNTIME__ = { desktop: true, instanceToken: 'instance', apiOrigin: 'https://remote.example' }
  expect(canReferenceLocalFiles()).toBe(false)
  window.__GA_HUB_RUNTIME__ = { desktop: true, instanceToken: 'instance', apiOrigin: 'http://127.0.0.1:43123' }
  expect(canReferenceLocalFiles()).toBe(true)
})

it('turns native IPC bytes into an owned preview URL without uploading', async () => {
  window.__TAURI_INTERNALS__ = {}
  window.__GA_HUB_RUNTIME__ = { desktop: true, instanceToken: 'instance', apiOrigin: 'http://127.0.0.1:43123' }
  const bytes = new Uint8Array([137, 80, 78, 71]).buffer
  invoke.mockResolvedValueOnce(bytes)
  const create = vi.fn((_blob: Blob) => 'blob:preview')
  const NativeURL = URL
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = create })
  await expect(localAttachmentImageUrl('C:/图片/a.png')).resolves.toBe('blob:preview')
  expect(invoke).toHaveBeenCalledWith('attachment_image_preview', { path: 'C:/图片/a.png' })
  expect(create.mock.calls[0][0]).toBeInstanceOf(Blob)
})

it('never invokes native file reads for remote backends', async () => {
  window.__TAURI_INTERNALS__ = {}
  window.__GA_HUB_RUNTIME__ = { desktop: true, instanceToken: 'instance', apiOrigin: 'https://remote.example' }
  await expect(localAttachmentImageUrl('C:/a.png')).rejects.toThrow('本机桌面')
  expect(invoke).not.toHaveBeenCalled()
})
