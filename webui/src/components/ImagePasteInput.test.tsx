// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatComposerFrame } from './ChatLayout'
import { ImagePasteInput } from './ImagePasteInput'
import { Z_LAYERS } from '@/config/zLayers'
import { registerOverlay } from '@/utils/overlayStack'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  if (root) act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('ImagePasteInput slash command ownership', () => {
  it('delegates /new without clearing the controlled text first', () => {
    const onText = vi.fn()
    const onSlashCommand = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="/new"
          onText={onText}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
          onSlashCommand={onSlashCommand}
        />,
      )
    })

    const menu = container.querySelector<HTMLElement>('[role="listbox"]')
    expect(menu?.classList.contains('bg-bg-card')).toBe(true)
    expect(menu?.className).not.toContain('bg-bg-card/')
    expect(menu?.className).not.toContain('backdrop-')

    const option = container.querySelector<HTMLButtonElement>('[role="option"]')
    expect(option?.textContent).toContain('/new')
    const cmdLabel = option?.querySelector<HTMLElement>('span')
    expect(cmdLabel?.className).toContain('text-xs')
    expect(cmdLabel?.className).not.toContain('text-sm')
    act(() => option?.click())

    expect(onSlashCommand).toHaveBeenCalledWith('/new')
    expect(onText).not.toHaveBeenCalled()
  })

  it('renders compact external slash menu with footerHint when folded commands exist', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="/"
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
          slashAutocomplete={{
            open: true,
            ariaLabel: 'Agy 原生命令',
            items: [{ name: 'plan', displayName: '/plan', hint: '<目标>', description: '先调研并生成结构化方案' }],
            itemCount: 1,
            activeIndex: 0,
            onActiveIndexChange: vi.fn(),
            onSelectIndex: vi.fn(),
            onClose: vi.fn(),
            footerHint: '已折叠 2 个低频命令，继续输入关键词可搜索',
          }}
        />,
      )
    })

    const menu = container.querySelector<HTMLElement>('[role="listbox"][aria-label="Agy 原生命令"]')
    expect(menu?.textContent).toContain('/plan')
    expect(menu?.textContent).toContain('已折叠 2 个低频命令，继续输入关键词可搜索')
    const cmdLabel = menu?.querySelector<HTMLElement>('[role="option"] span')
    expect(cmdLabel?.className).toContain('text-xs')
  })

  it('offers /btw only when a session runtime owns the composer', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const render = (btwSessionId?: string) => (
      <ImagePasteInput
        text="/"
        onText={vi.fn()}
        attachments={[]}
        onAttachments={vi.fn()}
        onSubmit={vi.fn()}
        onSlashCommand={vi.fn()}
        btwSessionId={btwSessionId}
      />
    )

    act(() => root?.render(render()))
    expect(Array.from(container.querySelectorAll('[role="option"]'))
      .some((option) => option.textContent?.includes('/btw'))).toBe(false)

    act(() => root?.render(render('session-A')))
    expect(Array.from(container.querySelectorAll('[role="option"]'))
      .some((option) => option.textContent?.includes('/btw'))).toBe(true)
  })

  it('uses the same composer button to send when idle and stop when active', () => {
    const onSubmit = vi.fn()
    const onStop = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="hello"
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={onSubmit}
        />,
      )
    })
    const composer = container.querySelector('textarea')?.parentElement?.parentElement
    expect(composer?.className).not.toContain('border')
    expect(composer?.className).not.toContain('backdrop-')

    expect(Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
      .some((button) => button.textContent === 'BTW')).toBe(false)
    let action = container.querySelector<HTMLButtonElement>('button[aria-label="发送"]')
    expect(action).toBeTruthy()
    expect(action?.disabled).toBe(false)
    act(() => action?.click())
    expect(onSubmit).toHaveBeenCalledOnce()

    act(() => {
      root?.render(
        <ImagePasteInput
          text=""
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={onSubmit}
          onStop={onStop}
          stopActive
        />,
      )
    })
    action = container.querySelector<HTMLButtonElement>('button[aria-label="停止"]')
    expect(action).toBeTruthy()
    expect(action?.disabled).toBe(false)
    expect(action?.className).toContain('h-10')
    expect(action?.className).toContain('w-10')
    expect(action?.className).toContain('rounded-xl')
    expect(action?.className).toContain('mb-0.5')
    expect(action?.className).not.toContain('ga-solid-danger')
    expect(action?.className).toContain('text-status-danger')
    expect(action?.querySelector('circle')).toBeTruthy()
    expect(action?.querySelector('rect')).toBeNull()
    act(() => action?.click())
    expect(onStop).toHaveBeenCalledOnce()

    act(() => {
      root?.render(
        <ImagePasteInput
          text=""
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={onSubmit}
          onStop={onStop}
          stopActive
          stopDisabled
          stopState="stopping"
        />,
      )
    })
    action = container.querySelector<HTMLButtonElement>('button[aria-label="停止"]')
    expect(action?.getAttribute('data-stop-state')).toBe('stopping')
    expect(action?.disabled).toBe(true)
    expect(action?.querySelector('.animate-spin')).toBeTruthy()

    act(() => {
      root?.render(
        <ImagePasteInput
          text=""
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={onSubmit}
          onStop={onStop}
          stopActive
          stopState="force"
        />,
      )
    })
    action = container.querySelector<HTMLButtonElement>('button[aria-label="停止"]')
    expect(action?.getAttribute('data-stop-state')).toBe('force')
    expect(action?.className).not.toContain('ga-solid-danger')
    expect(action?.className).toContain('text-status-danger')
    expect(action?.querySelector('circle')).toBeTruthy()
  })
})

describe('ImagePasteInput attachment presentation', () => {
  it('shows images as thumbnail-only and files as content-width filenames', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text=""
          onText={vi.fn()}
          attachments={[
            {
              file_id: 'image-1',
              name: 'photo-with-a-long-name.png',
              url: '/api/upload/image-1',
              path: '/tmp/image-1.png',
              mime: 'image/png',
              size: 123,
              preview: 'data:image/png;base64,AA==',
            },
            {
              file_id: 'file-1',
              name: 'notes.txt',
              url: '/api/upload/file-1',
              path: '/tmp/file-1.txt',
              mime: 'text/plain',
              size: 456,
            },
          ]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
        />,
      )
    })

    const imageAttachment = container.querySelector<HTMLElement>('[data-attachment-kind="image"]')
    expect(imageAttachment?.querySelector('img')).toBeTruthy()
    expect(imageAttachment?.textContent).not.toContain('photo-with-a-long-name.png')
    expect(imageAttachment?.className).toContain('h-14')
    expect(imageAttachment?.className).toContain('w-14')

    const fileAttachment = container.querySelector<HTMLElement>('[data-attachment-kind="file"]')
    expect(fileAttachment?.querySelector('img')).toBeNull()
    expect(fileAttachment?.textContent).toContain('notes.txt')
    expect(fileAttachment?.textContent).not.toContain('text/plain')
    expect(fileAttachment?.className).toContain('w-fit')
    expect(fileAttachment?.className).toContain('max-w-full')
  })

  it('exposes non-modal dialog semantics on BtwDialog and closes on Escape from any child control', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="/"
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
          onSlashCommand={vi.fn()}
          btwSessionId="session-btw"
        />,
      )
    })

    const btwOption = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes('/btw'))!
    act(() => btwOption.click())

    const btwDialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="BTW 旁路提问"]')!
    expect(btwDialog).not.toBeNull()
    expect(btwDialog.getAttribute('aria-modal')).toBeNull()

    const closeBtn = btwDialog.querySelector<HTMLButtonElement>('[aria-label="关闭 BTW"]')!
    expect(closeBtn.className).not.toContain('hover:text-white')
    closeBtn.focus()
    act(() => {
      closeBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(container.querySelector('[role="dialog"][aria-label="BTW 旁路提问"]')).toBeNull()
  })

  it('supports queue-first activeSubmit with Enter defaulting to primary and Ctrl+Enter triggering secondary', () => {
    const onQueue = vi.fn()
    const onSteer = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="follow-up item"
          onText={vi.fn()}
          attachments={[]}
          onAttachments={vi.fn()}
          onSubmit={vi.fn()}
          onStop={vi.fn()}
          stopActive
          activeSubmit={{
            label: '加入排队',
            title: '加入待发队列（Enter 加入排队 · Ctrl+Enter 插话纠偏）',
            icon: 'queue',
            onSubmit: onQueue,
            secondary: {
              onSubmit: onSteer,
            },
          }}
        />,
      )
    })

    const primaryBtn = container.querySelector<HTMLButtonElement>('button[aria-label="加入排队"]')
    expect(primaryBtn).not.toBeNull()
    expect(primaryBtn?.querySelector('svg')?.getAttribute('class')).toContain('lucide-list-plus')
    expect(primaryBtn?.querySelector('svg')?.getAttribute('class')).not.toContain('lucide-clock')
    expect(primaryBtn?.className).not.toContain('ga-solid-primary')
    expect(primaryBtn?.className).toContain('bg-bg-card/95')
    expect(container.querySelector('button[aria-label="选择发送或排队方式"]')).toBeNull()
    expect(container.querySelector('[role="menu"][aria-label="运行中发送方式"]')).toBeNull()

    const textarea = container.querySelector('textarea')!
    act(() => {
      primaryBtn?.click()
    })
    expect(onQueue).toHaveBeenCalledTimes(1)
    expect(onSteer).not.toHaveBeenCalled()

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onQueue).toHaveBeenCalledTimes(2)
    expect(onSteer).not.toHaveBeenCalled()

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
    })
    expect(onSteer).toHaveBeenCalledTimes(1)
    expect(onQueue).toHaveBeenCalledTimes(2)
  })

  it('suppresses inner focus outline on textarea and shifts subtle focus border to ChatComposerFrame', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ChatComposerFrame>
          <ImagePasteInput
            text=""
            onText={vi.fn()}
            attachments={[]}
            onAttachments={vi.fn()}
            onSubmit={vi.fn()}
          />
        </ChatComposerFrame>,
      )
    })

    const textarea = container.querySelector('textarea')!
    const taClasses = textarea.className.split(/\s+/)
    expect(taClasses).toContain('outline-none')
    expect(taClasses).toContain('focus-visible:outline-none')

    const outerCard = container.querySelector('[data-file-composer]')?.parentElement
    const cardClasses = outerCard?.className.split(/\s+/) ?? []
    expect(cardClasses).toContain('border')
    expect(cardClasses).toContain('focus-within:border-accent/70')
    expect(cardClasses).not.toContain('border-2')
    expect(cardClasses.some((cls) => cls.startsWith('ring-') || cls.includes(':ring-'))).toBe(false)
  })

  it('locks attachment controls and removal when readOnly is true', () => {
    const onAttachments = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root?.render(
        <ImagePasteInput
          text="只读会话"
          onText={vi.fn()}
          readOnly
          acceptFiles
          attachments={[
            {
              file_id: 'file-ro',
              name: 'readonly.txt',
              url: '/api/files/file-ro',
              path: '/tmp/readonly.txt',
              mime: 'text/plain',
              size: 12,
            },
          ]}
          onAttachments={onAttachments}
          onSubmit={vi.fn()}
        />,
      )
    })

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')!
    expect(fileInput.disabled).toBe(true)

    const addBtn = container.querySelector<HTMLElement>('[aria-label="添加文件"]')!
    expect(addBtn.getAttribute('aria-disabled')).toBe('true')
    expect(addBtn.tabIndex).toBe(-1)

    const removeBtn = container.querySelector<HTMLButtonElement>('[aria-label="移除 readonly.txt"]')!
    expect(removeBtn.disabled).toBe(true)
    act(() => { removeBtn.click() })
    expect(onAttachments).not.toHaveBeenCalled()
  })

  it('does not steal focus with autoFocus when an overlay is open or another input is active', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const externalInput = document.createElement('input')
    document.body.appendChild(externalInput)
    externalInput.focus()
    expect(document.activeElement).toBe(externalInput)

    try {
      act(() => {
        root?.render(
          <ImagePasteInput
            text=""
            onText={vi.fn()}
            attachments={[]}
            onAttachments={vi.fn()}
            onSubmit={vi.fn()}
            autoFocus
          />,
        )
      })
      expect(document.activeElement).toBe(externalInput)

      externalInput.blur()
      const overlay = registerOverlay({ zIndex: Z_LAYERS.palette, getPanel: () => null, onEscape: () => {} })
      try {
        act(() => {
          root?.render(
            <ImagePasteInput
              text=""
              onText={vi.fn()}
              attachments={[]}
              onAttachments={vi.fn()}
              onSubmit={vi.fn()}
              autoFocus
              disabled={false}
            />,
          )
        })
        const textarea = container.querySelector('textarea')!
        expect(document.activeElement).not.toBe(textarea)
      } finally {
        overlay.unregister()
      }
    } finally {
      externalInput.remove()
    }
  })

  it('registers BtwDialog in overlayStack for Escape even when focus leaves and clamps drag within viewport bounds', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const externalButton = document.createElement('button')
    document.body.appendChild(externalButton)

    const origWidth = window.innerWidth
    const origHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 700, configurable: true })

    try {
      act(() => {
        root?.render(
          <ImagePasteInput
            text="/btw"
            onText={vi.fn()}
            attachments={[]}
            onAttachments={vi.fn()}
            onSubmit={vi.fn()}
            btwSessionId="s1"
            onSlashCommand={vi.fn()}
          />,
        )
      })

      const option = container.querySelector<HTMLButtonElement>('[role="option"]')!
      act(() => option.click())

      const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="BTW 旁路提问"]')!
      expect(dialog).not.toBeNull()

      vi.spyOn(dialog, 'getBoundingClientRect').mockImplementation(() => {
        const m = dialog.style.transform.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/)
        const tx = m ? Number(m[1]) : 0
        const ty = m ? Number(m[2]) : 0
        return {
          left: 400 + tx, top: 300 + ty, right: 800 + tx, bottom: 550 + ty, width: 400, height: 250, x: 400 + tx, y: 300 + ty, toJSON: () => ({}),
        }
      })

      // Drag far top-left -> clamped to 8px margin (400 + x >= 8 => x >= -392, 300 + y >= 8 => y >= -292)
      act(() => {
        dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 320 }))
      })
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: -1000, clientY: -1000 }))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      expect(dialog.style.transform).toBe('translate(-392px, -292px)')

      // Drag far bottom-right -> clamped to (1000 - 400 - 8 - 400 = 192, 700 - 250 - 8 - 300 = 142)
      act(() => {
        dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 320 }))
      })
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5000, clientY: 5000 }))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      expect(dialog.style.transform).toBe('translate(192px, 142px)')

      // Escape still closes even when focus is outside BtwDialog, and yields to higher overlays
      externalButton.focus()
      const higherEsc = vi.fn()
      const higher = registerOverlay({ zIndex: Z_LAYERS.dialog, getPanel: () => null, onEscape: higherEsc })
      try {
        act(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        })
        expect(higherEsc).toHaveBeenCalledTimes(1)
        expect(container.querySelector('[aria-label="BTW 旁路提问"]')).not.toBeNull()
      } finally {
        higher.unregister()
      }

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(container.querySelector('[aria-label="BTW 旁路提问"]')).toBeNull()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origWidth, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: origHeight, configurable: true })
      externalButton.remove()
    }
  })

  it('re-clamps BtwDialog position when the window shrinks after dragging', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    const origWidth = window.innerWidth
    const origHeight = window.innerHeight
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true })

    try {
      act(() => {
        root?.render(
          <ImagePasteInput
            text="/btw"
            onText={vi.fn()}
            attachments={[]}
            onAttachments={vi.fn()}
            onSubmit={vi.fn()}
            btwSessionId="s-resize"
            onSlashCommand={vi.fn()}
          />,
        )
      })

      act(() => container!.querySelector<HTMLButtonElement>('[role="option"]')!.click())
      const dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="BTW 旁路提问"]')!
      expect(dialog).not.toBeNull()

      vi.spyOn(dialog, 'getBoundingClientRect').mockImplementation(() => {
        const m = dialog.style.transform.match(/translate\((-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/)
        const tx = m ? Number(m[1]) : 0
        const ty = m ? Number(m[2]) : 0
        return {
          left: 400 + tx, top: 300 + ty, right: 800 + tx, bottom: 550 + ty, width: 400, height: 250, x: 400 + tx, y: 300 + ty, toJSON: () => ({}),
        }
      })

      // Drag to bottom-right in 1200x800 -> left: 792 (tx: 392), top: 542 (ty: 242)
      act(() => {
        dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 500, clientY: 320 }))
      })
      act(() => {
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 5000, clientY: 5000 }))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      })
      expect(dialog.getBoundingClientRect().left).toBe(792)
      expect(dialog.getBoundingClientRect().top).toBe(542)

      // Shrink viewport to 480x320 and fire window resize -> dialog clamps back inside viewport
      Object.defineProperty(window, 'innerWidth', { value: 480, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: 320, configurable: true })
      act(() => {
        window.dispatchEvent(new Event('resize'))
      })

      const clampedRect = dialog.getBoundingClientRect()
      expect(clampedRect.left).toBeLessThan(480)
      expect(clampedRect.right).toBeLessThanOrEqual(480 - 8)
      expect(clampedRect.top).toBeLessThan(320)
      expect(clampedRect.bottom).toBeLessThanOrEqual(320 - 8)
      expect(clampedRect.left).toBe(72)
      expect(clampedRect.top).toBe(62)
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origWidth, configurable: true })
      Object.defineProperty(window, 'innerHeight', { value: origHeight, configurable: true })
    }
  })

  it('guards BtwDialog Enter within 80ms after compositionend and submits once settled', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-28T00:00:00Z'))
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, content: 'answer' }) })
    vi.stubGlobal('fetch', fetchMock)

    try {
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() => {
        root?.render(
          <ImagePasteInput
            text="/btw"
            onText={vi.fn()}
            attachments={[]}
            onAttachments={vi.fn()}
            onSubmit={vi.fn()}
            btwSessionId="s-ime"
            onSlashCommand={vi.fn()}
          />,
        )
      })
      act(() => container!.querySelector<HTMLButtonElement>('[role="option"]')!.click())
      const dlg = container.querySelector<HTMLElement>('[role="dialog"][aria-label="BTW 旁路提问"]')!
      const ta = dlg.querySelector<HTMLTextAreaElement>('textarea')!
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(ta, '测试旁路')
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      })

      act(() => {
        ta.dispatchEvent(new Event('compositionstart', { bubbles: true }))
        ta.dispatchEvent(new Event('compositionend', { bubbles: true }))
        vi.advanceTimersByTime(30)
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(fetchMock).not.toHaveBeenCalled()

      act(() => {
        vi.advanceTimersByTime(60)
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})
