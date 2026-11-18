import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, normalizeNavPreferences } from './navigation'

describe('sidebar navigation', () => {
  it('keeps Anti chat and theme tasks next to chat with distinct icons', () => {
    const chat = NAV_ITEMS.findIndex(item => item.id === 'chat')
    expect(NAV_ITEMS.slice(chat + 1, chat + 3)).toMatchObject([
      { id: 'anti', icon: 'anti' },
      { id: 'theme-tasks', icon: 'themeTasks' },
    ])
  })
  it('places missing Anti chat and theme tasks below chat without resetting other pages', () => {
    const saved = [{ id: 'memory', visible: true }, { id: 'chat', visible: true }, { id: 'dashboard', visible: false }]
    const result = normalizeNavPreferences(saved)
    expect(result.slice(0, 5)).toEqual([saved[0], saved[1], { id: 'anti', visible: true }, { id: 'theme-tasks', visible: true }, saved[2]])
    expect(new Set(result.map(item => item.id)).size).toBe(NAV_ITEMS.length)
  })
  it('preserves the saved order and visibility of Anti chat and theme tasks', () => {
    const saved = [{ id: 'theme-tasks', visible: false }, { id: 'memory', visible: true }, { id: 'chat', visible: true }, { id: 'anti', visible: false }]
    const result = normalizeNavPreferences(saved)
    expect(result.slice(0, 4)).toEqual(saved)
    expect(normalizeNavPreferences(result)).toEqual(result)
  })
  it('keeps the default order when normalizing empty preferences', () => {
    expect(normalizeNavPreferences([]).map(item => item.id)).toEqual(NAV_ITEMS.map(item => item.id))
  })
  it('inserts a missing theme tasks entry after Anti chat in the default order', () => {
    const saved = NAV_ITEMS.filter(item => item.id !== 'theme-tasks').map(({ id }) => ({ id, visible: true }))
    expect(normalizeNavPreferences(saved).map(item => item.id)).toEqual(NAV_ITEMS.map(item => item.id))
  })

})
