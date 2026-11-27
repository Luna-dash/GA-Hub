// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Z_LAYERS } from '@/config/zLayers'
import { registerOverlay } from '@/utils/overlayStack'
import {
  buildMinimapSlots,
  ConversationTurnMinimap,
  MAX_DIRECT_MINIMAP_SLOTS,
  type MinimapTurnItem,
} from './ConversationTurnMinimap'
import { TranscriptUtilityRail } from './ChatLayout'
import { TranscriptNavDock } from './TranscriptNavDock'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function makeTurns(count: number): MinimapTurnItem[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `turn-${idx}`,
    index: idx + 1,
    label: idx === 14 ? '修复缓存命中率异常的问题' : `第 ${idx + 1} 轮测试消息内容`,
  }))
}

describe('buildMinimapSlots', () => {
  it('maps short conversations 1:1 up to maxSlots', () => {
    expect(buildMinimapSlots(0, 0)).toEqual([])
    expect(buildMinimapSlots(2, 1)).toEqual([0, 1])
    expect(buildMinimapSlots(11, 5)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('keeps long conversations proportional and non-sticky across the entire range', () => {
    const total = 50
    for (let active = 0; active < total; active += 1) {
      const slots = buildMinimapSlots(total, active, MAX_DIRECT_MINIMAP_SLOTS)
      expect(slots).toHaveLength(MAX_DIRECT_MINIMAP_SLOTS)
      expect(slots[0]).toBe(0)
      expect(slots[slots.length - 1]).toBe(total - 1)
      expect(slots).toContain(active)
      for (let i = 1; i < slots.length; i += 1) {
        expect(slots[i]).toBeGreaterThan(slots[i - 1])
      }
    }

    // Scrolling up from the bottom moves the active slot smoothly from bottom -> middle -> top
    const slotOf = (active: number) => buildMinimapSlots(total, active).indexOf(active)
    expect(slotOf(49)).toBe(10)
    expect(slotOf(38)).toBeGreaterThanOrEqual(7)
    expect(slotOf(38)).toBeLessThanOrEqual(9)
    expect(slotOf(25)).toBe(5)
    expect(slotOf(12)).toBeGreaterThanOrEqual(2)
    expect(slotOf(12)).toBeLessThanOrEqual(4)
    expect(slotOf(1)).toBe(1)
    expect(slotOf(0)).toBe(0)
  })
})

describe('ConversationTurnMinimap', () => {
  let host: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    if (root) {
      act(() => root!.unmount())
      root = null
    }
    host?.remove()
    host = null
  })

  function mount(items: MinimapTurnItem[], activeIndex: number, onSelect = vi.fn()) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => {
      root!.render(
        <ConversationTurnMinimap
          items={items}
          activeIndex={activeIndex}
          onSelect={onSelect}
        />,
      )
    })
    return { host, onSelect }
  }

  it('renders capped proportional dot buttons and a position chip for long sessions', () => {
    const { host: el } = mount(makeTurns(40), 20)
    const dotButtons = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="多轮会话选择器"] button')]
    expect(dotButtons).toHaveLength(MAX_DIRECT_MINIMAP_SLOTS)
    const activeSlot = dotButtons.findIndex((b) => b.getAttribute('aria-current') === 'step')
    expect(activeSlot).toBe(5)

    const dirTrigger = el.querySelector<HTMLButtonElement>('[data-turn-directory-trigger]')!
    expect(dirTrigger.textContent).toBe('21/40')
  })

  it('opens searchable full-turn directory popover, jumps to selection, supports quick jumps and Escape', () => {
    const onSelect = vi.fn()
    const { host: el } = mount(makeTurns(40), 25, onSelect)

    const dirTrigger = el.querySelector<HTMLButtonElement>('[data-turn-directory-trigger]')!
    act(() => dirTrigger.click())

    const popover = el.querySelector<HTMLElement>('[data-turn-directory-popover]')!
    expect(popover).not.toBeNull()
    expect(popover.hasAttribute('data-chat-wheel-independent')).toBe(true)
    expect(popover.querySelectorAll('div[data-chat-wheel-independent] > button')).toHaveLength(40)

    // Filter by keyword
    const searchInput = popover.querySelector<HTMLInputElement>('input[aria-label="筛选对话轮次"]')!
    expect(searchInput.type).toBe('text')
    expect(popover.querySelector('button[aria-label="清空筛选"]')).toBeNull()
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, '缓存命中率')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const filteredButtons = [...popover.querySelectorAll<HTMLButtonElement>('div[data-chat-wheel-independent] > button')]
    expect(filteredButtons).toHaveLength(1)
    expect(filteredButtons[0].textContent).toContain('#15')

    // Clear button resets query, restores all rows, and keeps focus in filter input
    const clearBtn = popover.querySelector<HTMLButtonElement>('button[aria-label="清空筛选"]')!
    expect(clearBtn).not.toBeNull()
    act(() => clearBtn.click())
    expect(searchInput.value).toBe('')
    expect(document.activeElement).toBe(searchInput)
    expect(popover.querySelectorAll('div[data-chat-wheel-independent] > button')).toHaveLength(40)
    expect(popover.querySelector('button[aria-label="清空筛选"]')).toBeNull()

    // Filter again before selecting
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, '缓存命中率')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const refilteredButtons = [...popover.querySelectorAll<HTMLButtonElement>('div[data-chat-wheel-independent] > button')]

    // Selecting row jumps to turn index 14 and closes popover
    act(() => refilteredButtons[0].click())
    expect(onSelect).toHaveBeenCalledWith(14)
    expect(el.querySelector('[data-turn-directory-popover]')).toBeNull()

    // Reopen and filter by turn number (#15 or 15)
    act(() => dirTrigger.click())
    const popover2 = el.querySelector<HTMLElement>('[data-turn-directory-popover]')!
    const searchInput2 = popover2.querySelector<HTMLInputElement>('input[aria-label="筛选对话轮次"]')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput2, '15')
      searchInput2.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(popover2.querySelectorAll('div[data-chat-wheel-independent] > button')).toHaveLength(1)

    // Quick jump buttons 首轮 / 末轮
    const firstBtn = [...popover2.querySelectorAll('button')].find((b) => b.textContent === '首轮')!
    act(() => firstBtn.click())
    expect(onSelect).toHaveBeenCalledWith(0)
    expect(el.querySelector('[data-turn-directory-popover]')).toBeNull()

    act(() => dirTrigger.click())
    const popover3 = el.querySelector<HTMLElement>('[data-turn-directory-popover]')!
    const lastBtn = [...popover3.querySelectorAll('button')].find((b) => b.textContent === '末轮')!
    act(() => lastBtn.click())
    expect(onSelect).toHaveBeenCalledWith(39)

    // Escape closes popover and restores focus to trigger; focus starts in search input on open
    act(() => dirTrigger.click())
    const popover4 = el.querySelector<HTMLElement>('[data-turn-directory-popover]')!
    expect(popover4).not.toBeNull()
    expect(document.activeElement).toBe(popover4.querySelector('input[aria-label="筛选对话轮次"]'))

    // Higher overlay takes Escape first without closing directory
    const modalEsc = vi.fn()
    const modalReg = registerOverlay({ zIndex: Z_LAYERS.dialog, getPanel: () => null, onEscape: modalEsc })
    try {
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      })
      expect(modalEsc).toHaveBeenCalledTimes(1)
      expect(el.querySelector('[data-turn-directory-popover]')).not.toBeNull()
    } finally {
      modalReg.unregister()
    }

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    expect(el.querySelector('[data-turn-directory-popover]')).toBeNull()
    expect(document.activeElement).toBe(dirTrigger)
  })

  it('reuses slot button DOM nodes smoothly instead of remounting when activeIndex crosses ends', () => {
    const items = makeTurns(30)
    const { host: el } = mount(items, 15)
    const beforeButtons = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="多轮会话选择器"] button')]
    expect(beforeButtons).toHaveLength(MAX_DIRECT_MINIMAP_SLOTS)

    act(() => {
      root!.render(<ConversationTurnMinimap items={items} activeIndex={29} onSelect={vi.fn()} />)
    })
    const atBottomButtons = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="多轮会话选择器"] button')]
    atBottomButtons.forEach((btn, idx) => {
      expect(btn).toBe(beforeButtons[idx])
    })

    act(() => {
      root!.render(<ConversationTurnMinimap items={items} activeIndex={0} onSelect={vi.fn()} />)
    })
    const atTopButtons = [...el.querySelectorAll<HTMLButtonElement>('[aria-label="多轮会话选择器"] button')]
    atTopButtons.forEach((btn, idx) => {
      expect(btn).toBe(beforeButtons[idx])
    })
  })

  it('keeps fixed bottom dock reserve space even when TranscriptNavDock hides at stuckBottom', () => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const items = makeTurns(6)
    const renderAt = (stuckBottom: boolean) => act(() => {
      root!.render(
        <TranscriptUtilityRail
          minimap={<ConversationTurnMinimap items={items} activeIndex={5} onSelect={vi.fn()} />}
          navDock={(
            <TranscriptNavDock
              stuckBottom={stuckBottom}
              canPrev
              canNext={false}
              onJumpToBottom={vi.fn()}
              onPrev={vi.fn()}
              onNext={vi.fn()}
            />
          )}
        />,
      )
    })

    renderAt(true)
    expect(host.querySelector('[aria-label="对话位置导航"]')).toBeNull()
    const aside = host.querySelector<HTMLElement>('aside[aria-label="对话功能区"]')!
    const bottomSlotStuck = aside.lastElementChild as HTMLElement
    expect(bottomSlotStuck.className).toContain('h-[132px]')
    expect(bottomSlotStuck.className).toContain('shrink-0')
    expect(bottomSlotStuck.className).toContain('pointer-events-none')

    renderAt(false)
    expect(host.querySelector('[aria-label="对话位置导航"]')).not.toBeNull()
    const bottomSlotFree = aside.lastElementChild as HTMLElement
    expect(bottomSlotFree).toBe(bottomSlotStuck)
    expect(bottomSlotFree.className).toContain('h-[132px]')
  })

  it('does not capture pointer before drag threshold so clicking compressed dot buttons selects the turn', () => {
    const onSelect = vi.fn()
    const { host: el } = mount(makeTurns(30), 29, onSelect)
    const nav = el.querySelector<HTMLElement>('[aria-label="多轮会话选择器"]')!
    const setPointerCapture = vi.fn()
    nav.setPointerCapture = setPointerCapture

    const dotButtons = [...nav.querySelectorAll<HTMLButtonElement>('button')]
    const targetSlotIdx = 0
    const targetBtn = dotButtons[targetSlotIdx]
    const PointerCtor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent

    act(() => {
      targetBtn.dispatchEvent(new PointerCtor('pointerdown', { bubbles: true, button: 0, clientY: 100 }))
      window.dispatchEvent(new PointerCtor('pointermove', { bubbles: true, clientY: 103 }))
      targetBtn.dispatchEvent(new PointerCtor('pointerup', { bubbles: true, button: 0, clientY: 103 }))
      targetBtn.click()
    })

    expect(setPointerCapture).not.toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(0)
  })

  it('acquires pointer capture once scrubbing crosses drag threshold and suppresses trailing click', () => {
    const onSelect = vi.fn()
    const { host: el } = mount(makeTurns(30), 0, onSelect)
    const nav = el.querySelector<HTMLElement>('[aria-label="多轮会话选择器"]')!
    const setPointerCapture = vi.fn()
    const releasePointerCapture = vi.fn()
    nav.setPointerCapture = setPointerCapture
    nav.hasPointerCapture = vi.fn(() => true)
    nav.releasePointerCapture = releasePointerCapture
    vi.spyOn(nav, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 300,
      left: 0,
      right: 28,
      width: 28,
      height: 200,
      x: 0,
      y: 100,
      toJSON: () => ({}),
    })

    const dotButtons = [...nav.querySelectorAll<HTMLButtonElement>('button')]
    const PointerCtor = typeof PointerEvent !== 'undefined' ? PointerEvent : MouseEvent

    act(() => {
      const down = new PointerCtor('pointerdown', { bubbles: true, button: 0, clientY: 110 })
      Object.defineProperty(down, 'pointerId', { value: 7 })
      dotButtons[0].dispatchEvent(down)
      expect(setPointerCapture).not.toHaveBeenCalled()

      const move = new PointerCtor('pointermove', { bubbles: true, clientY: 200 })
      Object.defineProperty(move, 'pointerId', { value: 7 })
      window.dispatchEvent(move)
      expect(setPointerCapture).toHaveBeenCalledWith(7)

      const up = new PointerCtor('pointerup', { bubbles: true, button: 0, clientY: 200 })
      Object.defineProperty(up, 'pointerId', { value: 7 })
      window.dispatchEvent(up)
      dotButtons[5].click()
    })

    expect(releasePointerCapture).toHaveBeenCalledWith(7)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith(15)
  })

  it('survives 1-turn <-> multi-turn transitions without changing hook order', () => {
    const { host: el } = mount(makeTurns(3), 1)
    expect(el.querySelectorAll('[aria-label="多轮会话选择器"] button')).toHaveLength(3)

    act(() => {
      root!.render(<ConversationTurnMinimap items={makeTurns(1)} activeIndex={0} onSelect={vi.fn()} />)
    })
    expect(el.querySelector('[aria-label="多轮会话选择器"]')).toBeNull()

    act(() => {
      root!.render(<ConversationTurnMinimap items={makeTurns(3)} activeIndex={2} onSelect={vi.fn()} />)
    })
    expect(el.querySelectorAll('[aria-label="多轮会话选择器"] button')).toHaveLength(3)
  })
})
