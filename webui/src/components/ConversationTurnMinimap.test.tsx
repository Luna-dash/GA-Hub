// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(searchInput, '缓存命中率')
      searchInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const filteredButtons = [...popover.querySelectorAll<HTMLButtonElement>('div[data-chat-wheel-independent] > button')]
    expect(filteredButtons).toHaveLength(1)
    expect(filteredButtons[0].textContent).toContain('#15')

    // Selecting row jumps to turn index 14 and closes popover
    act(() => filteredButtons[0].click())
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

    // Escape closes popover
    act(() => dirTrigger.click())
    expect(el.querySelector('[data-turn-directory-popover]')).not.toBeNull()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(el.querySelector('[data-turn-directory-popover]')).toBeNull()
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
})
