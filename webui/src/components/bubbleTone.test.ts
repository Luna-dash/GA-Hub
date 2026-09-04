import { describe, expect, it } from 'vitest'
import { bubbleTone } from './bubbleTone'

// Table-driven contract: every role × variant combination maps to a stable
// surface class, unknown/absent roles fall back deterministically, and no
// caller can crash on an undefined role.
const KNOWN_EXPECTATIONS: Array<[string, 'chat' | 'card', RegExp]> = [
  ['user', 'chat', /bg-accent/],
  ['user', 'card', /border-accent\/40/],
  ['assistant', 'chat', /bg-bg-card/],
  ['assistant', 'card', /bg-bg-card/],
  ['system', 'chat', /#E8D8B8/],
  ['system', 'card', /status-warning-soft/],
]

describe('bubbleTone role/variant table', () => {
  it.each(KNOWN_EXPECTATIONS)(
    'maps %s on the %s variant to its themed surface',
    (role, variant, expected) => {
      expect(bubbleTone(role, variant).surfaceClass).toMatch(expected)
    },
  )

  it.each([
    ['unknown-role', 'chat'],
    ['unknown-role', 'card'],
    [undefined, 'chat'],
    [null, 'card'],
    ['', 'chat'],
  ] as Array<[string | undefined | null, 'chat' | 'card']>)(
    'falls back to a non-empty surface for %j on %s',
    (role, variant) => {
      const tone = bubbleTone(role, variant)
      expect(tone.surfaceClass).toBeTruthy()
      // Fallbacks never leak another role's themed surface.
      expect(tone.surfaceClass).not.toMatch(/bg-accent/)
    },
  )

  it('keeps chat and card variants visually distinct for the same role', () => {
    expect(bubbleTone('user', 'chat').surfaceClass)
      .not.toBe(bubbleTone('user', 'card').surfaceClass)
  })
})
