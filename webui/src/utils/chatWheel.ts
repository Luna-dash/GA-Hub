// Route vertical reader gestures across the transcript and its sibling utility rail.
// Native capture (passive:false) is required: React's delegated wheel listener is passive.
export function routeChatWheel(event: WheelEvent, scroller: HTMLElement, onUserGesture: () => void): void {
  if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey
    || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  const target = event.target instanceof Element ? event.target : null
  // Editable widgets and the independently scrollable scheduled-message list keep native behavior.
  if (target?.closest('textarea, input, select, [contenteditable="true"], [data-chat-wheel-independent]')) return
  // Preserve native nested scrolling while a reader has room in this direction.
  // Once it reaches its edge, route to the transcript even with overscroll-contain.
  if (target && scroller.contains(target)) {
    for (let node: Element | null = target; node && node !== scroller; node = node.parentElement) {
      if (!(node instanceof HTMLElement)) continue
      const overflowY = window.getComputedStyle(node).overflowY
      const innerMax = node.scrollHeight - node.clientHeight
      if ((overflowY === 'auto' || overflowY === 'scroll') && innerMax > 0
        && (event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < innerMax - 1)) {
        onUserGesture()
        return
      }
    }
  }
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1)
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const next = Math.max(0, Math.min(max, scroller.scrollTop + delta))
  if (next !== scroller.scrollTop) {
    event.preventDefault()
    onUserGesture()
    scroller.scrollTop = next
  } else if (!target || !scroller.contains(target)) {
    // The utility rail has no scroll ancestor in the conversation; don't leak to the page.
    event.preventDefault()
  }
  // At a conversation boundary, native scrolling can still read the capped inner record.
}
