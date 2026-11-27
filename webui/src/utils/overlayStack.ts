// Shared registry for modal/palette overlays so the visually topmost layer
// exclusively owns Escape dismissal, Tab focus trapping, and body scroll lock.

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

export interface OverlayOptions {
  zIndex: number
  getPanel: () => HTMLElement | null
  onEscape: () => void
  lockScroll?: boolean
  trapFocus?: boolean
}

interface OverlayEntry {
  id: number
  zIndex: number
  order: number
  getPanel: () => HTMLElement | null
  onEscape: () => void
  lockScroll: boolean
  trapFocus: boolean
}

let nextId = 0
let nextOrder = 0
const stack: OverlayEntry[] = []
let scrollLocks = 0
let previousBodyOverflow = ''
let listenerInstalled = false

function compareOverlayOrder(a: OverlayEntry, b: OverlayEntry): number {
  return a.zIndex !== b.zIndex ? a.zIndex - b.zIndex : a.order - b.order
}

function getSortedOverlays(): OverlayEntry[] {
  return [...stack].sort(compareOverlayOrder)
}

function pickTopOverlay(): OverlayEntry | null {
  if (stack.length === 0) return null
  return stack.reduce((best, entry) => (
    compareOverlayOrder(entry, best) > 0 ? entry : best
  ))
}

function getFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.closest('[hidden]'))
}

function onWindowKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  const top = pickTopOverlay()
  if (!top) return

  if (event.key === 'Escape') {
    event.preventDefault()
    top.onEscape()
    return
  }

  if (event.key !== 'Tab') return
  const sorted = getSortedOverlays()
  let trapIndex = sorted.length - 1
  if (!top.trapFocus) {
    trapIndex = -1
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].trapFocus) {
        trapIndex = i
        break
      }
    }
    if (trapIndex === -1) return
  }

  const scopedEntries = sorted.slice(trapIndex)
  const trapPanel = scopedEntries[0].getPanel()
  const panels = scopedEntries
    .map((entry) => entry.getPanel())
    .filter((panel): panel is HTMLElement => panel !== null)
  if (!trapPanel || panels.length === 0) return

  const seen = new Set<HTMLElement>()
  const focusable: HTMLElement[] = []
  for (const panel of panels) {
    for (const element of getFocusableElements(panel)) {
      if (!seen.has(element)) {
        seen.add(element)
        focusable.push(element)
      }
    }
  }

  if (focusable.length === 0) {
    event.preventDefault()
    trapPanel.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  const insidePanel = active !== null && panels.some((panel) => panel.contains(active) && active !== panel)

  if (!insidePanel) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  } else if (panels.length > 1) {
    const activeIndex = focusable.indexOf(active)
    if (activeIndex === -1) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return
    }
    const next = focusable[event.shiftKey ? activeIndex - 1 : activeIndex + 1]
    if (next && !panels.some((panel) => panel.contains(active) && panel.contains(next))) {
      event.preventDefault()
      next.focus()
    }
  }
}

function syncGlobalHooks(): void {
  if (stack.length > 0 && !listenerInstalled) {
    window.addEventListener('keydown', onWindowKeyDown)
    listenerInstalled = true
  } else if (stack.length === 0 && listenerInstalled) {
    window.removeEventListener('keydown', onWindowKeyDown)
    listenerInstalled = false
  }
}

export function isTopOverlay(id: number | null): boolean {
  if (id === null) return false
  return pickTopOverlay()?.id === id
}

/** Whether any managed overlay layer is currently mounted on top of the page. */
export function hasActiveOverlay(): boolean {
  return stack.length > 0
}

/** Whether any registered overlay sits strictly above `zIndex` (e.g. a modal/dialog over a popover). */
export function hasHigherLayerOverlay(zIndex: number): boolean {
  return stack.some((entry) => entry.zIndex > zIndex)
}

/** Whether `node` resides inside any registered focus-trapping overlay panel. */
export function isInsideTrappedOverlay(node: Node | null): boolean {
  if (!node) return false
  return stack.some((entry) => entry.trapFocus && Boolean(entry.getPanel()?.contains(node)))
}

export function restoreOverlayFocus(opener: HTMLElement | null): void {
  const top = pickTopOverlay()
  if (top && top.trapFocus) {
    const panel = top.getPanel()
    if (opener?.isConnected && !(opener as HTMLButtonElement).disabled && panel?.contains(opener)) {
      opener.focus()
      return
    }
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus()
    }
    return
  }
  if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) {
    opener.focus()
    return
  }
  top?.getPanel()?.focus()
}

export function registerOverlay(options: OverlayOptions): { id: number; unregister: () => void } {
  const id = ++nextId
  const order = ++nextOrder
  const lockScroll = options.lockScroll ?? true
  const trapFocus = options.trapFocus ?? true
  const entry: OverlayEntry = {
    id,
    zIndex: options.zIndex,
    order,
    getPanel: options.getPanel,
    onEscape: options.onEscape,
    lockScroll,
    trapFocus,
  }
  stack.push(entry)
  if (lockScroll) {
    if (scrollLocks === 0) previousBodyOverflow = document.body.style.overflow
    scrollLocks += 1
    document.body.style.overflow = 'hidden'
  }
  syncGlobalHooks()

  let removed = false
  return {
    id,
    unregister: () => {
      if (removed) return
      removed = true
      const idx = stack.findIndex((item) => item.id === id)
      if (idx !== -1) stack.splice(idx, 1)
      if (lockScroll && scrollLocks > 0) {
        scrollLocks -= 1
        if (scrollLocks === 0) document.body.style.overflow = previousBodyOverflow
      }
      syncGlobalHooks()
    },
  }
}
