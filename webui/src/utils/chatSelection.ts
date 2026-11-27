/**
 * Scopes text selection and Ctrl/Cmd+A inside individual chat message boxes
 * (`[data-chat-box]`), preventing whole-page selection and cross-box dragging.
 */

const CHAT_BOX_SELECTOR = '[data-chat-box]'
const CHAT_CHROME_SELECTOR = '[data-chat-box-chrome], .md-code-copy, .select-none'
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]'

interface SelectionEndpoint {
  node: Text
  offset: number
}

function asElement(target: EventTarget | Node | null): Element | null {
  if (!target) return null
  if (target instanceof Element) return target
  if (target instanceof Node) return target.parentElement
  return null
}

export function findChatBox(target: EventTarget | Node | null): HTMLElement | null {
  const el = asElement(target)
  return el?.closest<HTMLElement>(CHAT_BOX_SELECTOR) ?? null
}

export function isEditableTarget(target: EventTarget | Node | null): boolean {
  const el = asElement(target)
  if (!el) return false
  if (el instanceof HTMLElement && el.isContentEditable) return true
  return Boolean(el.closest(EDITABLE_SELECTOR))
}

function isSelectableTextNode(node: Text, box: HTMLElement): boolean {
  if (!box.contains(node) || node.data.length === 0) return false
  const parent = node.parentElement
  if (!parent) return false
  if (parent.closest(CHAT_CHROME_SELECTOR)) return false
  if (parent.closest('[hidden], [aria-hidden="true"], script, style, noscript')) return false
  return true
}

export function getSelectableEndpoints(
  box: HTMLElement,
): { first: SelectionEndpoint; last: SelectionEndpoint } | null {
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT)
  let firstMeaningful: Text | null = null
  let lastMeaningful: Text | null = null
  let firstNonEmpty: Text | null = null
  let lastNonEmpty: Text | null = null

  let current = walker.nextNode()
  while (current) {
    const textNode = current as Text
    if (isSelectableTextNode(textNode, box)) {
      if (!firstNonEmpty) firstNonEmpty = textNode
      lastNonEmpty = textNode
      if (textNode.data.trim().length > 0) {
        if (!firstMeaningful) firstMeaningful = textNode
        lastMeaningful = textNode
      }
    }
    current = walker.nextNode()
  }

  const firstNode = firstMeaningful ?? firstNonEmpty
  const lastNode = lastMeaningful ?? lastNonEmpty
  if (!firstNode || !lastNode) return null
  return {
    first: { node: firstNode, offset: 0 },
    last: { node: lastNode, offset: lastNode.data.length },
  }
}

export function selectChatBoxContents(box: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel) return false
  const endpoints = getSelectableEndpoints(box)
  const range = document.createRange()
  if (endpoints) {
    range.setStart(endpoints.first.node, endpoints.first.offset)
    range.setEnd(endpoints.last.node, endpoints.last.offset)
  } else {
    range.selectNodeContents(box)
  }
  sel.removeAllRanges()
  sel.addRange(range)
  return true
}

function setOrderedSelection(
  sel: Selection,
  anchorNode: Node,
  anchorOffset: number,
  focusNode: Node,
  focusOffset: number,
  backward: boolean,
): void {
  if (typeof sel.setBaseAndExtent === 'function') {
    sel.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset)
    return
  }
  const range = document.createRange()
  if (backward) {
    range.setStart(focusNode, focusOffset)
    range.setEnd(anchorNode, anchorOffset)
  } else {
    range.setStart(anchorNode, anchorOffset)
    range.setEnd(focusNode, focusOffset)
  }
  sel.removeAllRanges()
  sel.addRange(range)
}

export function clampSelectionToChatBox(sel: Selection): boolean {
  if (sel.rangeCount === 0 || sel.isCollapsed) return false
  const anchorNode = sel.anchorNode
  const focusNode = sel.focusNode
  if (!anchorNode || !focusNode) return false

  const anchorBox = findChatBox(anchorNode)
  const focusBox = findChatBox(focusNode)

  if (anchorBox === null && focusBox !== null) {
    sel.collapse(anchorNode, sel.anchorOffset)
    return true
  }
  if (!anchorBox || focusBox === anchorBox) return false

  const pos = anchorBox.compareDocumentPosition(focusNode)
  const backward = Boolean(pos & Node.DOCUMENT_POSITION_PRECEDING)
  const endpoints = getSelectableEndpoints(anchorBox)
  if (!endpoints) {
    sel.collapse(anchorNode, sel.anchorOffset)
    return true
  }
  const target = backward ? endpoints.first : endpoints.last

  // If the anchor itself sits past/before the selectable endpoint, adjust cleanly without throwing.
  const cmp = document.createRange()
  cmp.setStart(anchorNode, sel.anchorOffset)
  cmp.collapse(true)
  const targetRange = document.createRange()
  targetRange.setStart(target.node, target.offset)
  targetRange.collapse(true)
  const relation = cmp.compareBoundaryPoints(Range.START_TO_START, targetRange)
  const effectiveBackward = backward || relation > 0

  setOrderedSelection(sel, anchorNode, sel.anchorOffset, target.node, target.offset, effectiveBackward)
  return true
}

function getTopOpenModal(): HTMLElement | null {
  const modals = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')).filter(
    (el) => !el.closest('[hidden]'),
  )
  return modals.length > 0 ? modals[modals.length - 1] : null
}

let refCount = 0
let uninstallSingleton: (() => void) | null = null

export function installChatSelectionGuard(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return () => {}
  }
  refCount += 1
  if (uninstallSingleton) {
    return () => {
      refCount = Math.max(0, refCount - 1)
      if (refCount === 0 && uninstallSingleton) {
        uninstallSingleton()
        uninstallSingleton = null
      }
    }
  }

  let lastActiveBox: HTMLElement | null = null
  let dragActiveBox: HTMLElement | null = null
  let isClamping = false

  const clearDragLock = () => {
    if (dragActiveBox) {
      dragActiveBox.removeAttribute('data-chat-drag-active')
      dragActiveBox = null
    }
    document.documentElement.removeAttribute('data-chat-drag-lock')
  }

  const setDragLock = (box: HTMLElement) => {
    if (dragActiveBox && dragActiveBox !== box) {
      dragActiveBox.removeAttribute('data-chat-drag-active')
    }
    dragActiveBox = box
    box.setAttribute('data-chat-drag-active', 'true')
    document.documentElement.setAttribute('data-chat-drag-lock', 'true')
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    if (isEditableTarget(event.target)) {
      lastActiveBox = null
      clearDragLock()
      return
    }
    const el = asElement(event.target)
    const box = findChatBox(el)
    lastActiveBox = box
    if (
      box &&
      !el?.closest('[data-chat-box-chrome], .md-code-copy') &&
      !el?.closest('button:not(.path-link), input, textarea, select')
    ) {
      setDragLock(box)
    } else {
      clearDragLock()
    }
  }

  const onPointerRelease = () => {
    clearDragLock()
    const sel = window.getSelection()
    if (sel && !isClamping) {
      isClamping = true
      try {
        clampSelectionToChatBox(sel)
      } finally {
        isClamping = false
      }
    }
  }

  const onVisibilityChange = () => {
    if (document.hidden) clearDragLock()
  }

  const onFocusIn = (event: FocusEvent) => {
    if (isEditableTarget(event.target)) {
      lastActiveBox = null
      return
    }
    const box = findChatBox(event.target)
    if (box) {
      lastActiveBox = box
    } else {
      const el = asElement(event.target)
      if (el && !el.closest('[data-chat-scope]')) {
        lastActiveBox = null
      }
    }
  }

  const onSelectionChange = () => {
    if (isClamping) return
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    const selBox = findChatBox(sel.anchorNode) ?? findChatBox(sel.focusNode)
    if (selBox) {
      lastActiveBox = selBox
    }
    if (!sel.isCollapsed) {
      isClamping = true
      try {
        clampSelectionToChatBox(sel)
      } finally {
        isClamping = false
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 'a') return
    if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return

    const sel = window.getSelection()
    const selBox =
      sel && sel.rangeCount > 0 ? (findChatBox(sel.anchorNode) ?? findChatBox(sel.focusNode)) : null
    const focusBox = findChatBox(document.activeElement)
    const storedBox = lastActiveBox?.isConnected ? lastActiveBox : null
    const targetBox = selBox ?? focusBox ?? storedBox
    if (!targetBox || !targetBox.isConnected) return
    if (targetBox.closest('[inert]')) return

    const topModal = getTopOpenModal()
    if (topModal && !topModal.contains(targetBox)) return

    event.preventDefault()
    isClamping = true
    try {
      selectChatBoxContents(targetBox)
    } finally {
      isClamping = false
    }
  }

  document.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointerup', onPointerRelease, true)
  window.addEventListener('pointercancel', onPointerRelease, true)
  window.addEventListener('blur', clearDragLock)
  document.addEventListener('visibilitychange', onVisibilityChange)
  document.addEventListener('focusin', onFocusIn, true)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('keydown', onKeyDown)

  uninstallSingleton = () => {
    clearDragLock()
    document.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointerup', onPointerRelease, true)
    window.removeEventListener('pointercancel', onPointerRelease, true)
    window.removeEventListener('blur', clearDragLock)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    document.removeEventListener('focusin', onFocusIn, true)
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('keydown', onKeyDown)
  }

  return () => {
    refCount = Math.max(0, refCount - 1)
    if (refCount === 0 && uninstallSingleton) {
      uninstallSingleton()
      uninstallSingleton = null
    }
  }
}
