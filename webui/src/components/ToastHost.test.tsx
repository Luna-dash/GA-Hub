// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToastHost } from './ToastHost'
import { toast, useToastStore } from '@/stores/toastStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ToastHost', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    for (const item of useToastStore.getState().items) {
      useToastStore.getState().dismiss(item.id)
    }
    vi.useRealTimers()
  })

  it('uses role="alert" for errors and role="status" for success/info', async () => {
    await act(async () => root.render(<ToastHost />))

    act(() => {
      toast.success('已保存')
      toast.error('保存失败')
    })

    const status = host.querySelector('[role="status"]')
    const alert = host.querySelector('[role="alert"]')
    expect(status?.textContent).toContain('已保存')
    expect(alert?.textContent).toContain('保存失败')
  })

  it('allows selecting text without click-anywhere dismiss and closes only via explicit close button', async () => {
    await act(async () => root.render(<ToastHost />))

    act(() => {
      toast.error('可复制的错误详情')
    })

    const alert = host.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.className).toContain('select-text')
    expect(alert.className).not.toContain('cursor-pointer')

    // Clicking the message body should NOT dismiss the toast
    const msgSpan = alert.querySelector('span')!
    act(() => {
      msgSpan.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(host.querySelector('[role="alert"]')).not.toBeNull()

    const closeBtn = alert.querySelector<HTMLButtonElement>('button[aria-label="关闭提示"]')!
    expect(closeBtn).not.toBeNull()
    expect(closeBtn.type).toBe('button')

    act(() => {
      closeBtn.click()
    })
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('pauses auto-dismiss on hover/focus and resumes on leave/blur', async () => {
    await act(async () => root.render(<ToastHost />))

    act(() => {
      toast.info('可悬停提示', 2000)
    })

    const toastEl = host.querySelector<HTMLElement>('[role="status"]')!
    act(() => {
      vi.advanceTimersByTime(1000)
      toastEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })

    // While hovered, timer should stay paused indefinitely
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    // Mouse leave resumes remaining ~1000ms
    act(() => {
      toastEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      vi.advanceTimersByTime(500)
    })
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    // Focus pauses again, blur resumes
    act(() => {
      toastEl.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      vi.advanceTimersByTime(3000)
    })
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    act(() => {
      toastEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      vi.advanceTimersByTime(600)
    })
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps toast paused while focused even after mouse leaves, and resumes only after blur', async () => {
    await act(async () => root.render(<ToastHost />))

    act(() => {
      toast.info('聚焦加悬停保持暂停', 2000)
    })

    const toastEl = host.querySelector<HTMLElement>('[role="status"]')!
    act(() => {
      vi.advanceTimersByTime(1000)
      toastEl.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      toastEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      toastEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      vi.advanceTimersByTime(5000)
    })
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    act(() => {
      toastEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      vi.advanceTimersByTime(1100)
    })
    expect(host.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps toast paused while hovered even after focus leaves, and resumes only after mouseout', async () => {
    await act(async () => root.render(<ToastHost />))

    act(() => {
      toast.info('悬停加聚焦保持暂停', 2000)
    })

    const toastEl = host.querySelector<HTMLElement>('[role="status"]')!
    act(() => {
      vi.advanceTimersByTime(1000)
      toastEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      toastEl.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      toastEl.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }))
      vi.advanceTimersByTime(5000)
    })
    expect(host.querySelector('[role="status"]')).not.toBeNull()

    act(() => {
      toastEl.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
      vi.advanceTimersByTime(1100)
    })
    expect(host.querySelector('[role="status"]')).toBeNull()
  })
})
