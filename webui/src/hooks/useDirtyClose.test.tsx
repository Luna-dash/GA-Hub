// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDirtyClose } from './useDirtyClose'

const dialogConfirmMock = vi.hoisted(() => vi.fn())

vi.mock('@/stores/dialogStore', () => ({
  dialog: {
    confirm: dialogConfirmMock,
  },
}))

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useDirtyClose', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    dialogConfirmMock.mockReset()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  function mount(props: { dirty: boolean; busy?: boolean; onClose: () => void }) {
    let latest!: ReturnType<typeof useDirtyClose>
    function Harness() {
      latest = useDirtyClose(props)
      return (
        <button type="button" data-confirming={latest.confirming ? 'true' : 'false'} onClick={latest.requestClose}>
          Close
        </button>
      )
    }
    act(() => root.render(<Harness />))
    return () => latest
  }

  it('closes synchronously without confirming when clean', () => {
    const onClose = vi.fn()
    mount({ dirty: false, onClose })
    act(() => {
      host.querySelector('button')!.click()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(dialogConfirmMock).not.toHaveBeenCalled()
  })

  it('blocks closing when busy even if clean or dirty', () => {
    const onClose = vi.fn()
    mount({ dirty: true, busy: true, onClose })
    act(() => {
      host.querySelector('button')!.click()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(dialogConfirmMock).not.toHaveBeenCalled()
  })

  it('prompts on dirty close, cancels when rejected, closes when confirmed, and prevents re-entry', async () => {
    let resolveConfirm!: (value: boolean) => void
    dialogConfirmMock.mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveConfirm = resolve
    }))
    const onClose = vi.fn()
    mount({ dirty: true, onClose })

    const btn = host.querySelector('button')!
    act(() => {
      btn.click()
      btn.click()
    })
    expect(dialogConfirmMock).toHaveBeenCalledTimes(1)
    expect(dialogConfirmMock).toHaveBeenCalledWith(
      '放弃未保存的修改？',
      expect.any(String),
      expect.objectContaining({
        confirmText: '放弃修改',
        cancelText: '继续编辑',
        tone: 'danger',
      }),
    )
    expect(btn.getAttribute('data-confirming')).toBe('true')

    await act(async () => {
      resolveConfirm(false)
      await Promise.resolve()
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(btn.getAttribute('data-confirming')).toBe('false')

    dialogConfirmMock.mockResolvedValueOnce(true)
    await act(async () => {
      btn.click()
      await Promise.resolve()
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
