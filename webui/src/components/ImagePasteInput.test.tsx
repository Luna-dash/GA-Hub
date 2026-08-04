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

    const option = container.querySelector<HTMLButtonElement>('[role="option"]')
    expect(option?.textContent).toContain('/new')
    act(() => option?.click())

    expect(onSlashCommand).toHaveBeenCalledWith('/new')
    expect(onText).not.toHaveBeenCalled()
  })
})
