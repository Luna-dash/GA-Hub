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
}

interface OverlayEntry {
  id: number
  zIndex: number
  order: number
  getPanel: () => HTMLElement | null
  onEscape: () => void
  lockScroll: boolean
}

let nextId = 0
let nextOrder = 0
const stack: OverlayEntry[] = []
let scrollLocks = 0
let previousBodyOverflow = ''
let listenerInstalled = false

function pickTopOverlay(): OverlayEntry | null {
  if (stack.length === 0) return null
  return stack.reduce((best, entry) => (
    entry.zIndex > best.zIndex || (entry.zIndex === best.zIndex && entry.order > best.order)
      ? entry
      : best
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
  const panel = top.getPanel()
  if (!panel) return

  const focusable = getFocusableElements(panel)
  if (focusable.length === 0) {
    event.preventDefault()
    panel.focus()
    return
  }

  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement as HTMLElement | null
  const insidePanel = active !== null && panel.contains(active) && active !== panel

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

export function restoreOverlayFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected && !(opener as HTMLButtonElement).disabled) {
    opener.focus()
    return
  }
  pickTopOverlay()?.getPanel()?.focus()
}

export function registerOverlay(options: OverlayOptions): { id: number; unregister: () => void } {
  const id = ++nextId
  const order = ++nextOrder
  const lockScroll = options.lockScroll ?? true
  const entry: OverlayEntry = {
    id,
    zIndex: options.zIndex,
    order,
    getPanel: options.getPanel,
    onEscape: options.onEscape,
    lockScroll,
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
