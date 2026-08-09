import { useState, type ReactNode } from 'react'
import clsx from 'clsx'

const STORAGE_KEY = 'gahub.conversationIndexCollapsed'

export function ConversationIndexRail({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(STORAGE_KEY) === 'true')

  const toggle = () => {
    setCollapsed((current) => {
      const next = !current
      localStorage.setItem(STORAGE_KEY, String(next))
      return next
    })
  }

  return (
    <div
      data-collapsed={collapsed ? 'true' : 'false'}
      className={clsx(
        'relative z-10 h-full shrink-0 transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        collapsed ? 'w-0' : 'w-96',
      )}
    >
      <aside
        aria-label="历史对话索引"
        aria-hidden={collapsed}
        className={clsx(
          'absolute inset-y-0 left-0 w-96 overflow-y-auto border-r border-line bg-bg-soft',
          'transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          collapsed ? 'pointer-events-none -translate-x-3 opacity-0' : 'translate-x-0 opacity-100',
        )}
      >
        {children}
      </aside>
      <button
        type="button"
        aria-label={collapsed ? '展开历史对话索引' : '折叠历史对话索引'}
        aria-expanded={!collapsed}
        onClick={toggle}
        title={collapsed ? '展开历史对话索引' : '折叠历史对话索引'}
        className="absolute left-full top-1/2 z-20 flex h-12 w-6 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-line bg-bg-card/95 text-[#665741] shadow-md backdrop-blur-sm transition-colors hover:bg-white"
      >
        <span aria-hidden="true">{collapsed ? '›' : '‹'}</span>
      </button>
    </div>
  )
}
