import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import clsx from 'clsx'
import { Z_LAYERS } from '@/config/zLayers'
import '@/styles/model-select.css'

export interface SelectOption { key: string; name: string; disabled?: boolean }
interface ThemedSelectProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange' | 'value'> {
  options: ReadonlyArray<SelectOption>
  value: string
  onChange: (key: string) => void
  displayName: (option: SelectOption) => string
  renderLabel: (option: SelectOption | undefined) => ReactNode
}

/** Shared geometry, theme and accessible interaction for header selectors. */
export function ThemedSelect({ options, value, onChange, displayName, renderLabel, className, disabled, title, ...props }: ThemedSelectProps) {
  const selected = options.find((option) => option.key === value)
  // Native selects reserve room for the longest option, not just the current value.
  const sizingLabel = options.map((option) => displayName(option))
    .reduce((longest, label) => label.length > longest.length ? label : longest, '')
  const disabledNow = disabled || options.length === 0
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [position, setPosition] = useState<CSSProperties>({})
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const search = useRef({ text: '', time: 0 })
  const id = useId()

  const show = () => {
    if (disabledNow) return
    const selectedIndex = options.findIndex((option) => option.key === value && !option.disabled)
    setActive(selectedIndex >= 0 ? selectedIndex : Math.max(0, options.findIndex((option) => !option.disabled)))
    setOpen(true)
  }
  const choose = (index: number) => {
    const option = options[index]
    if (!option || option.disabled) return
    onChange(option.key)
    setOpen(false)
    trigger.current?.focus()
  }

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const below = window.innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const upwards = below < 180 && above > below
      const available = Math.max(48, upwards ? above : below)
      // The popup shares both horizontal edges with its trigger.
      const width = rect.width
      setPosition({
        position: 'fixed', width,
        left: rect.left,
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        maxHeight: Math.min(320, available), zIndex: Z_LAYERS.contextMenu,
      })
    }
    place()
    window.addEventListener('resize', place)
    const onScroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) place() }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, options])

  useEffect(() => {
    if (!open) return
    if (disabledNow) { setOpen(false); return }
    const dismiss = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [open, disabledNow])

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' })
  }, [open, active])

  return <>
    <button
      {...props}
      ref={trigger}
      type="button"
      data-sizing-label={sizingLabel}
      role="combobox"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? id : undefined}
      aria-activedescendant={open ? `${id}-${active}` : undefined}
      disabled={disabledNow}
      title={title ?? selected?.name}
      className={clsx('model-select-trigger min-w-0 shrink-0 text-sm', className)}
      onClick={() => open ? setOpen(false) : show()}
      onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        props.onKeyDown?.(event)
        if (event.defaultPrevented) return
        if (event.key === 'Escape' && open) {
          event.preventDefault(); event.stopPropagation(); setOpen(false)
        } else if (event.key === 'Tab') {
          setOpen(false)
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          if (!open) show()
          else setActive((index) => {
            const step = event.key === 'ArrowUp' || event.key === 'End' ? -1 : 1
            let next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + step + options.length) % options.length
            for (let i = 0; i < options.length; i++) {
              if (!options[next].disabled) return next
              next = (next + step + options.length) % options.length
            }
            return index
          })
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          if (open) choose(active)
          else show()
        } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now()
          search.current.text = (now - search.current.time < 700 ? search.current.text : '') + event.key.toLowerCase()
          search.current.time = now
          const index = options.findIndex((option) => !option.disabled && displayName(option).toLowerCase().startsWith(search.current.text))
          if (index >= 0) { if (!open) show(); setActive(index) }
        }
      }}
    >
      {renderLabel(selected)}
      <ChevronDown size={14} aria-hidden="true" className={clsx('model-select-chevron', open && 'rotate-180')} />
    </button>
    {open && createPortal(
      <div ref={menu} id={id} role="listbox" aria-label={props['aria-label'] ?? title ?? '选择项'} className="model-select-menu" style={position}
        onMouseDown={(event) => event.preventDefault()}>
        {options.map((option, index) => (
          <div key={option.key} id={`${id}-${index}`} role="option" aria-selected={option.key === value} aria-disabled={option.disabled || undefined} data-index={index}
            title={option.name} className={clsx('model-select-option', index === active && 'is-active', option.key === value && 'is-selected', option.disabled && 'is-disabled')}
            onMouseEnter={() => { if (!option.disabled) setActive(index) }} onClick={() => choose(index)}>
            {renderLabel(option)}
            {option.key === value && <Check size={14} aria-hidden="true" className="model-select-check" />}
          </div>
        ))}
      </div>, document.body,
    )}
  </>
}
