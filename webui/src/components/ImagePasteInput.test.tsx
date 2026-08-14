// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImagePasteInput } from './ImagePasteInput'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ImagePasteInput slash command ownership', () => {
  it('delegates /new without clearing the controlled text first', () => {
    const onText = vi.fn()
    const onSlashCommand = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="/new"
          onText={onText}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
          onSlashCommand={onSlashCommand}
        />,
      )
    })

    const menu = container.querySelector<HTMLElement>('[role="listbox"]')
    expect(menu?.classList.contains('bg-bg-card')).toBe(true)
    expect(menu?.className).not.toContain('bg-bg-card/')
    expect(menu?.className).not.toContain('backdrop-')

    const option = container.querySelector<HTMLButtonElement>('[role="option"]')
    expect(option?.textContent).toContain('/new')
    act(() => option?.click())

    expect(onSlashCommand).toHaveBeenCalledWith('/new')
    expect(onText).not.toHaveBeenCalled()
  })

  it('offers /btw only when a session runtime owns the composer', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const render = (btwSessionId?: string) => (
      <ImagePasteInput
        text="/"
        onText={vi.fn()}
        attachments={[]}
        onAttachments={vi.fn()}
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        btwSessionId={btwSessionId}
      />
    )

    act(() => root?.render(render()))
    expect(Array.from(container.querySelectorAll('[role="option"]'))
      .some((option) => option.textContent?.includes('/btw'))).toBe(false)

    act(() => root?.render(render('session-A')))
    expect(Array.from(container.querySelectorAll('[role="option"]'))
      .some((option) => option.textContent?.includes('/btw'))).toBe(true)
  })

  it('uses the same composer button to send when idle and stop when active', () => {
    const onSubmit = vi.fn()
    const onStop = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="hello"
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={onSubmit}
        />,
      )
    })
    const composer = container.querySelector('textarea')?.parentElement?.parentElement
    expect(composer?.className).not.toContain('border')
    expect(composer?.className).not.toContain('backdrop-')

    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .some((button) => button.textContent === 'BTW')).toBe(false)
    let action = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '发送')
    expect(action).toBeTruthy()
    expect(action?.disabled).toBe(false)
    act(() => action?.click())
    expect(onSubmit).toHaveBeenCalledOnce()

    act(() => {
      root?.render(
        <ImagePasteInput
          text=""
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={onSubmit}
          onStop={onStop}
          stopActive
        />,
      )
    })
    action = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '停止')
    expect(action).toBeTruthy()
    expect(action?.disabled).toBe(false)
    act(() => action?.click())
    expect(onStop).toHaveBeenCalledOnce()
  })
})

describe('ImagePasteInput attachment presentation', () => {
  it('shows images as thumbnail-only and files as content-width filenames', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text=""
          onText={vi.fn()}
          attachments={[
            {
              file_id: 'image-1',
              name: 'photo-with-a-long-name.png',
              url: '/api/upload/image-1',
              path: '/tmp/image-1.png',
              mime: 'image/png',
              size: 123,
              preview: 'data:image/png;base64,AA==',
            },
            {
              file_id: 'file-1',
              name: 'notes.txt',
              url: '/api/upload/file-1',
              path: '/tmp/file-1.txt',
              mime: 'text/plain',
              size: 456,
            },
          ]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
        />,
      )
    })

    const imageAttachment = container.querySelector<HTMLElement>('[data-attachment-kind="image"]')
    expect(imageAttachment?.querySelector('img')).toBeTruthy()
    expect(imageAttachment?.textContent).not.toContain('photo-with-a-long-name.png')
    expect(imageAttachment?.className).toContain('h-14')
    expect(imageAttachment?.className).toContain('w-14')

    const fileAttachment = container.querySelector<HTMLElement>('[data-attachment-kind="file"]')
    expect(fileAttachment?.querySelector('img')).toBeNull()
    expect(fileAttachment?.textContent).toContain('notes.txt')
    expect(fileAttachment?.textContent).not.toContain('text/plain')
    expect(fileAttachment?.className).toContain('w-fit')
    expect(fileAttachment?.className).toContain('max-w-full')
  })
})
