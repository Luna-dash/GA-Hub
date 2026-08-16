import { describe, expect, it } from 'vitest'
import { defaultSessionLlmKey } from './llm'

describe('live-chat model selection', () => {
  it('uses the first configured model instead of runtime-wide current or preferred state', () => {
    const llms = [
      { key: 'first', current: false, preferred: false },
      { key: 'runtime-current', current: true, preferred: false },
      { key: 'legacy-preferred', current: false, preferred: true },
    ]

    expect(defaultSessionLlmKey(llms)).toBe('first')
  })

  it('has no implicit model when none is configured', () => {
    expect(defaultSessionLlmKey([])).toBeUndefined()
  })
})
