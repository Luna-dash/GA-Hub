// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SidebarNav } from './SidebarNav'

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

  it('collapses to icon rail with logo and expand toggle, then expands back', async () => {
    await renderNav()
    const aside = host.querySelector('aside') as HTMLElement
    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(host.textContent).toContain('实时聊天')
    expect(host.querySelector('[aria-label="系统设置"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="折叠导航栏"]')).not.toBeNull()

    act(() => {
      ;(host.querySelector('[aria-label="折叠导航栏"]') as HTMLButtonElement).click()
    })

    expect(aside.getAttribute('data-collapsed')).toBe('true')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('1')
    expect(host.textContent).not.toContain('实时聊天')
    expect(host.textContent).not.toContain('HUB')
    expect(host.querySelector('.ga-brand-mark [aria-label="系统设置"]')).toBeNull()
    expect(host.querySelectorAll('[aria-label="系统设置"]').length).toBe(1)
    const navLinks = aside.querySelectorAll('nav a')
    expect(navLinks.length).toBeGreaterThan(3)
    for (const link of navLinks) {
      expect(link.getAttribute('title')).toBeTruthy()
    }
    expect(host.querySelector('[aria-label="展开导航栏"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="命令面板 (Ctrl K)"]')).not.toBeNull()
    expect(host.textContent).not.toContain('命令面板')

    act(() => {
      ;(host.querySelector('[aria-label="展开导航栏"]') as HTMLButtonElement).click()
    })

    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('0')
    expect(host.textContent).toContain('实时聊天')
    expect(host.querySelector('[aria-label="系统设置"]')).not.toBeNull()
  })

  it('starts collapsed from persisted preference and expands on toggle', async () => {
    localStorage.setItem('gahub.sidebar.collapsed', '1')
    await renderNav()
    const aside = host.querySelector('aside') as HTMLElement
    expect(aside.getAttribute('data-collapsed')).toBe('true')
    expect(host.textContent).not.toContain('命令面板')
    expect(host.querySelector('[aria-label="命令面板 (Ctrl K)"]')).not.toBeNull()
    expect(host.querySelector('.ga-brand-mark [aria-label="系统设置"]')).toBeNull()
    expect(host.querySelectorAll('[aria-label="系统设置"]').length).toBe(1)

    act(() => {
      ;(host.querySelector('[aria-label="展开导航栏"]') as HTMLButtonElement).click()
    })

    expect(aside.getAttribute('data-collapsed')).toBe('false')
    expect(host.textContent).toContain('实时聊天')
    expect(localStorage.getItem('gahub.sidebar.collapsed')).toBe('0')
  })
})
