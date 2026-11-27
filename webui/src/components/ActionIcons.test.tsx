// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CloseIconButton } from './ActionIcons'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('CloseIconButton', () => {
  it('omits rounded-full on compact variant when caller supplies a rounded-* class', async () => {
    await act(async () => {
      root.render(<CloseIconButton label="关闭提示" variant="compact" className="rounded-md" />)
    })
    const btn = host.querySelector('button')!
    const classes = btn.className.split(/\s+/)
    expect(classes).toContain('rounded-md')
    expect(classes).not.toContain('rounded-full')
    expect(btn.getAttribute('type')).toBe('button')
  })

  it('defaults compact variant to rounded-full when no rounded-* class is supplied', async () => {
    await act(async () => {
      root.render(<CloseIconButton label="关闭" variant="compact" className="text-ink-muted" />)
    })
    const classes = host.querySelector('button')!.className.split(/\s+/)
    expect(classes).toContain('rounded-full')
  })
})
