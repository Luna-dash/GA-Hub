// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RawView } from './MyKeyRawView'
import { api } from '@/api/client'
import type { MyKeyData } from '@/api/types'

vi.mock('@/api/client', () => ({ api: { putMyKeyRaw: vi.fn() } }))
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const raw = Array.from({ length: 200 }, (_, i) => `demo_${i + 1} = 'synthetic'`).join('\n')
const data: MyKeyData = { exists: true, path: '/synthetic/mykey.py', mtime: 0, raw, structured: { sessions: [], mixins: [], globals: {} } }

describe('RawView line-number scrolling', () => {
  let host: HTMLDivElement
  let root: Root
  const onWrite = vi.fn()
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => root.render(<RawView data={data} onWrite={onWrite} />))
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('tracks vertical scrolling in both directions without shifting line numbers horizontally', () => {
    const editor = host.querySelector('textarea')!
    const gutter = host.querySelector('pre')!
    for (const offset of [480, 4266, 120, 0]) {
      act(() => {
        editor.scrollTop = offset
        editor.scrollLeft = 250
        editor.dispatchEvent(new Event('scroll'))
      })
      expect(gutter.style.transform).toBe(`translateY(${-offset}px)`)
      expect(editor.scrollLeft).toBe(250)
    }
    expect(gutter.children).toHaveLength(200)
    expect(editor.wrap).toBe('off')
  })

  it('resynchronizes after replacing a long document with short text', () => {
    const editor = host.querySelector('textarea')!
    const gutter = host.querySelector('pre')!
    act(() => {
      editor.scrollTop = 480
      editor.dispatchEvent(new Event('scroll'))
    })
    // Model the browser clamping scrollTop after a shorter value is applied.
    editor.scrollTop = 0
    act(() => root.render(<RawView data={{ ...data, raw: 'demo = 1' }} onWrite={onWrite} />))
    expect(editor.value).toBe('demo = 1')
    expect(gutter.children).toHaveLength(1)
    expect(gutter.style.transform).toBe('translateY(0px)')
  })

  it('preserves dirty raw draft on external refresh and allows explicitly adopting latest', () => {
    const editor = host.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'unsaved = 1')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => root.render(<RawView data={{ ...data, raw: 'external = 2' }} onWrite={onWrite} />))
    expect(editor.value).toBe('unsaved = 1')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('外部 mykey.py 已更新')

    const adoptBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === '采用最新原文')!
    act(() => adoptBtn.click())
    expect(editor.value).toBe('external = 2')
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('does not falsely flag a self-initiated save as external update during follow-up edits', async () => {
    vi.mocked(api.putMyKeyRaw).mockResolvedValueOnce({} as never)
    const editor = host.querySelector('textarea')!
    const setEditor = (val: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, val)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    }

    act(() => setEditor('saved = 1'))
    const saveBtn = Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes('保存并应用'))!
    await act(async () => saveBtn.click())

    act(() => setEditor('saved = 2'))
    act(() => root.render(<RawView data={{ ...data, raw: 'saved = 1' }} onWrite={onWrite} />))

    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(editor.value).toBe('saved = 2')
  })
})
