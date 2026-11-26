// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SidebarNav } from './SidebarNav'
import { defaultNavPreferences } from '@/config/navigation'
import { setNavPreferences } from '@/stores/navPreferenceStore'
import { recordThemeCompletion, readThemeCompletion } from '@/stores/themeCompletionStore'
import { markSessionActive, markSessionRead, recordSessionTerminal } from '@/stores/sessionUnreadStore'
import type { ThemeRun } from '@/api/types'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('SidebarNav', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    localStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const renderNav = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/chat']}>
          <SidebarNav />
        </MemoryRouter>,
      )
    })
  }

  it('hides Anti by default and keeps it as a navigation link without a daemon control when enabled', async () => {
    await renderNav()
    expect(host.querySelector('nav a[href="/anti"]')).toBeNull()
    act(() => {
      setNavPreferences(defaultNavPreferences().map((item) => item.id === 'anti' ? { ...item, visible: true } : item))
    })
    expect(host.querySelector('nav a[href="/anti"]')).not.toBeNull()
    expect(host.querySelector('button[aria-label="启动 Anti"]')).toBeNull()
  })

  it('shows the completion dot on the theme icon in both layouts and clears only after reading', async () => {
    await renderNav()
    const run: ThemeRun = { session_id: 's1', run_id: 'r1', started_at: 1, finished_at: 2, turns: 1, model_key: null, model_name: null, outcome: 'completed', report: 'done' }
    const dot = () => host.querySelector('[aria-label="主题任务有未读完成结果"]')
    expect(dot()).toBeNull()
    act(() => recordThemeCompletion('s1', run))
    expect(dot()?.closest('a')?.getAttribute('href')).toBe('/theme-tasks')
    act(() => (host.querySelector('[aria-label="折叠/展开导航栏"]') as HTMLButtonElement).click())
    expect(dot()).not.toBeNull()
    act(() => readThemeCompletion('s1', run))
    expect(dot()).toBeNull()
    act(() => recordThemeCompletion('s1', run))
    expect(dot()).toBeNull()
  })

  it('shows unread red dots for chat and anti in both expanded and collapsed sidebar modes', async () => {
    setNavPreferences(defaultNavPreferences().map((item) => item.id === 'anti' ? { ...item, visible: true } : item))
    await renderNav()
    const chatDot = () => host.querySelector('[aria-label="实时聊天有未读消息"]')
    const antiDot = () => host.querySelector('[aria-label="Agy 有未读消息"]')
    expect(chatDot()).toBeNull()
    expect(antiDot()).toBeNull()

    // Cancelled runs must never raise a red dot.
    act(() => {
      recordSessionTerminal('chat', 'c-cancel', 'rc', 'cancelled')
      recordSessionTerminal('anti', 'a-cancel', 'ra', 'cancelled')
    })
    expect(chatDot()).toBeNull()
    expect(antiDot()).toBeNull()

    act(() => {
      recordSessionTerminal('chat', 'c1', 'r1', 'completed')
      recordSessionTerminal('anti', 'a1', 'r2', 'failed')
    })
    expect(chatDot()?.closest('a')?.getAttribute('href')).toBe('/chat')
    expect(antiDot()?.closest('a')?.getAttribute('href')).toBe('/anti')

    // Red dots stay visible when the sidebar is collapsed.
    act(() => (host.querySelector('[aria-label="折叠/展开导航栏"]') as HTMLButtonElement).click())
    expect(chatDot()).not.toBeNull()
    expect(antiDot()).not.toBeNull()

    act(() => markSessionRead('chat', 'c1', 'r1'))
    expect(chatDot()).toBeNull()
    expect(antiDot()).not.toBeNull()

    act(() => markSessionActive('anti', 'a1'))
    expect(antiDot()).toBeNull()
  })

  it('collapses to icon rail with logo and expand toggle, then expands back', async () => {
    await renderNav()
    const aside = host.querySelector('aside') as HTMLElement
    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(host.textContent).toContain('实时聊天')
    expect(host.querySelector('.ga-brand-mark')?.getAttribute('aria-label')).toBe('GAHUB')
    expect(host.querySelector('.ga-brand-hub')?.textContent).toBe('GAHUB')
    const toggle = host.querySelector<HTMLButtonElement>('[aria-label="折叠/展开导航栏"]')!
    const settings = () => host.querySelector('a[href="/settings"]')
    const expectFooterSettings = () => {
      expect(host.querySelectorAll('a[href="/settings"]')).toHaveLength(1)
      expect(toggle.previousElementSibling).toBe(settings())
      expect(host.querySelector('.ga-brand-mark a')).toBeNull()
      expect(host.querySelector('kbd')).toBeNull()
      expect(host.textContent).not.toContain('命令面板')
    }
    expectFooterSettings()
    const settingsLink = settings()

    act(() => toggle.click())

    expect(aside.getAttribute('data-collapsed')).toBe('true')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('1')
    expect(host.textContent).not.toContain('实时聊天')
    expect(host.querySelector('.ga-brand-hub')).toBeNull()
    expect(host.textContent).not.toContain('GAHUB')
    expect(host.textContent).not.toContain('HUB')
    expectFooterSettings()
    expect(settings()).toBe(settingsLink)
    const navLinks = aside.querySelectorAll('nav a')
    expect(navLinks.length).toBeGreaterThan(3)
    for (const link of navLinks) {
      expect(link.getAttribute('title')).toBeTruthy()
    }
    expect(host.querySelector('[aria-label="展开导航栏"]')).not.toBeNull()

    act(() => toggle.click())

    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('0')
    expect(host.textContent).toContain('实时聊天')
    expect(host.querySelector('.ga-brand-hub')?.textContent).toBe('GAHUB')
    expectFooterSettings()
    expect(settings()).toBe(settingsLink)
  })

  it('starts collapsed from persisted preference and keeps the settings route active after expanding', async () => {
    localStorage.setItem('gahub.sidebar.collapsed', '1')
    await renderNav()
    const aside = host.querySelector('aside') as HTMLElement
    expect(aside.getAttribute('data-collapsed')).toBe('true')
    const settings = host.querySelector<HTMLAnchorElement>('a[aria-label="系统设置"]')!
    expect(settings.getAttribute('aria-current')).toBeNull()
    act(() => settings.click())
    expect(settings.getAttribute('aria-current')).toBe('page')

    act(() => {
      ;(host.querySelector('[aria-label="折叠/展开导航栏"]') as HTMLButtonElement).click()
    })

    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(host.textContent).toContain('实时聊天')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('0')
    expect(settings.isConnected).toBe(true)
    expect(settings.getAttribute('aria-current')).toBe('page')
  })

  it('toggles collapse from the GA logo button', async () => {
    await renderNav()
    const aside = host.querySelector('aside') as HTMLElement
    const logo = host.querySelector('.ga-brand-toggle') as HTMLButtonElement
    expect(logo).not.toBeNull()
    expect(logo.getAttribute('aria-label')).toBe('折叠导航栏')
    const artwork = logo.querySelector('img') as HTMLImageElement
    expect(artwork.getAttribute('src')).toContain('gahub-icon.png')
    expect(artwork.getAttribute('alt')).toBe('')
    expect(artwork.draggable).toBe(false)
    expect(logo.querySelector('.ga-brand-ga')).toBeNull()
    expect(logo.querySelector('.ga-brand-hub')?.textContent).toBe('GAHUB')

    act(() => logo.click())
    expect(aside.getAttribute('data-collapsed')).toBe('true')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('1')
    expect(logo.getAttribute('aria-label')).toBe('展开导航栏')
    expect(logo.querySelector('.ga-brand-hub')).toBeNull()

    act(() => logo.click())
    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('0')
    expect(logo.querySelector('.ga-brand-hub')?.textContent).toBe('GAHUB')
  })
})
