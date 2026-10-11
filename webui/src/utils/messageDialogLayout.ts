/** Natural content height, independent of the native window's initial height.
 * The body flexes to fill the viewport; measuring its box would preserve blank
 * space. Instead add content/icon height, actual padding and the footer. */
export function measureMessageDialogHeight(panel: HTMLElement): number {
  const body = panel.querySelector<HTMLElement>('.message-dialog-body')
  const content = panel.querySelector<HTMLElement>('.message-dialog-content')
  const icon = panel.querySelector<HTMLElement>('.message-dialog-icon')
  const footer = panel.querySelector<HTMLElement>('.message-dialog-footer')
  if (!body || !content || !footer) return 240
  const style = getComputedStyle(body)
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  const natural = Math.max(content.scrollHeight, icon?.getBoundingClientRect().height ?? 0)
    + padding + footer.getBoundingClientRect().height
  return Math.min(640, Math.max(160, Math.ceil(natural) + 2))
}
