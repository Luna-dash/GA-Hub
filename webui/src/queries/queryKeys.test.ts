import { describe, expect, it } from 'vitest'
import { queryKeys } from './queryKeys'

describe('queryKeys', () => {
  it('shares token statistics identity across dashboard and detail views', () => {
    expect(queryKeys.tokenStats).toEqual(['token-stats'])
  })

  it('keeps parameterized resources isolated while sharing their namespace', () => {
    expect(queryKeys.autonomous.report('a')).toEqual(['auto.report', 'a'])
    expect(queryKeys.autonomous.report('a')).not.toEqual(queryKeys.autonomous.report('b'))
    expect(queryKeys.skills.detail('one')).not.toEqual(queryKeys.skills.detail('two'))
    expect(queryKeys.skills.list()).not.toEqual(queryKeys.skills.list(500))
  })
})
