// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModalOverlay } from './ModalOverlay'
import { DialogHost } from './DialogHost'
import { CommandPalette } from './CommandPalette'
import { AntiModelSelector } from './AntiModelSelector'
import { dialog, useDialogStore } from '@/stores/dialogStore'
import { useChatStore } from '@/stores/chatStore'
import { Z_LAYERS } from '@/config/zLayers'
import { useOverlayRegistration } from '@/hooks/useOverlayRegistration'
import { registerOverlay } from '@/utils/overlayStack'
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

  it('orders Z_LAYERS monotonically so tooltips/popovers stay under modals and modals under palette/dialog/gate', () => {
    expect(Z_LAYERS.tooltip).toBeLessThan(Z_LAYERS.popover)
    expect(Z_LAYERS.popover).toBeLessThan(Z_LAYERS.modal)
    expect(Z_LAYERS.modal).toBeLessThan(Z_LAYERS.contextMenu)
    expect(Z_LAYERS.contextMenu).toBeLessThan(Z_LAYERS.palette)
    expect(Z_LAYERS.palette).toBeLessThan(Z_LAYERS.dialog)
    expect(Z_LAYERS.dialog).toBeLessThan(Z_LAYERS.toast)
    expect(Z_LAYERS.toast).toBeLessThan(Z_LAYERS.gate)
    expect(Z_LAYERS.gate).toBeLessThan(Z_LAYERS.chrome)
  })

  it('lets trapFocus=false popovers arbitrate Escape without trapping Tab and ignores callback churn', () => {
    function PopoverHarness() {
      const [open, setOpen] = useState(true)
      const [tick, setTick] = useState(0)
      useOverlayRegistration({
        active: open,
        zIndex: Z_LAYERS.popover,
        getPanel: () => document.getElementById('pop-panel'),
        onEscape: () => {
          void tick
          setOpen(false)
        },
        trapFocus: false,
      })
      return (
        <>
          <button id="pop-re-render" type="button" onClick={() => setTick((v) => v + 1)}>Rerender</button>
          {open && (
            <div id="pop-panel" role="dialog">
              <button id="pop-inner" type="button">Inner</button>
            </div>
          )}
        </>
      )
    }

    act(() => root.render(<PopoverHarness />))
    const inner = document.getElementById('pop-inner') as HTMLButtonElement
    inner.focus()

    // Tab is NOT defaultPrevented when trapFocus=false
    let tabEvent!: KeyboardEvent
    act(() => {
      tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      window.dispatchEvent(tabEvent)
    })
    expect(tabEvent.defaultPrevented).toBe(false)

    // Stack a higher overlay (modal), trigger callback identity churn, and verify Escape hits modal first
    const modalEsc = vi.fn()
    const modalReg = registerOverlay({ zIndex: Z_LAYERS.modal, getPanel: () => null, onEscape: modalEsc })
    try {
      act(() => { (document.getElementById('pop-re-render') as HTMLButtonElement).click() })
      pressWindowKey('Escape')
      expect(modalEsc).toHaveBeenCalledTimes(1)
      expect(document.getElementById('pop-panel')).not.toBeNull()
    } finally {
      modalReg.unregister()
    }

    // Now popover is top and handles Escape
    pressWindowKey('Escape')
    expect(document.getElementById('pop-panel')).toBeNull()
  })

  it('keeps Tab trapped across a ModalOverlay and a portaled trapFocus=false AntiModelSelector above it', () => {
    function NestedSelectorHarness() {
      const [modalOpen, setModalOpen] = useState(true)
      const [familyKey, setFamilyKey] = useState('gemini-4-hydrogen')
      return (
        <>
          <button id="bg-outside" type="button">Background</button>
          {modalOpen && (
            <ModalOverlay onClose={() => setModalOpen(false)} labelledBy="nested-modal-title">
              <h2 id="nested-modal-title">Nested Modal</h2>
              <button id="modal-first-btn" type="button">First</button>
              <AntiModelSelector
                families={[
                  { key: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', variants: { high: 'gemini-4-hydrogen-high' } },
                  { key: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', variants: { high: 'claude-sonnet-5-5-high' } },
                ]}
                selectedFamilyKey={familyKey}
                effort="high"
                effortOptions={[{ key: 'low', name: 'low' }, { key: 'high', name: 'high' }]}
                isOrchestrator={false}
                onSelectFamily={setFamilyKey}
                onSelectEffort={vi.fn()}
                onOpenOrchestratorSettings={vi.fn()}
              />
              <button id="modal-tail-btn" type="button" onClick={() => setModalOpen(false)}>Tail</button>
            </ModalOverlay>
          )}
        </>
      )
    }

    act(() => root.render(<NestedSelectorHarness />))

    const bgOutside = document.getElementById('bg-outside') as HTMLButtonElement
    const firstBtn = document.getElementById('modal-first-btn') as HTMLButtonElement
    const triggerBtn = document.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="模型"]')!
    const tailBtn = document.getElementById('modal-tail-btn') as HTMLButtonElement

    // Open the portaled AntiModelSelector menu (zIndex = Z_LAYERS.contextMenu > Z_LAYERS.modal, trapFocus = false)
    act(() => triggerBtn.click())
    const menu = document.querySelector<HTMLElement>('.model-select-menu')!
    expect(menu).not.toBeNull()
    const firstOption = menu.querySelector<HTMLButtonElement>('[role="option"]')!
    const settingsBtn = menu.querySelector<HTMLButtonElement>('[data-anti-open-model-settings]')!

    // Tab from the last item in the portaled menu wraps to the first focusable in ModalOverlay without escaping
    settingsBtn.focus()
    let tabEv!: KeyboardEvent
    act(() => {
      tabEv = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
      window.dispatchEvent(tabEv)
    })
    expect(tabEv.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(firstBtn)
    expect(document.activeElement).not.toBe(bgOutside)

    // Shift+Tab from the first focusable in ModalOverlay wraps to the last item in the portaled menu
    let shiftTabEv!: KeyboardEvent
    act(() => {
      shiftTabEv = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
      window.dispatchEvent(shiftTabEv)
    })
    expect(shiftTabEv.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(settingsBtn)

    // Tab across the boundary from ModalOverlay's last button enters the portaled menu instead of document.body
    tailBtn.focus()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(firstOption)

    // Shift+Tab from the first item of the portaled menu returns to ModalOverlay's tail button
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    })
    expect(document.activeElement).toBe(tailBtn)

    // Escape closes only the selector first, then Escape closes ModalOverlay
    pressWindowKey('Escape')
    expect(document.querySelector('.model-select-menu')).toBeNull()
    expect(document.getElementById('nested-modal-title')).not.toBeNull()
    expect(document.activeElement).toBe(triggerBtn)

    pressWindowKey('Escape')
    expect(document.getElementById('nested-modal-title')).toBeNull()
  })
})
