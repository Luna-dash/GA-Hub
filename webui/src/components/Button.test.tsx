// @vitest-environment jsdom
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Button } from './Button'

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
  vi.restoreAllMocks()
})

describe('Button', () => {
  it('defaults to type="button" and secondary md styling', async () => {
    await act(async () => {
      root.render(<Button>保存</Button>)
    })
    const btn = host.querySelector('button')!
    expect(btn.getAttribute('type')).toBe('button')
    expect(btn.className.split(/\s+/)).toContain('ga-btn')
    expect(btn.className.split(/\s+/)).not.toContain('ga-btn-sm')
  })

  it('maps variant and size tiers without merging conflicting classes', async () => {
    await act(async () => {
      root.render(<Button variant="primary" size="sm">确认</Button>)
    })
    let btn = host.querySelector('button')!
    expect(btn.className.split(/\s+/)).toContain('ga-btn-sm-primary')
    expect(btn.className.split(/\s+/)).not.toContain('ga-btn-sm')

    await act(async () => {
      root.render(<Button variant="danger-outline" size="xs">移除</Button>)
    })
    btn = host.querySelector('button')!
    expect(btn.className.split(/\s+/)).toContain('ga-btn-xs-danger')

    await act(async () => {
      root.render(<Button variant="link-muted" size="sm">取消</Button>)
    })
    btn = host.querySelector('button')!
    expect(btn.className.split(/\s+/)).toContain('ga-btn-link-muted')
  })

  it('disables interaction, sets aria-busy, and swaps loadingText when loading', async () => {
    const onClick = vi.fn()
    await act(async () => {
      root.render(
        <Button variant="primary" loading loadingText="处理中…" onClick={onClick}>
          保存
        </Button>,
      )
    })

    const btn = host.querySelector('button')!
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('aria-busy')).toBe('true')
    expect(btn.textContent).toBe('处理中…')
    expect(btn.textContent).not.toContain('保存')

    await act(async () => {
      btn.click()
    })
    expect(onClick).not.toHaveBeenCalled()
  })

  it('forwards ref and supports explicit type="submit"', async () => {
    const ref = createRef<HTMLButtonElement>()
    await act(async () => {
      root.render(<Button ref={ref} type="submit" variant="primary">提交</Button>)
    })
    expect(ref.current).toBeInstanceOf(HTMLButtonElement)
    expect(ref.current?.getAttribute('type')).toBe('submit')
  })
})
