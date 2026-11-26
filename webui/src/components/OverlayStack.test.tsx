// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalOverlay } from './ModalOverlay'
import { DialogHost } from './DialogHost'
import { CommandPalette } from './CommandPalette'
import { dialog, useDialogStore } from '@/stores/dialogStore'
import { useChatStore } from '@/stores/chatStore'
import { Z_LAYERS } from '@/config/zLayers'
import { api } from '@/api/client'

vi.mock('@/api/client', () => ({
  api: {
    llms: vi.fn(),
    schedules: vi.fn(),
    sops: vi.fn(),
    conversations: vi.fn(),
  },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Overlay stack arbitration across ModalOverlay, CommandPalette, and DialogHost', () => {
  let host: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    vi.resetAllMocks()
    document.body.style.overflow = ''
    useDialogStore.setState({
      open: false, config: null, resolve: null, queue: [],
      notificationConfig: null, notificationResolve: null, notificationQueue: [],
    })
    useChatStore.setState({ sessionId: null, msgs: [] })
    vi.mocked(api.llms).mockResolvedValue({ llms: [] } as never)
    vi.mocked(api.schedules).mockResolvedValue({ schedules: [] } as never)
    vi.mocked(api.sops).mockResolvedValue({ sops: [] } as never)
    vi.mocked(api.conversations).mockResolvedValue({ items: [] } as never)
    Element.prototype.scrollIntoView = vi.fn()
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    client.clear()
    document.body.style.overflow = ''
    useDialogStore.setState({
      open: false, config: null, resolve: null, queue: [],
      notificationConfig: null, notificationResolve: null, notificationQueue: [],
    })
    vi.restoreAllMocks()
  })

  const pressWindowKey = (key: string, init: KeyboardEventInit = {}) => {
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
    })
  }

  function Harness() {
    const [openModal, setOpenModal] = useState(false)
    return (
      <>
        <button id="page-opener" type="button" onClick={() => setOpenModal(true)}>Open Modal</button>
        {openModal && (
          <ModalOverlay onClose={() => setOpenModal(false)} labelledBy="base-modal-title">
            <h2 id="base-modal-title">基础弹窗</h2>
            <button id="modal-confirm-trigger" type="button" onClick={() => { void dialog.confirm('确认操作？', '详情') }}>
              Trigger Confirm
            </button>
            <button id="modal-close-btn" type="button" onClick={() => setOpenModal(false)}>Close Modal</button>
          </ModalOverlay>
        )}
        <DialogHost />
        <CommandPalette />
      </>
    )
  }

  function renderHarness() {
    act(() => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </QueryClientProvider>,
    ))
  }

  it('closes only the topmost overlay on each Escape and restores focus per layer (Modal + DialogHost)', () => {
    renderHarness()
    const opener = document.getElementById('page-opener') as HTMLButtonElement
    opener.focus()
    act(() => opener.click())

    const trigger = document.getElementById('modal-confirm-trigger') as HTMLButtonElement
    expect(document.getElementById('base-modal-title')).not.toBeNull()
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    act(() => trigger.click())
    const titleEl = document.getElementById('message-dialog-title')
    expect(titleEl?.textContent).toBe('确认操作？')
    const dialogBackdrop = titleEl!.closest('.fixed, [style*="position: fixed"]') as HTMLElement
    expect(Number(dialogBackdrop.style.zIndex)).toBe(Z_LAYERS.dialog)
    expect(document.body.style.overflow).toBe('hidden')

    // First Escape closes only DialogHost, leaving base ModalOverlay open and returning focus to trigger
    pressWindowKey('Escape')
    expect(document.getElementById('message-dialog-title')).toBeNull()
    expect(document.getElementById('base-modal-title')).not.toBeNull()
    expect(document.activeElement).toBe(trigger)
    expect(document.body.style.overflow).toBe('hidden')

    // Second Escape closes base ModalOverlay and restores focus to page opener + releases body scroll
    pressWindowKey('Escape')
    expect(document.getElementById('base-modal-title')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(document.body.style.overflow).toBe('')
  })

  it('arbitrates Escape and Tab cleanly across ModalOverlay, CommandPalette, and DialogHost', async () => {
    renderHarness()
    const opener = document.getElementById('page-opener') as HTMLButtonElement
    opener.focus()
    act(() => opener.click())

    const modalTrigger = document.getElementById('modal-confirm-trigger') as HTMLButtonElement
    modalTrigger.focus()

    // Open CommandPalette over base ModalOverlay
    act(() => { window.dispatchEvent(new Event('gahub:command-palette')) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })

    const paletteDialog = host.querySelector<HTMLElement>('[aria-label="命令面板"]')!
    const paletteInput = paletteDialog.querySelector('input')!
    expect(document.activeElement).toBe(paletteInput)

    // Tab wraps strictly within CommandPalette rather than leaking to ModalOverlay underneath
    pressWindowKey('Tab', { shiftKey: true })
    expect(paletteDialog.contains(document.activeElement)).toBe(true)

    // Stack DialogHost (z=60) above CommandPalette (z=55)
    act(() => { void dialog.alert('全局提示', '置于顶层') })
    expect(document.getElementById('message-dialog-title')?.textContent).toBe('全局提示')

    // Esc 1 -> closes only DialogHost (60); CommandPalette (55) and Modal (50) remain open
    pressWindowKey('Escape')
    expect(document.getElementById('message-dialog-title')).toBeNull()
    expect(host.querySelector('[aria-label="命令面板"]')).not.toBeNull()
    expect(document.getElementById('base-modal-title')).not.toBeNull()

    // Esc 2 -> closes only CommandPalette (55) and returns focus to modalTrigger inside Modal (50)
    pressWindowKey('Escape')
    expect(host.querySelector('[aria-label="命令面板"]')).toBeNull()
    expect(document.getElementById('base-modal-title')).not.toBeNull()
    expect(document.activeElement).toBe(modalTrigger)

    // Esc 3 -> closes base Modal (50) and returns focus to page opener
    pressWindowKey('Escape')
    expect(document.getElementById('base-modal-title')).toBeNull()
    expect(document.activeElement).toBe(opener)
    expect(document.body.style.overflow).toBe('')
  })

  it('ignores IME composing Escape and keyCode 229 in global overlay keydown listener', () => {
    act(() => root.render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <DialogHost />
        </QueryClientProvider>
      </MemoryRouter>,
    ))
    act(() => { void dialog.alert('输入法提示', '确认') })
    expect(document.getElementById('message-dialog-title')?.textContent).toBe('输入法提示')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }))
    })
    expect(document.getElementById('message-dialog-title')).not.toBeNull()

    const legacy = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    Object.defineProperty(legacy, 'keyCode', { value: 229 })
    act(() => { window.dispatchEvent(legacy) })
    expect(document.getElementById('message-dialog-title')).not.toBeNull()

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(document.getElementById('message-dialog-title')).toBeNull()
  })
})
