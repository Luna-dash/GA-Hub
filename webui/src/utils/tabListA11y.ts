import type { KeyboardEvent } from 'react'

export interface TabListKeyDownOptions<T extends string> {
  event: KeyboardEvent<HTMLElement>
  items: readonly T[]
  current: T
  orientation?: 'horizontal' | 'vertical'
  onSelect: (next: T, focusTarget: () => void) => void | Promise<void>
}

export function handleTabListKeyDown<T extends string>({
  event,
  items,
  current,
  orientation = 'horizontal',
  onSelect,
}: TabListKeyDownOptions<T>): void {
  if (items.length === 0) return
  const prevKey = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft'
  const nextKey = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight'
  const currentIndex = items.indexOf(current)
  if (currentIndex < 0) return

  let nextIndex: number | null = null
  if (event.key === nextKey) nextIndex = (currentIndex + 1) % items.length
  else if (event.key === prevKey) nextIndex = (currentIndex - 1 + items.length) % items.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = items.length - 1

  if (nextIndex === null) return
  event.preventDefault()

  const nextItem = items[nextIndex]
  const tablist = event.currentTarget.parentElement
  const focusTarget = () => {
    tablist?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus()
  }
  void onSelect(nextItem, focusTarget)
}
