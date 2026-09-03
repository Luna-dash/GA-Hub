// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalOverlay } from './ModalOverlay'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ModalOverlay behaviour contract', () => {
  let host: HTMLDivElement
  let root: Root | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    host?.remove()
  })

  function render(ui: ReactNode) {
    act(() => root?.render(ui))
  }

  function panel(): HTMLDivElement {
    const el = host.querySelector('[role="dialog"]')
    if (!(el instanceof HTMLDivElement)) throw new Error('dialog panel not found')
    return el
  }

  function key(key: string, shift = false) {
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey: shift, bubbles: true, cancelable: true }),
      )
    })
  }

  it('closes on Escape and on backdrop clicks', () => {
    const onClose = vi.fn()
    render(<ModalOverlay onClose={onClose}><button>inner</button></ModalOverlay>)

    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)

    act(() => {
      host.firstElementChild!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      )
    })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('ignores backdrop clicks when closeOnBackdrop is false', () => {
    const onClose = vi.fn()
    render(
      <ModalOverlay onClose={onClose} closeOnBackdrop={false}>
        <button>inner</button>
      </ModalOverlay>,
    )
    act(() => {
      host.firstElementChild!.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true }),
      )
    })
    // The inner panel still closes through its own controls.
    key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the panel on open and back to the opener on close', () => {
    // Outside the root container: unmounting clears the container and would
    // otherwise detach the opener, making focus restore unobservable.
    const opener = document.createElement('button')
    opener.textContent = 'opener'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    render(
      <ModalOverlay onClose={vi.fn()}><button>inner</button></ModalOverlay>,
    )
    expect(panel().contains(document.activeElement)).toBe(true)

    act(() => root!.unmount())
    root = createRoot(host)
    expect(opener.isConnected).toBe(true)
    expect(document.activeElement).toBe(opener)
  })

  it('traps Tab navigation inside the panel', () => {
    render(
      <ModalOverlay onClose={vi.fn()}>
        <button>first</button>
        <button>last</button>
      </ModalOverlay>,
    )
    const buttons = panel().querySelectorAll('button')
    const [first, last] = buttons

    first.focus()
    key('Tab', true) // shift+tab on the first wraps to the last
    expect(document.activeElement).toBe(last)

    key('Tab') // tab on the last wraps back to the first
    expect(document.activeElement).toBe(first)
  })

  it('labels the dialog via labelledBy', () => {
    render(
      <ModalOverlay onClose={vi.fn()} labelledBy="some-title">
        <h2 id="some-title">标题</h2>
      </ModalOverlay>,
    )
    expect(panel().getAttribute('aria-labelledby')).toBe('some-title')
    expect(panel().getAttribute('aria-modal')).toBe('true')
  })
})
