// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainModelSelect, SubagentModelSelect } from './ModelSelect'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const llms = [
  { key: 'alpha', name: 'Alpha' },
  { key: 'beta', name: 'Beta' },
]

describe('shared model selectors', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('renders main models by stable key without an empty placeholder', () => {
    const onChange = vi.fn()
    act(() => root.render(<MainModelSelect llms={llms} value="alpha" onChange={onChange} />))

    const select = host.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['alpha', 'beta'])
    expect(select.value).toBe('alpha')

    act(() => {
      select.value = 'beta'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('beta')
  })

  it('keeps following the main model as the single subagent fallback', () => {
    const onChange = vi.fn()
    act(() => root.render(<SubagentModelSelect llms={llms} value={null} onChange={onChange} />))

    const select = host.querySelector('select') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'alpha', 'beta'])
    expect(select.options[0].text).toBe('跟随主模型')
    expect(select.value).toBe('')
  })

  it('disables selection when no model exists', () => {
    act(() => root.render(<MainModelSelect llms={[]} value={undefined} onChange={() => {}} />))
    expect((host.querySelector('select') as HTMLSelectElement).disabled).toBe(true)
  })
})
