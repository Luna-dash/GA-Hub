import { afterEach, describe, expect, it } from 'vitest'
import { installChatSelectionGuard } from './chatSelection'

describe('chatSelection guard', () => {
  let cleanup: (() => void) | null = null

  afterEach(() => {
    cleanup?.()
    cleanup = null
    window.getSelection()?.removeAllRanges()
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-chat-drag-lock')
  })

  function mountFixture() {
    document.body.innerHTML = `
      <aside id="sidebar">Sidebar Navigation</aside>
      <main>
        <header id="page-header">Page Header</header>
        <div id="feed" data-chat-scope>
          <article class="turn">
            <div id="box-1" data-chat-box>
              <div data-chat-box-chrome>GA Agent <button type="button">复制</button></div>
              <p id="p-1">First message body</p>
              <pre><button class="md-code-copy">复制</button><code id="code-1">const a = 1;</code></pre>
            </div>
            <span id="time-1">10:00</span>
          </article>
          <article class="turn">
            <div id="box-2" data-chat-box>
              <div data-chat-box-chrome>Agy Agent <button type="button">复制</button></div>
              <p id="p-2">Second message body</p>
            </div>
          </article>
        </div>
        <textarea id="composer">Draft prompt</textarea>
      </main>
    `
    cleanup = installChatSelectionGuard()
    return {
      box1: document.getElementById('box-1')!,
      box2: document.getElementById('box-2')!,
      p1: document.getElementById('p-1')!,
      p2: document.getElementById('p-2')!,
      code1: document.getElementById('code-1')!,
      sidebar: document.getElementById('sidebar')!,
      composer: document.getElementById('composer') as HTMLTextAreaElement,
    }
  }

  it('scopes Ctrl+A to only the clicked single chat box and excludes chrome/buttons', () => {
    const { p1, box1 } = mountFixture()

    p1.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    expect(document.documentElement.getAttribute('data-chat-drag-lock')).toBe('true')
    expect(box1.getAttribute('data-chat-drag-active')).toBe('true')
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    expect(document.documentElement.getAttribute('data-chat-drag-lock')).toBeNull()
    expect(box1.getAttribute('data-chat-drag-active')).toBeNull()

    const keyEvent = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(keyEvent)

    expect(keyEvent.defaultPrevented).toBe(true)
    const sel = window.getSelection()!
    expect(sel.toString()).toContain('First message body')
    expect(sel.toString()).toContain('const a = 1;')
    expect(sel.toString()).not.toContain('Second message body')
    expect(sel.toString()).not.toContain('Sidebar Navigation')
    expect(sel.toString()).not.toContain('GA Agent')
  })

  it('does not intercept Ctrl+A inside editable inputs or after clicking outside chat boxes', () => {
    const { p2, sidebar, composer } = mountFixture()

    p2.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))

    // Moving focus to composer preserves native Ctrl+A in textarea
    composer.focus()
    const inComposer = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
    composer.dispatchEvent(inComposer)
    expect(inComposer.defaultPrevented).toBe(false)

    // Clicking outside any box clears active box memory
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    sidebar.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))
    const outside = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(outside)
    expect(outside.defaultPrevented).toBe(false)
  })

  it('clamps cross-box selections back inside the anchor box both forward and backward', () => {
    const { p1, p2, code1 } = mountFixture()
    const sel = window.getSelection()!

    // Forward cross-box selection: starts in box-1, extends into box-2
    const forwardRange = document.createRange()
    forwardRange.setStart(p1.firstChild!, 6)
    forwardRange.setEnd(p2.firstChild!, 6)
    sel.removeAllRanges()
    sel.addRange(forwardRange)
    document.dispatchEvent(new Event('selectionchange'))

    expect(sel.toString()).toContain('message body')
    expect(sel.toString()).toContain('const a = 1;')
    expect(sel.toString()).not.toContain('Second')
    expect(p1.contains(sel.anchorNode)).toBe(true)
    expect(code1.contains(sel.focusNode)).toBe(true)

    // Backward cross-box selection: anchor in box-2, focus dragged up into box-1
    if (typeof sel.setBaseAndExtent === 'function') {
      sel.setBaseAndExtent(p2.firstChild!, 6, p1.firstChild!, 0)
      document.dispatchEvent(new Event('selectionchange'))
      expect(sel.toString()).toBe('Second')
      expect(sel.toString()).not.toContain('First')
      expect(p2.contains(sel.focusNode)).toBe(true)
    }
  })

  it('ignores background chat boxes when a modal dialog is open', () => {
    const { p1 } = mountFixture()
    p1.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }))

    const modal = document.createElement('div')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.textContent = 'Modal Content'
    document.body.appendChild(modal)

    const keyEvent = new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true })
    document.dispatchEvent(keyEvent)
    expect(keyEvent.defaultPrevented).toBe(false)
  })
})
