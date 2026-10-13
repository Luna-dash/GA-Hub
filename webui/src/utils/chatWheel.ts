// Only the sibling utility rail needs synthetic routing. Transcript descendants
// must keep native wheel scrolling, including the browser's nested scroll chain.
export function routeChatWheel(event: WheelEvent, scroller: HTMLElement, onUserGesture: () => void): void {
  const target = event.target instanceof Element ? event.target : null
  if (target && scroller.contains(target)) return
  if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey
    || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
  if (target?.closest('textarea,input,select,[contenteditable="true"],[data-chat-wheel-independent]')) return
  const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1)
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const next = Math.max(0, Math.min(max, scroller.scrollTop + delta))
  // The rail has no scroll ancestor in the conversation; don't leak to the page.
  event.preventDefault()
  if (next !== scroller.scrollTop) {
    onUserGesture()
    scroller.scrollTop = next
  }
}
