import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, normalizeNavPreferences } from './navigation'

describe('theme tasks navigation', () => {
  it('keeps Anti chat and theme tasks next to chat with distinct icons', () => {
    const chat = NAV_ITEMS.findIndex(item => item.id === 'chat')
    expect(NAV_ITEMS.slice(chat + 1, chat + 3)).toMatchObject([
      { id: 'anti', icon: 'anti' },
      { id: 'theme-tasks', icon: 'themeTasks' },
    ])
  })
  it('places the new page below chat in old saved layouts without resetting other pages', () => {
    const saved = [{ id: 'memory', visible: true }, { id: 'chat', visible: true }, { id: 'dashboard', visible: false }]
    const result = normalizeNavPreferences(saved)
    expect(result.slice(0, 4)).toEqual([saved[0], saved[1], { id: 'theme-tasks', visible: true }, saved[2]])
    expect(new Set(result.map(item => item.id)).size).toBe(NAV_ITEMS.length)
  })
  it('preserves explicitly saved theme position and visibility', () => {
    const saved = [{ id: 'theme-tasks', visible: false }, { id: 'memory', visible: true }, { id: 'chat', visible: true }]
    const result = normalizeNavPreferences(saved)
    expect(result.slice(0, 3)).toEqual(saved)
    expect(normalizeNavPreferences(result)).toEqual(result)
  })

})
