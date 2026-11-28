import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AntiQuotaProgressList, quotaBarTone, quotaTone } from './AntiQuotaProgressList'

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('AntiQuotaProgressList', () => {
  it('uses balanced blue and clear warning/danger tones across remaining percentage thresholds', () => {
    expect(quotaTone(80)).toContain('text-quota-blue-text')
    expect(quotaTone(30)).toContain('text-status-warning-hot')
    expect(quotaTone(10)).toContain('text-status-danger')

    expect(quotaBarTone(80)).toContain('from-quota-blue/')
    expect(quotaBarTone(30)).toContain('from-status-warning-hot/')
    expect(quotaBarTone(10)).toContain('from-status-danger/')
  })

  it('renders slender borderless progress tracks and soft capsule badges', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          <AntiQuotaProgressList
            ariaPrefix="主账号"
            rows={[
              { model: 'gemini-3-pro (shared)', limit: '5h', remaining_pct: 120, resets_at: null },
              { model: 'claude-4-sonnet', limit: '7d', remaining_pct: 32.5, resets_at: '2026-11-28T10:30:00Z' },
              { model: 'gpt-5', limit: '5h', remaining_pct: -4, resets_at: null },
            ]}
          />,
        )
      })

      const bars = [...host.querySelectorAll<HTMLElement>('[role="progressbar"]')]
      expect(bars).toHaveLength(3)
      expect(bars[0].getAttribute('aria-valuenow')).toBe('100')
      expect(bars[0].className).toContain('h-1')
      expect(bars[0].className).not.toContain('ring-1')
      expect(bars[1].getAttribute('aria-valuenow')).toBe('32.5')
      expect(bars[2].getAttribute('aria-valuenow')).toBe('0')

      const items = [...host.querySelectorAll('[data-anti-quota-bars] > li')]
      expect(items[0].querySelector('span')?.textContent).toBe('gemini-3-pro')
      expect(items[0].textContent).toContain('满额未消耗')
      expect(items[1].querySelector('time')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
    }
  })
})
