import { describe, it, expect, vi } from 'vitest'
import { measureMessageDialogHeight } from './messageDialogLayout'

function panel(contentHeight: number, footerHeight = 62) {
  const panel = document.createElement('div')
  panel.innerHTML = '<div class="message-dialog-body" style="padding:20px 22px 18px"><div class="message-dialog-icon"></div><div class="message-dialog-content"></div></div><div class="message-dialog-footer"></div>'
  Object.defineProperty(panel.querySelector('.message-dialog-content'), 'scrollHeight', { value: contentHeight })
  vi.spyOn(panel.querySelector<HTMLElement>('.message-dialog-icon')!, 'getBoundingClientRect').mockReturnValue({ height: 38 } as DOMRect)
  vi.spyOn(panel.querySelector<HTMLElement>('.message-dialog-footer')!, 'getBoundingClientRect').mockReturnValue({ height: footerHeight } as DOMRect)
  return panel
}
describe('native message window natural sizing', () => {
  it('measures padding and footer instead of adding arbitrary 140px', () => {
    expect(measureMessageDialogHeight(panel(106))).toBe(208)
  })
  it('keeps a small floor for short alerts, caps long text for scrolling', () => {
    expect(measureMessageDialogHeight(panel(20))).toBe(160)
    expect(measureMessageDialogHeight(panel(900))).toBe(640)
  })
  it('uses a safe fallback if not mounted', () => {
    expect(measureMessageDialogHeight(document.createElement('div'))).toBe(240)
  })
})
