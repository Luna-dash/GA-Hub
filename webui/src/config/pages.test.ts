import { describe, expect, it, vi } from 'vitest'
import { APP_PAGES } from './pages'
import { NAV_ITEMS } from './navigation'
import { preloadRoute } from '@/routes/routeLoaders'

describe('app page manifest', () => {
  it('defines unique ids and routes aligned with sidebar navigation', () => {
    const ids = APP_PAGES.map((page) => page.id)
    const paths = APP_PAGES.map((page) => page.to)
    expect(new Set(ids).size).toBe(APP_PAGES.length)
    expect(new Set(paths).size).toBe(APP_PAGES.length)
    for (const page of APP_PAGES) {
      expect(page.to).toBe(`/${page.id}`)
      expect(page.label.trim()).not.toBe('')
      expect(page.palette.label.trim()).not.toBe('')
    }

    expect(NAV_ITEMS.map((item) => item.id)).toEqual(
      APP_PAGES.filter((page) => page.inNav).map((page) => page.id),
    )
    expect(APP_PAGES.find((page) => page.id === 'settings')?.inNav).toBe(false)
  })

  it('preloads every declared page route including theme-tasks, anti, and conversation deep links', () => {
    const spies = APP_PAGES.map((page) => ({
      page,
      spy: vi.spyOn(page, 'loader').mockResolvedValue({ default: () => null }),
    }))

    try {
      for (const { page, spy } of spies) {
        preloadRoute(page.to)
        expect(spy).toHaveBeenCalledTimes(1)
      }

      const themeTasks = spies.find(({ page }) => page.id === 'theme-tasks')!
      preloadRoute('/theme-tasks?open=session-1')
      expect(themeTasks.spy).toHaveBeenCalledTimes(2)

      const conversations = spies.find(({ page }) => page.id === 'conversations')!
      preloadRoute('/conversations/session-1')
      expect(conversations.spy).toHaveBeenCalledTimes(2)

      expect(() => preloadRoute('/unknown-route')).not.toThrow()
    } finally {
      for (const { spy } of spies) spy.mockRestore()
    }
  })
})
