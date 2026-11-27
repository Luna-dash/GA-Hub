// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  confirmLeaveIfDirty,
  hasDirtyGuard,
  registerNavigationGuard,
  resetNavigationGuardsForTests,
  unregisterNavigationGuard,
  useDirtyRouteGuard,
} from './navigationGuardStore'
import { dialog } from './dialogStore'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function GuardHarness({ id, dirty, message }: { id: string; dirty: boolean; message: string }) {
  useDirtyRouteGuard(id, dirty, message)
  return null
}

describe('navigationGuardStore', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    resetNavigationGuardsForTests()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    resetNavigationGuardsForTests()
    vi.restoreAllMocks()
  })

  it('tracks dirty guards, attaches beforeunload only while dirty, and fast-paths when clean', async () => {
    expect(hasDirtyGuard()).toBe(false)
    const confirmSpy = vi.spyOn(dialog, 'confirm')
    await expect(confirmLeaveIfDirty()).resolves.toBe(true)
    expect(confirmSpy).not.toHaveBeenCalled()

    const cleanUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(cleanUnload)
    expect(cleanUnload.defaultPrevented).toBe(false)

    registerNavigationGuard('editor-a', '文档 A 未保存')
    expect(hasDirtyGuard()).toBe(true)

    const dirtyUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(dirtyUnload)
    expect(dirtyUnload.defaultPrevented).toBe(true)

    unregisterNavigationGuard('editor-a')
    expect(hasDirtyGuard()).toBe(false)

    const afterUnload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterUnload)
    expect(afterUnload.defaultPrevented).toBe(false)
  })

  it('deduplicates concurrent confirmLeaveIfDirty prompts and respects cancel vs confirm', async () => {
    let resolveConfirm!: (ok: boolean) => void
    const confirmSpy = vi.spyOn(dialog, 'confirm').mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveConfirm = resolve }),
    )
    registerNavigationGuard('memory-editor', '当前记忆文档有未保存的编辑')

    const p1 = confirmLeaveIfDirty()
    const p2 = confirmLeaveIfDirty()
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).toHaveBeenCalledWith(
      '放弃未保存的修改？',
      '当前记忆文档有未保存的编辑',
      expect.objectContaining({ confirmText: '放弃修改', tone: 'danger' }),
    )

    resolveConfirm(false)
    await expect(p1).resolves.toBe(false)
    await expect(p2).resolves.toBe(false)

    vi.mocked(dialog.confirm).mockResolvedValueOnce(true)
    await expect(confirmLeaveIfDirty()).resolves.toBe(true)
  })

  it('useDirtyRouteGuard registers while dirty and cleans up when clean or unmounted', async () => {
    act(() => root.render(createElement(GuardHarness, { id: 'proxy', dirty: false, message: 'proxy dirty' })))
    expect(hasDirtyGuard()).toBe(false)

    act(() => root.render(createElement(GuardHarness, { id: 'proxy', dirty: true, message: 'proxy dirty' })))
    expect(hasDirtyGuard()).toBe(true)

    act(() => root.render(createElement(GuardHarness, { id: 'proxy', dirty: false, message: 'proxy dirty' })))
    expect(hasDirtyGuard()).toBe(false)

    act(() => root.render(createElement(GuardHarness, { id: 'proxy', dirty: true, message: 'proxy dirty' })))
    expect(hasDirtyGuard()).toBe(true)

    await act(async () => root.unmount())
    expect(hasDirtyGuard()).toBe(false)
  })
})
