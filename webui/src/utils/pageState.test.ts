import { beforeEach, describe, expect, it } from 'vitest'
import { readPageState, resetPageState, writePageState } from './pageState'

beforeEach(() => resetPageState())

describe('pageState persistence', () => {
  it('returns the initial value when nothing was stored', () => {
    expect(readPageState('t.initial', 7)).toBe(7)
  })

  it('round-trips a value through sessionStorage', () => {
    writePageState('t.roundtrip', { page: 3 })
    expect(readPageState('t.roundtrip', { page: 0 })).toEqual({ page: 3 })
  })

  it('serves later writes from the in-memory layer', () => {
    writePageState('t.latest', 1)
    writePageState('t.latest', 2)
    expect(readPageState('t.latest', 0)).toBe(2)
  })

  it('falls back to the initial value when the stored payload is corrupted', () => {
    window.sessionStorage.setItem('gahub.pageState.v1:t.corrupt', '{oops')
    expect(readPageState('t.corrupt', 'fallback')).toBe('fallback')
  })

  it('reset clears both the memory layer and sessionStorage', () => {
    writePageState('t.reset', 'v')
    expect(window.sessionStorage.getItem('gahub.pageState.v1:t.reset')).toBe(
      JSON.stringify('v'),
    )
    resetPageState()
    expect(readPageState('t.reset', 'initial')).toBe('initial')
    expect(
      window.sessionStorage.getItem('gahub.pageState.v1:t.reset'),
    ).toBeNull()
  })
})
