export interface UtilityRailPointerEvent {
  button: number
  target: EventTarget | null
  preventDefault: () => void
}

export function focusChatScrollFromUtilityRail(
  event: UtilityRailPointerEvent,
  scrollElement: HTMLElement | null,
) {
  if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest('button')) return
  event.preventDefault()
  scrollElement?.focus({ preventScroll: true })
}
