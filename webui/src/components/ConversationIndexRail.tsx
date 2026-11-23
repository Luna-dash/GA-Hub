import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { storageKeys } from '@/config/storageKeys'
import { syncUiSetting, UI_SETTINGS_HYDRATED_EVENT } from '@/stores/uiSettingsStore'
import { RailFoldGlyph } from './ActionIcons'

const STORAGE_KEY = storageKeys.conversationIndexCollapsed

type ConversationIndexRailProps = {
  children: ReactNode | ((collapsed: boolean) => ReactNode)
  collapsible?: boolean
}

export function ConversationIndexRail({ children, collapsible = true }: ConversationIndexRailProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')

  useEffect(() => {
    if (!collapsible) return
    const sync = () => setCollapsed(localStorage.getItem(STORAGE_KEY) === 'true')
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
    return () => window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, sync)
  }, [collapsible])

  if (!collapsible) {
    return (
      <aside
        aria-label="历史对话索引"
        className="ga-paper-card flex max-h-[38vh] w-full shrink-0 flex-col overflow-y-auto lg:h-full lg:max-h-none lg:w-[17.5rem] xl:w-[18.5rem]"
      >
        {typeof children === 'function' ? children(false) : children}
      </aside>
    )
  }

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current
      const serialized = String(next)
      localStorage.setItem(STORAGE_KEY, serialized)
      syncUiSetting(STORAGE_KEY, serialized)
      return next
    })
  }

  return (
    <div
      data-collapsed={collapsed ? 'true' : 'false'}
      className={clsx(
        'relative z-10 shrink-0 lg:h-full transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        collapsed ? 'h-12 w-full lg:h-full lg:w-14' : 'h-[min(36dvh,18rem)] w-full lg:h-full lg:w-96',
      )}
    >
      <aside
        aria-label="历史对话索引"
        className={clsx(
          'ga-paper-card absolute inset-y-0 left-0 overflow-y-auto',
          'transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          collapsed ? 'right-9 lg:right-auto lg:w-14' : 'right-9 lg:right-auto lg:w-96',
        )}
      >
        {typeof children === 'function' ? children(collapsed) : children}
      </aside>
      <button
        type="button"
        aria-label={collapsed ? '展开历史对话索引' : '折叠历史对话索引'}
        aria-expanded={!collapsed}
        onClick={toggle}
        title={collapsed ? '展开历史对话索引' : '折叠历史对话索引'}
        className="absolute right-2 top-1/2 z-20 lg:left-full lg:right-auto flex h-14 w-5 -translate-y-1/2 items-center justify-center rounded-r-full border border-l-0 border-[#54432B]/70 bg-[#6B583D] bg-gradient-to-b from-bg-card/15 to-transparent text-[#FAF4E6] shadow-[inset_0_1px_0_rgb(255_255_255_/_0.25),0_2px_5px_rgb(0_0_0_/_0.18)] transition-[background-color,box-shadow] duration-200 hover:bg-[#5A4932] hover:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.3),0_3px_7px_rgb(0_0_0_/_0.22)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <RailFoldGlyph direction={collapsed ? 'right' : 'left'} className="h-3.5 w-3.5 shrink-0" />
      </button>
    </div>
  )
}
