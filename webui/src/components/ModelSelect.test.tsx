// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainModelSelect, SubagentModelSelect, modelPresentation } from './ModelSelect'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const llms = [
  { key: 'alpha', name: 'Mixin/Alpha' },
  { key: 'beta', name: 'NativeOAI/Beta' },
  { key: 'claude', name: 'NativeClaude/Claude' },
]
let host: HTMLDivElement
let root: Root
const trigger = () => host.querySelector('[role="combobox"]') as HTMLButtonElement
const click = (element: Element) => act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const key = (value: string) => act(() => trigger().dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))

beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
})
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('model selectors', () => {
  it('aligns both popup edges with the trigger, including after resize', () => {
    act(() => root.render(<MainModelSelect llms={llms} value="alpha" onChange={() => {}} />))
    const bounds = vi.spyOn(trigger(), 'getBoundingClientRect')
    bounds.mockReturnValue({ left: 600, top: 40, bottom: 72, width: 357.75 } as DOMRect)
    click(trigger())
    const popup = document.querySelector<HTMLElement>('[role="listbox"]')!
    expect(popup.style.left).toBe('600px')
    expect(popup.style.width).toBe('357.75px')
    bounds.mockReturnValue({ left: 16, top: 40, bottom: 72, width: 210 } as DOMRect)
    act(() => window.dispatchEvent(new Event('resize')))
    expect(popup.style.left).toBe('16px')
    expect(popup.style.width).toBe('210px')
  })
  it('reserves the longest displayed model name even when a short model is selected', () => {
    const longName = 'gpt-sol|dpflash41|gpt-luna|dpflashliwan'
    act(() => root.render(<MainModelSelect llms={[...llms, { key: 'long', name: `Mixin/${longName}` }]} value="beta" onChange={() => {}} />))
    expect(trigger().getAttribute('data-sizing-label')).toBe(longName)
    expect(trigger().textContent).toBe('Beta')
    click(trigger())
    expect(document.querySelectorAll('[role="option"]')[3].textContent).toBe(longName)
  })
  it('shows MyKey icons instead of type prefixes in both trigger and options', () => {
    act(() => root.render(<MainModelSelect llms={llms} value="beta" onChange={() => {}} />))
    expect(trigger().textContent).toBe('Beta')
    expect(trigger().title).toBe('NativeOAI/Beta')
    expect(trigger().querySelector('svg[data-channel="openai"]')).not.toBeNull()
    click(trigger())
    const options = [...document.querySelectorAll('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Alpha', 'Beta', 'Claude'])
    expect(options.map((option) => option.querySelector('svg')?.getAttribute('data-channel'))).toEqual(['mixin', 'openai', 'claude'])
    expect(options[1].getAttribute('aria-selected')).toBe('true')
  })
  it('passes the stable key when clicked and closes the menu', () => {
    const onChange = vi.fn()
    act(() => root.render(<MainModelSelect llms={llms} value="alpha" onChange={onChange} />))
    click(trigger()); click(document.querySelectorAll('[role="option"]')[1])
    expect(onChange).toHaveBeenCalledWith('beta')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })
  it('keeps the follow-main option first and sends null for it', () => {
    const onChange = vi.fn()
    act(() => root.render(<SubagentModelSelect llms={llms} value="beta" onChange={onChange} />))
    click(trigger())
    expect(document.querySelector('[role="option"]')?.textContent).toBe('跟随主模型')
    key('Home'); key('Enter')
    expect(onChange).toHaveBeenCalledWith(null)
  })
  it('supports arrows, Home, End, typeahead, Escape and Tab without changing on dismissal', () => {
    const onChange = vi.fn()
    act(() => root.render(<MainModelSelect llms={llms} value="alpha" onChange={onChange} />))
    key('ArrowDown'); key('ArrowDown'); key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('beta')
    key('ArrowDown'); key('End'); key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('claude')
    key('ArrowDown'); key('b'); key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('beta')
    key('ArrowDown'); key('Escape')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    key('ArrowDown'); key('Tab')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(onChange).toHaveBeenCalledTimes(3)
  })
  it('dismisses on outside press and disables an empty selector', () => {
    act(() => root.render(<MainModelSelect llms={llms} value="alpha" onChange={() => {}} />))
    click(trigger())
    act(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    act(() => root.render(<MainModelSelect llms={[]} value={undefined} onChange={() => {}} />))
    expect(trigger().disabled).toBe(true)
  })
  it('retains model paths and unknown prefixes, recognizes alternate spellings', () => {
    expect(modelPresentation('native_oai/vendor/model')).toEqual({ channel: 'openai', label: 'vendor/model' })
    expect(modelPresentation('custom/model')).toEqual({ channel: null, label: 'custom/model' })
    expect(modelPresentation('Plain model').label).toBe('Plain model')
    expect(modelPresentation('Mixin/').label).toBe('Mixin/')
  })
})
