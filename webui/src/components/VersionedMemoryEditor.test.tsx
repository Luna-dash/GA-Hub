// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VersionedMemoryEditor, type MemorySnapshot } from './VersionedMemoryEditor'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const original: MemorySnapshot = { content: 'original', mtime_ns: '10', sha256: 'hash-10' }
const remote: MemorySnapshot = { content: 'remote', mtime_ns: '20', sha256: 'hash-20' }

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

function button(host: HTMLElement, text: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
    .find((item) => item.textContent?.includes(text))
  if (!match) throw new Error(`button not found: ${text}`)
  return match
}

describe('VersionedMemoryEditor', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('saves the draft with the baseline version tokens', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, size: 5, mtime_ns: '11', sha256: 'hash-11' })
    act(() => root.render(
      <VersionedMemoryEditor label="memory/test.md" snapshot={original} onSave={onSave} onReload={vi.fn()} />,
    ))
    act(() => changeTextarea(host.querySelector('textarea')!, 'draft'))

    await act(async () => button(host, '保存').click())

    expect(onSave).toHaveBeenCalledWith({
      content: 'draft',
      expected_mtime_ns: '10',
      expected_sha256: 'hash-10',
    })
    expect(button(host, '已保存').disabled).toBe(true)
  })

  it('keeps a dirty draft and its original tokens when a newer snapshot arrives', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, size: 5, mtime_ns: '21', sha256: 'hash-21' })
    const render = (snapshot: MemorySnapshot) => root.render(
      <VersionedMemoryEditor label="memory/test.md" snapshot={snapshot} onSave={onSave} onReload={vi.fn()} />,
    )
    act(() => render(original))
    act(() => changeTextarea(host.querySelector('textarea')!, 'draft'))
    act(() => render(remote))

    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('draft')
    expect(host.textContent).toContain('磁盘版本已变化')
    await act(async () => button(host, '保存').click())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      expected_mtime_ns: '10',
      expected_sha256: 'hash-10',
    }))
  })

  it('preserves the draft after a conflict and offers explicit reload', async () => {
    const conflict = Object.assign(new Error('conflict'), { status: 409 })
    const onError = vi.fn()
    const onSave = vi.fn().mockRejectedValue(conflict)
    act(() => root.render(
      <VersionedMemoryEditor
        label="memory/test.md"
        snapshot={original}
        onSave={onSave}
        onReload={vi.fn().mockResolvedValue(remote)}
        onError={onError}
      />,
    ))
    act(() => changeTextarea(host.querySelector('textarea')!, 'draft'))

    await act(async () => button(host, '保存').click())

    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('draft')
    expect(host.textContent).toContain('磁盘版本已变化')
    expect(onError).toHaveBeenCalledWith(conflict)
  })

  it('replaces the draft only after explicit reload', async () => {
    const onReload = vi.fn().mockResolvedValue(remote)
    const onSave = vi.fn()
    const render = (snapshot: MemorySnapshot) => root.render(
      <VersionedMemoryEditor
        label="memory/test.md"
        snapshot={snapshot}
        onSave={onSave}
        onReload={onReload}
      />,
    )
    act(() => render(original))
    act(() => changeTextarea(host.querySelector('textarea')!, 'draft'))
    act(() => render(remote))

    await act(async () => button(host, '放弃草稿并重载').click())

    expect(onReload).toHaveBeenCalledOnce()
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('remote')
    expect(button(host, '已保存').disabled).toBe(true)
  })
})
