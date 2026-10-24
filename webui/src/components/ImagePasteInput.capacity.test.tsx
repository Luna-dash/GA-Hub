// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as desktop from '@/utils/desktop'
import { api } from '@/api/client'
import type { PasteAttachment } from '@/api/types'
import { ImagePasteInput } from './ImagePasteInput'

const native = vi.hoisted(() => ({ listener: undefined as undefined | ((event: { payload: { type: string; paths: string[]; position: { x: number; y: number } } }) => void) }))
vi.mock('@tauri-apps/api/webviewWindow', () => ({ getCurrentWebviewWindow: () => ({
  onDragDropEvent: async (listener: typeof native.listener) => { native.listener = listener; return () => { native.listener = undefined } },
}) }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const attachment = (i: number): PasteAttachment => ({ file_id: `id${i}`, name: `${i}.txt`, path: `C:/data/${i}.txt`, url: '', mime: 'text/plain', size: 1, source: 'local_ref' })
const list = (count: number) => Array.from({ length: count }, (_, i) => attachment(i))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}

describe('attachment capacity invariants across entry points', () => {
  let host: HTMLDivElement, root: Root, latest: PasteAttachment[]
  const send = vi.fn(), schedule = vi.fn(), stop = vi.fn()
  function Harness({ initial = 0, stopActive = false }: { initial?: number; stopActive?: boolean }) {
    const [items, setItems] = useState(list(initial))
    latest = items
    return <ImagePasteInput text="hello" onText={() => {}} attachments={items} onAttachments={setItems}
      onSubmit={send} onSchedule={schedule} stopActive={stopActive} onStop={stop} autoFocus={false} />
  }
  function button(text: string) { return Array.from(host.querySelectorAll('button')).find((b) => b.textContent === text)! }
  async function render(initial: number, desktopMode = false, stopActive = false) {
    vi.spyOn(desktop, 'canReferenceLocalFiles').mockReturnValue(desktopMode)
    await act(async () => root.render(<Harness initial={initial} stopActive={stopActive} />))
  }
  function files(count: number) { return Array.from({ length: count }, (_, i) => new File(['x'], `new${i}.txt`)) }
  function browserAdd(entry: string, values: File[]) {
    const event = new Event(entry === 'picker' ? 'change' : entry === 'paste' ? 'paste' : 'drop', { bubbles: true, cancelable: true })
    if (entry === 'picker') {
      const input = host.querySelector<HTMLInputElement>('input[type=file]')!
      Object.defineProperty(input, 'files', { configurable: true, value: values })
      input.dispatchEvent(event)
    } else if (entry === 'paste') {
      Object.defineProperty(event, 'clipboardData', { value: { types: ['Files'], items: values.map((f) => ({ kind: 'file', getAsFile: () => f })) } })
      host.querySelector('textarea')!.dispatchEvent(event)
    } else {
      Object.defineProperty(event, 'dataTransfer', { value: { files: values } })
      host.querySelector('[data-file-composer]')!.dispatchEvent(event)
    }
  }
  async function nativeAdd(entry: string) {
    await act(async () => {
      if (entry === 'picker') host.querySelector('label')!.click()
      else if (entry === 'paste') browserAdd('paste', files(1))
      else native.listener!({ payload: { type: 'drop', paths: ['C:/data/999.txt'], position: { x: 0, y: 0 } } })
    })
  }
  beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    send.mockReset(); schedule.mockReset(); stop.mockReset(); latest = []; native.listener = undefined
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    vi.spyOn(desktop, 'selectAttachmentPaths').mockResolvedValue(['C:/data/999.txt'])
    vi.spyOn(desktop, 'clipboardAttachmentPaths').mockResolvedValue(['C:/data/999.txt'])
    vi.spyOn(desktop, 'referenceAttachments').mockResolvedValue([attachment(999)])
    vi.spyOn(api, 'upload').mockImplementation(async (file) => ({ ...attachment(999), name: file.name }))
  })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

  for (const entry of ['picker', 'paste', 'drop']) {
    it(`rejects a native ${entry} batch exceeding the remaining capacity`, async () => {
      await render(256, true)
      await nativeAdd(entry)
      expect(latest).toHaveLength(256)
      expect(host.querySelector('[role=alert]')?.textContent).toContain('256')
      expect(button('发送').disabled).toBe(false) // Rejected addition must not poison a valid draft.
    })
    it(`admits the 256th native attachment through ${entry}`, async () => {
      await render(255, true); await nativeAdd(entry)
      expect(latest).toHaveLength(256)
      expect(latest.at(-1)?.path).toBe('C:/data/999.txt')
    })
    it(`rejects an oversized browser ${entry} batch before uploading any part`, async () => {
      await render(255)
      await act(async () => browserAdd(entry, files(2)))
      expect(latest).toHaveLength(255); expect(api.upload).not.toHaveBeenCalled()
      expect(host.querySelector('[role=alert]')?.textContent).toContain('256')
    })
  }
  it('deduplicates native results before capacity checking without dropping distinct files', async () => {
    vi.mocked(desktop.referenceAttachments).mockResolvedValue([attachment(0), attachment(999), attachment(999)])
    await render(255, true); await nativeAdd('picker')
    expect(latest).toHaveLength(256); expect(latest.at(-1)?.file_id).toBe('id999')
    await nativeAdd('picker')
    expect(latest).toHaveLength(256); expect(host.querySelector('[role=alert]')).toBeNull()
  })
  it('rejects the entire native batch instead of silently truncating it', async () => {
    vi.mocked(desktop.referenceAttachments).mockResolvedValue([attachment(999), attachment(1000)])
    await render(255, true); await nativeAdd('picker')
    expect(latest).toHaveLength(255); expect(latest.some((a) => a.file_id === 'id999')).toBe(false)
  })
  it('counts pending and failed uploads as reservations across same-tick additions', async () => {
    const pending = deferred<PasteAttachment>(); vi.mocked(api.upload).mockReturnValue(pending.promise)
    await render(255)
    act(() => { browserAdd('picker', files(1)); browserAdd('drop', files(1)) })
    expect(api.upload).toHaveBeenCalledTimes(1)
    await act(async () => pending.resolve(attachment(999)))
    expect(latest).toHaveLength(256)
  })
  it('prevents a native completion from stealing an upload reservation', async () => {
    const pending = deferred<PasteAttachment>(); vi.mocked(api.upload).mockReturnValue(pending.promise)
    await render(255, true)
    act(() => browserAdd('picker', files(1)))
    await nativeAdd('picker')
    expect(latest).toHaveLength(255)
    await act(async () => pending.resolve(attachment(1000)))
    expect(latest).toHaveLength(256); expect(latest.at(-1)?.file_id).toBe('id1000')
  })
  it('rechecks native capacity after awaiting file metadata', async () => {
    const pending = deferred<PasteAttachment[]>()
    vi.mocked(desktop.referenceAttachments).mockReturnValue(pending.promise)
    await render(255, true); await nativeAdd('picker')
    await act(async () => browserAdd('picker', files(1)))
    await act(async () => pending.resolve([attachment(1000)]))
    expect(latest).toHaveLength(256); expect(latest.some((a) => a.file_id === 'id1000')).toBe(false)
  })
  it('blocks send, Enter and schedule for an already-oversized restored draft, but allows recovery', async () => {
    await render(257)
    expect(button('发送').disabled).toBe(true); expect(button('定时').disabled).toBe(true)
    act(() => host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true })))
    expect(send).not.toHaveBeenCalled(); expect(schedule).not.toHaveBeenCalled()
    expect(host.querySelector('[role=alert]')?.textContent).toContain('256')
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="移除 0.txt"]')!.click())
    expect(latest).toHaveLength(256); expect(button('发送').disabled).toBe(false); expect(button('定时').disabled).toBe(false)
    act(() => { button('发送').click(); button('定时').click() })
    expect(send).toHaveBeenCalledOnce(); expect(schedule).toHaveBeenCalledOnce()
  })
  it('leaves stop available even for an oversized restored draft', async () => {
    await render(257, false, true)
    expect(button('停止').disabled).toBe(false)
    act(() => button('停止').click()); expect(stop).toHaveBeenCalledOnce()
  })
  it('guards scheduling synchronously while a native chooser is opening', async () => {
    vi.mocked(desktop.selectAttachmentPaths).mockReturnValue(new Promise(() => {}))
    await render(0, true)
    act(() => { host.querySelector('label')!.click(); button('定时').click() })
    expect(schedule).not.toHaveBeenCalled()
  })
})
