// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RawView } from './MyKeyRawView'
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
})
