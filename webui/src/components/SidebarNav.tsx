import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import { useAgentStore } from '@/stores/agentStore'
import { useThemeStore } from '@/stores/themeStore'

const items = [
  { to: '/chat', label: '实时聊天', icon: '💬' },
  { to: '/feishu', label: '飞书 Bot', icon: '🪽' },
  { to: '/conversations', label: '对话管理', icon: '🗂️' },
  { to: '/llms', label: '选择LLM', icon: '⚡' },
  { to: '/mykey', label: '链路配置', icon: '🔑' },
  { to: '/memory', label: 'SOP 记忆', icon: '🧠' },
  { to: '/tasks', label: '定时任务', icon: '⏰' },
  { to: '/goal-hive', label: 'Goal Hive', icon: '🐝' },
  { to: '/autonomous', label: '自主进化', icon: '🌀' },
  { to: '/settings', label: '设置', icon: '⚙️' },
]

export function SidebarNav() {
  const status = useAgentStore((s) => s.status)
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  return (
    <aside className="ga-sidebar w-56 shrink-0 flex flex-col shadow-[6px_0_14px_rgba(21,27,18,0.18)]">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-2">
        <div className="ga-brand-mark min-w-0" aria-label="GA Hub">
          <div className="ga-brand-orb" aria-hidden="true">
            <span className="ga-brand-ga">GA</span>
          </div>
          <div className="ga-brand-text">
            <span className="ga-brand-hub">hub</span>
            <span className="ga-brand-sub">agent workspace</span>
          </div>
        </div>
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          aria-label="toggle theme"
          className="shrink-0 w-7 h-7 rounded-md border border-white/15 text-[#D8CFB8] hover:text-white hover:bg-white/8 flex items-center justify-center text-sm leading-none"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto py-3 ga-sidebar-nav">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
            className={({ isActive }) =>
              clsx('ga-sidebar-item', isActive && 'active')
            }
          >
            <span className="ga-nav-icon" aria-hidden="true">{it.icon}</span>
            <span className="ga-nav-label">{it.label}</span>
            <span className="ga-nav-chev" aria-hidden="true">›</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-white/10 px-4 py-3 text-xs text-[#D8CFB8]/70 space-y-1">
        <div>
          <span className={clsx('inline-block w-2 h-2 rounded-full mr-2',
            status?.is_running ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400')} />
          {status?.is_running ? '运行中' : '空闲'}
        </div>
        <div className="truncate" title={status?.llm_name}>LLM: {status?.llm_name ?? '—'}</div>
        <div className="pt-1 text-[10px] text-[#D8CFB8]/55 flex items-center gap-1">
          <kbd className="px-1 py-0.5 rounded border border-line/60 bg-black/12 font-mono text-[#EFE5CA]">⌘K</kbd>
          <span>命令面板</span>
        </div>
      </div>
    </aside>
  )
}
