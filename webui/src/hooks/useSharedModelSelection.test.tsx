// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAIN_LLM_PREFERENCE_KEY,
  SUBAGENT_LLM_PREFERENCE_KEY,
  useSharedModelSelection,
} from './useSharedModelSelection'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const llms = [
  { key: 'alpha', index: 0 },
  { key: 'beta', index: 1 },
]

function Probe({ options = llms }: { options?: typeof llms }) {
  const selection = useSharedModelSelection(options)
  return (
    <div
      data-main-key={selection.mainLlmKey ?? ''}
      data-subagent-key={selection.subagentLlmKey ?? ''}
      data-main-index={selection.mainLlmIndex ?? ''}
      data-subagent-index={selection.subagentLlmIndex ?? ''}
      data-selected-subagent-index={selection.selectedSubagentLlmIndex ?? ''}
    >
      <button type="button" data-action="main-beta" onClick={() => selection.selectMainLlm('beta')} />
      <button type="button" data-action="subagent-alpha" onClick={() => selection.selectSubagentLlm('alpha')} />
      <button type="button" data-action="subagent-follow" onClick={() => selection.selectSubagentLlm(null)} />
    </div>
  )
}

describe('shared non-session model selection', () => {
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

  it('defaults the main model to the first item and makes subagents follow it', () => {
    act(() => root.render(<Probe />))

    const probe = host.firstElementChild as HTMLElement
    expect(probe.dataset.mainKey).toBe('alpha')
    expect(probe.dataset.subagentKey).toBe('')
    expect(probe.dataset.mainIndex).toBe('0')
    expect(probe.dataset.subagentIndex).toBe('0')
    expect(probe.dataset.selectedSubagentIndex).toBe('')
    expect(localStorage.getItem(MAIN_LLM_PREFERENCE_KEY)).toBe('alpha')
    expect(localStorage.getItem(SUBAGENT_LLM_PREFERENCE_KEY)).toBeNull()
  })

  it('shares separate main and subagent preferences across page remounts', () => {
    act(() => root.render(<Probe key="conductor" />))
    act(() => (host.querySelector('[data-action="main-beta"]') as HTMLButtonElement).click())
    act(() => (host.querySelector('[data-action="subagent-alpha"]') as HTMLButtonElement).click())

    act(() => root.render(<Probe key="goal-hive" />))

    const probe = host.firstElementChild as HTMLElement
    expect(probe.dataset.mainKey).toBe('beta')
    expect(probe.dataset.subagentKey).toBe('alpha')
    expect(probe.dataset.mainIndex).toBe('1')
    expect(probe.dataset.subagentIndex).toBe('0')
    expect(probe.dataset.selectedSubagentIndex).toBe('0')
  })

  it('uses current indices after models are reordered', () => {
    localStorage.setItem(MAIN_LLM_PREFERENCE_KEY, 'beta')
    localStorage.setItem(SUBAGENT_LLM_PREFERENCE_KEY, 'alpha')

    act(() => root.render(<Probe options={[
      { key: 'beta', index: 5 },
      { key: 'alpha', index: 2 },
    ]} />))

    const probe = host.firstElementChild as HTMLElement
    expect(probe.dataset.mainKey).toBe('beta')
    expect(probe.dataset.subagentKey).toBe('alpha')
    expect(probe.dataset.mainIndex).toBe('5')
    expect(probe.dataset.subagentIndex).toBe('2')
  })

  it('repairs deleted main and subagent bindings without adjacent-model drift', () => {
    localStorage.setItem(MAIN_LLM_PREFERENCE_KEY, 'deleted-main')
    localStorage.setItem(SUBAGENT_LLM_PREFERENCE_KEY, 'deleted-subagent')

    act(() => root.render(<Probe />))

    const probe = host.firstElementChild as HTMLElement
    expect(probe.dataset.mainKey).toBe('alpha')
    expect(probe.dataset.subagentKey).toBe('')
    expect(probe.dataset.subagentIndex).toBe('0')
    expect(localStorage.getItem(MAIN_LLM_PREFERENCE_KEY)).toBe('alpha')
    expect(localStorage.getItem(SUBAGENT_LLM_PREFERENCE_KEY)).toBeNull()
  })
})
