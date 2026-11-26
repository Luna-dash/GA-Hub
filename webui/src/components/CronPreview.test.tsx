// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronPreview } from './CronPreview'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('CronPreview', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    act(() => root.unmount())
    host.remove()
  })

  it('renders localized zh_CN description and next three trigger times without full i18n bundle', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN')
    act(() => root.render(<CronPreview expr="0 9 * * 1-5" />))

    const text = host.textContent ?? ''
    expect(text).toContain('09:00')
    expect(text).toContain('星期一至星期五')
    expect(text).toContain('下次触发：')
    expect(host.querySelector('.text-status-danger')).toBeNull()
  })

  it('falls back cleanly to English descriptions and reports invalid cron syntax', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    act(() => root.render(<CronPreview expr="*/15 * * * *" />))
    expect(host.textContent).toContain('Every 15 minutes')

    act(() => root.render(<CronPreview expr="invalid-cron" />))
    expect(host.querySelector('.text-status-danger')).not.toBeNull()
    expect(host.textContent).toContain('✗')
  })
})
