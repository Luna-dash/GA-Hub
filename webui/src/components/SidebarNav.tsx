import { NavLink } from 'react-router-dom'
import clsx from 'clsx'
import { useAgentStore } from '@/stores/agentStore'
import { useThemeStore } from '@/stores/themeStore'

const items = [
  { to: '/', label: '仪表盘', icon: '📊' },
  { to: '/chat', label: '实时聊天', icon: '💬' },
  { to: '/wechat', label: '微信机器人', icon: '🤖' },
  { to: '/conversations', label: '对话管理', icon: '🗂️' },
  { to: '/memory', label: '记忆 & SOP', icon: '🧠' },
  { to: '/skills', label: '技能库', icon: '🌳' },
  { to: '/llms', label: 'LLM', icon: '⚡' },
  { to: '/mykey', label: '链路配置', icon: '🔑' },
  { to: '/autonomous', label: '自主进化', icon: '🌀' },
  { to: '/settings', label: '设置', icon: '⚙️' },
]

export function SidebarNav() {
  const status = useAgentStore((s) => s.status)
  const theme = useThemeStore((s) => s.theme)
  const toggleTheme = useThemeStore((s) => s.toggle)
  return (
    <aside className="w-56 shrink-0 border-r border-line bg-bg-soft flex flex-col">
      <div className="px-4 py-4 border-b border-line flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-base font-semibold tracking-wide">GenericAgent</div>
          <div className="text-xs text-slate-500">管理控制台 · v0.1</div>
        </div>
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
          aria-label="toggle theme"
          className="shrink-0 w-8 h-8 rounded-lg border border-line text-slate-400 hover:text-slate-200 hover:bg-white/5 flex items-center justify-center text-base leading-none"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            end={it.to === '/'}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-4 py-2 text-sm transition-colors',
                isActive
                  ? 'bg-accent-soft text-accent border-r-2 border-accent'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-white/5',
              )
            }
          >
            <span className="text-base">{it.icon}</span>
            <span>{it.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-line px-4 py-3 text-xs text-slate-500 space-y-1">
        <div>
          <span className={clsx('inline-block w-2 h-2 rounded-full mr-2',
            status?.is_running ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400')} />
          {status?.is_running ? '运行中' : '空闲'}
        </div>
        <div className="truncate" title={status?.llm_name}>LLM: {status?.llm_name ?? '—'}</div>
        <div className="pt-1 text-[10px] text-slate-600 flex items-center gap-1">
          <kbd className="px-1 py-0.5 rounded border border-line/60 bg-bg-card font-mono">⌘K</kbd>
          <span>命令面板</span>
        </div>
      </div>
    </aside>
  )
}
