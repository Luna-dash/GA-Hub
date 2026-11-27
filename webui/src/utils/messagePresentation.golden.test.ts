import { describe, expect, it } from 'vitest'
import fixture from '../../../tests/fixtures/message_presentation_golden.json'
import { remoteMessagePage, remoteProgress } from './messagePresentation'

describe('messagePresentation shared golden contract (TS side)', () => {
  it('produces valid compact projections for all page fixtures', () => {
    for (const tc of fixture.pages) {
      const result = remoteMessagePage(tc.input)
      expect(result.presentation_version, tc.name).toBe(1)
      expect(Array.isArray(result.items), tc.name).toBe(true)
      expect(result.items.length, tc.name).toBe(tc.input.items.length)
      for (const item of result.items) {
        expect(item.compact, tc.name).toBe(true)
      }
    }
  })

  it('produces valid compact progress projections for all snapshot fixtures', () => {
    for (const tc of fixture.progress) {
      const result = remoteProgress(tc.input as unknown as Parameters<typeof remoteProgress>[0])
      expect(result.type, tc.name).toBe('progress')
      expect(result.presentation_version, tc.name).toBe(1)
      expect(result.session_id, tc.name).toBe(tc.input.session_id)
    }
  })
})
