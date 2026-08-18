// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PasteAttachment } from './ImagePasteInput'
import { LiveChatComposer } from './LiveChatComposer'
import { useDraftStore } from '@/stores/draftStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DRAFT_KEY = 'liveChat:session-a'
const attachment: PasteAttachment = {
  file_id: 'file-a',
  path: 'D:/work/notes.txt',
  name: 'notes.txt',
  url: '/api/uploads/file-a',
  mime: 'text/plain',
  size: 12,
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('LiveChatComposer draft boundary', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    useDraftStore.setState({ texts: {}, attachments: {} })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('updates text and attachments without re-rendering a sibling page region', () => {
    let siblingRenders = 0
    function TranscriptChromeProbe() {
      siblingRenders += 1
      return <div data-testid="transcript-chrome">transcript</div>
    }

    act(() => root.render(
      <>
        <TranscriptChromeProbe />
        <LiveChatComposer draftKey={DRAFT_KEY} onSubmit={vi.fn()} />
      </>,
    ))
    expect(siblingRenders).toBe(1)

    const textarea = host.querySelector('textarea') as HTMLTextAreaElement
    act(() => changeTextarea(textarea, 'new draft'))
    expect(useDraftStore.getState().texts[DRAFT_KEY]).toBe('new draft')
    expect(textarea.value).toBe('new draft')
    expect(siblingRenders).toBe(1)

    act(() => useDraftStore.getState().setAttachments(DRAFT_KEY, [attachment]))
    expect(host.textContent).toContain('notes.txt')
    expect(siblingRenders).toBe(1)
  })

  it('submits an event-time copy of the active session draft', () => {
    const onSubmit = vi.fn()
    useDraftStore.getState().setText(DRAFT_KEY, 'hello')
    useDraftStore.getState().setAttachments(DRAFT_KEY, [attachment])
    act(() => root.render(
      <LiveChatComposer draftKey={DRAFT_KEY} onSubmit={onSubmit} />,
    ))

    const send = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '发送')
    act(() => send?.click())

    expect(onSubmit).toHaveBeenCalledOnce()
    expect(onSubmit).toHaveBeenCalledWith({
      draftKey: DRAFT_KEY,
      text: 'hello',
      attachments: [attachment],
    })
    const submitted = onSubmit.mock.calls[0][0]
    expect(submitted.attachments).not.toBe(useDraftStore.getState().attachments[DRAFT_KEY])
  })

  it('forwards slash commands with their draft snapshot and preserves command ownership', () => {
    const onSlashCommand = vi.fn()
    useDraftStore.getState().setText(DRAFT_KEY, '/new')
    act(() => root.render(
      <LiveChatComposer
        draftKey={DRAFT_KEY}
        onSubmit={vi.fn()}
        onSlashCommand={onSlashCommand}
      />,
    ))

    const option = host.querySelector<HTMLButtonElement>('[role="option"]')
    act(() => option?.click())

    expect(onSlashCommand).toHaveBeenCalledWith('/new', {
      draftKey: DRAFT_KEY,
      text: '/new',
      attachments: [],
    })
    expect(useDraftStore.getState().texts[DRAFT_KEY]).toBe('/new')
  })

  it('keeps BTW owned by the composer session and clears its command text', () => {
    useDraftStore.getState().setText(DRAFT_KEY, '/')
    act(() => root.render(
      <LiveChatComposer
        draftKey={DRAFT_KEY}
        sessionId="session-a"
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
      />,
    ))

    const btw = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((button) => button.textContent?.includes('/btw'))
    expect(btw).toBeTruthy()
    act(() => btw?.click())

    expect(useDraftStore.getState().texts[DRAFT_KEY]).toBe('')
    expect(host.textContent).toContain('BTW 旁路提问')
  })

  it('keeps the stop action independent of an empty draft', () => {
    const onStop = vi.fn()
    act(() => root.render(
      <LiveChatComposer
        draftKey={DRAFT_KEY}
        onSubmit={vi.fn()}
        onStop={onStop}
        stopActive
      />,
    ))

    const stop = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === '停止')
    expect(stop?.disabled).toBe(false)
    act(() => stop?.click())
    expect(onStop).toHaveBeenCalledOnce()
  })
})
