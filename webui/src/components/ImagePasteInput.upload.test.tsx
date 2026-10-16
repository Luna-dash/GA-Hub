// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api/client'
import type { PasteAttachment } from '@/api/types'
import { ImagePasteInput } from './ImagePasteInput'
import { LiveChatComposer } from './LiveChatComposer'
import { useDraftStore } from '@/stores/draftStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const result = (name = 'notes.txt'): PasteAttachment => ({
  file_id: name, name, path: `/tmp/${name}`, url: `/api/uploads/${name}`, mime: 'text/plain', size: 4,
})
function deferred() {
  let resolve!: (value: PasteAttachment) => void
  let reject!: (error: Error) => void
  const promise = new Promise<PasteAttachment>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('attachment upload lifecycle', () => {
  let host: HTMLDivElement
  let root: Root
  let onSubmit: ReturnType<typeof vi.fn>
  let onSchedule: ReturnType<typeof vi.fn>
  const revoked = vi.fn()
  function Harness({ stop = false }: { stop?: boolean }) {
    const [attachments, setAttachments] = useState<PasteAttachment[]>([])
    return <ImagePasteInput text="hello" onText={() => {}} attachments={attachments} onAttachments={setAttachments}
      onSubmit={onSubmit} onSchedule={onSchedule} stopActive={stop} onStop={onSubmit} autoFocus={false} />
  }
  function add(...files: File[]) {
    const input = host.querySelector<HTMLInputElement>('input[type=file]')!
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
  }
  function button(label: string) {
    return Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label || b.textContent === label)!
  }
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    onSubmit = vi.fn()
    onSchedule = vi.fn()
    revoked.mockReset()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: revoked }))
    useDraftStore.setState({ texts: {}, attachments: {}, revisions: {}, submissions: {} })
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('previews immediately and blocks Enter, send and schedule until successful', async () => {
    const upload = deferred()
    vi.spyOn(api, 'upload').mockReturnValue(upload.promise)
    act(() => root.render(<Harness />))
    add(new File(['png'], 'screen.png', { type: 'image/png' }))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:preview')
    expect(button('发送').disabled).toBe(true)
    expect(button('定时').disabled).toBe(true)
    act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })))
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => upload.resolve({ ...result('screen.png'), mime: 'image/png' }))
    expect(host.querySelector('[data-upload-state]')).toBeNull()
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/api/uploads/screen.png')
    expect(revoked).toHaveBeenCalledWith('blob:preview')
    expect(button('发送').disabled).toBe(false)
    act(() => button('发送').click())
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('retains failed files for retry without reuploading successful siblings', async () => {
    const first = deferred()
    const second = deferred()
    const retry = deferred()
    const spy = vi.spyOn(api, 'upload').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(retry.promise)
    act(() => root.render(<Harness />))
    add(new File(['a'], 'a.txt'), new File(['b'], 'b.txt'))
    await act(async () => { first.resolve(result('a.txt')); second.reject(new Error('network down')) })
    expect(host.querySelector('[data-upload-state=failed]')?.getAttribute('title')).toContain('network down')
    expect(button('发送').disabled).toBe(true)
    act(() => button('重试 b.txt').click())
    expect(spy).toHaveBeenCalledTimes(3)
    expect(host.querySelector('[data-upload-state=uploading]')).not.toBeNull()
    await act(async () => retry.resolve(result('b.txt')))
    expect(host.querySelectorAll('[data-attachment-kind=file]')).toHaveLength(2)
    expect(button('发送').disabled).toBe(false)
  })

  it('aborts removed uploads and ignores late success', async () => {
    const upload = deferred()
    const spy = vi.spyOn(api, 'upload').mockReturnValue(upload.promise)
    act(() => root.render(<Harness />))
    add(new File(['png'], 'screen.png', { type: 'image/png' }))
    const signal = spy.mock.calls[0][1]?.signal
    act(() => button('移除 screen.png').click())
    expect(signal?.aborted).toBe(true)
    expect(revoked).toHaveBeenCalledWith('blob:preview')
    await act(async () => upload.resolve(result('screen.png')))
    expect(host.querySelector('[data-attachment-kind]')).toBeNull()
    expect(button('发送').disabled).toBe(false)
  })

  it('keeps stop available while uploads are pending', () => {
    vi.spyOn(api, 'upload').mockReturnValue(deferred().promise)
    act(() => root.render(<Harness stop />))
    add(new File(['a'], 'a.txt'))
    expect(button('停止').disabled).toBe(false)
    act(() => button('停止').click())
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('merges overlapping completions without resurrecting a removed attachment', async () => {
    const first = deferred()
    const second = deferred()
    vi.spyOn(api, 'upload').mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    act(() => root.render(<Harness />))
    add(new File(['a'], 'a.txt'))
    add(new File(['b'], 'b.txt'))
    await act(async () => first.resolve(result('a.txt')))
    act(() => button('移除 a.txt').click())
    await act(async () => second.resolve(result('b.txt')))
    expect(host.textContent).not.toContain('a.txt')
    expect(host.textContent).toContain('b.txt')
  })

  it('cancels on draft switch and never attaches late results to either draft', async () => {
    const upload = deferred()
    const spy = vi.spyOn(api, 'upload').mockReturnValue(upload.promise)
    act(() => root.render(<LiveChatComposer draftKey="liveChat:a" onSubmit={onSubmit} />))
    add(new File(['png'], 'screen.png', { type: 'image/png' }))
    const signal = spy.mock.calls[0][1]?.signal
    act(() => root.render(<LiveChatComposer draftKey="liveChat:b" onSubmit={onSubmit} />))
    expect(signal?.aborted).toBe(true)
    expect(revoked).toHaveBeenCalledWith('blob:preview')
    await act(async () => upload.resolve(result('screen.png')))
    expect(useDraftStore.getState().attachments['liveChat:a'] ?? []).toEqual([])
    expect(useDraftStore.getState().attachments['liveChat:b'] ?? []).toEqual([])
    expect(host.querySelector('[data-upload-state]')).toBeNull()
  })
})
