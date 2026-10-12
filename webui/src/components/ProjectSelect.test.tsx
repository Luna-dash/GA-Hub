// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectSelect } from './ProjectSelect'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const options = [
  { key: '', name: '未绑定项目' },
  { key: '/missing', name: '失效项目（路径不可用）', disabled: true },
  { key: '/valid', name: '我的项目' },
  { key: '__new__', name: '新建项目…' },
]
let host: HTMLDivElement
let root: Root
const trigger = () => host.querySelector('[role="combobox"]') as HTMLButtonElement
const click = (e: Element) => act(() => e.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const key = (key: string) => act(() => trigger().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })))
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

describe('project selector', () => {
  it('uses an empty dashed circle for unbound state and distinct folder icons for project actions', () => {
    act(() => root.render(<ProjectSelect options={options} value="" onChange={() => {}} />))
    expect(trigger().querySelector('.lucide-circle-dashed')).not.toBeNull()
    expect(trigger().querySelector('.lucide-folder-open')).toBeNull()
    click(trigger())
    const items = document.querySelectorAll('[role="option"]')
    expect(items[0].querySelector('.lucide-circle-dashed')).not.toBeNull()
    expect(items[2].querySelector('.lucide-folder-open')).not.toBeNull()
    expect(items[3].querySelector('.lucide-folder-plus')).not.toBeNull()
    key('Escape')
    act(() => root.render(<ProjectSelect options={options} value="/valid" onChange={() => {}} />))
    expect(trigger().querySelector('.lucide-folder-open')).not.toBeNull()
    expect(trigger().querySelector('.lucide-circle-dashed')).toBeNull()
  })
  it('shares the model theme and aligns menu edges while showing project labels literally', () => {
    act(() => root.render(<ProjectSelect options={options} value="/valid" onChange={() => {}} />))
    expect(trigger().classList.contains('model-select-trigger')).toBe(true)
    expect(trigger().classList.contains('project-select-trigger')).toBe(true)
    expect(trigger().getAttribute('aria-label')).toBe('当前项目')
    expect(trigger().textContent).toBe('我的项目')
    expect(trigger().querySelector('.model-select-mark svg')).not.toBeNull()
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue({ left: 120, top: 20, bottom: 55, width: 220 } as DOMRect)
    click(trigger())
    const menu = document.querySelector<HTMLElement>('[role="listbox"]')!
    expect(menu.style.width).toBe('220px'); expect(menu.style.left).toBe('120px')
    expect([...menu.querySelectorAll('[role="option"]')].map((e) => e.textContent)).toEqual(options.map((e) => e.name))
  })
  it('prevents dangling project selection by click and skips it with keyboard navigation', () => {
    const onChange = vi.fn()
    act(() => root.render(<ProjectSelect options={options} value="" onChange={onChange} />))
    click(trigger()); click(document.querySelectorAll('[role="option"]')[1])
    expect(onChange).not.toHaveBeenCalled()
    expect(document.querySelectorAll('[role="option"]')[1].getAttribute('aria-disabled')).toBe('true')
    key('ArrowDown'); key('Enter')
    expect(onChange).toHaveBeenCalledWith('/valid')
  })
  it('keeps unbind and create actions, closes on selection and supports disabled binding', () => {
    const onChange = vi.fn()
    act(() => root.render(<ProjectSelect options={options} value="/valid" onChange={onChange} />))
    click(trigger()); key('Home'); key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('')
    click(trigger()); key('End'); key('Enter')
    expect(onChange).toHaveBeenLastCalledWith('__new__')
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    act(() => root.render(<ProjectSelect options={options} value="/valid" disabled onChange={onChange} />))
    expect(trigger().disabled).toBe(true)
  })
})
