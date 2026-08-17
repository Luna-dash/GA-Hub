import { describe, expect, it } from 'vitest'
import {
  defaultSessionLlmKey,
  llmIndexForKey,
  resolveMainLlmKey,
  resolveSessionLlmKey,
  resolveSubagentLlmKey,
} from './llm'

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

  it('keeps an existing durable model binding', () => {
    expect(resolveSessionLlmKey([{ key: 'first' }, { key: 'bound' }], 'bound')).toBe('bound')
  })

  it.each([null, undefined, 'deleted'])('repairs %s bindings to the first configured model', (binding) => {
    expect(resolveSessionLlmKey([{ key: 'first' }, { key: 'second' }], binding)).toBe('first')
  })
})

describe('shared model identity', () => {
  const llms = [
    { key: 'alpha', index: 3 },
    { key: 'beta', index: 1 },
  ]

  it('uses the same first-model fallback for every main-model selector', () => {
    expect(resolveMainLlmKey(llms, null)).toBe('alpha')
    expect(resolveMainLlmKey(llms, 'deleted')).toBe('alpha')
  })

  it('falls back to following the main model when a subagent model is missing', () => {
    expect(resolveSubagentLlmKey(llms, 'beta')).toBe('beta')
    expect(resolveSubagentLlmKey(llms, 'deleted')).toBeNull()
    expect(resolveSubagentLlmKey(llms, null)).toBeNull()
  })

  it('converts a durable key with the latest backend index', () => {
    expect(llmIndexForKey(llms, 'alpha')).toBe(3)
    expect(llmIndexForKey(llms, 'beta')).toBe(1)
    expect(llmIndexForKey(llms, 'deleted')).toBeNull()
  })

  it('falls back to array position when an index is not supplied', () => {
    expect(llmIndexForKey([{ key: 'beta' }, { key: 'alpha' }], 'alpha')).toBe(1)
  })
})
