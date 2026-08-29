import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { preloadRoute } from '@/routes/routeLoaders'
import clsx from 'clsx'
import {
  getNavPreferences,
  getVisibleNavItems,
  NAV_PREFERENCES_EVENT,
  type NavIconName,
  type NavItem,
} from '@/config/navigation'
function NavIcon({ name }: { name: NavIconName }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.9,
  }
  const filledDot = { fill: 'currentColor', stroke: 'none' }

  return (
    <svg className="ga-nav-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'dashboard' && (
        <>
          {/* 仪表盘：弧面 + 指针（横向撑满） */}
          <path {...common} d="M3.2 16.4a8.8 8.8 0 1 1 17.6 0" />
          <path {...common} d="m12 16.4 4.2-5.6" />
          <circle {...filledDot} cx="12" cy="16.4" r="1.3" />
          <path {...common} d="M2.6 19.2h18.8" />
        </>
      )}
      {name === 'chat' && (
        <>
          {/* 实时聊天：圆角气泡 + 输入中圆点 */}
          <path {...common} d="M2.6 7A2.9 2.9 0 0 1 5.5 4.1h13A2.9 2.9 0 0 1 21.4 7v5.6a2.9 2.9 0 0 1-2.9 2.9h-7.2l-4.3 3.6v-3.6H5.5A2.9 2.9 0 0 1 2.6 12.6z" />
          <circle {...filledDot} cx="7.6" cy="9.8" r="1.05" />
          <circle {...filledDot} cx="12" cy="9.8" r="1.05" />
          <circle {...filledDot} cx="16.4" cy="9.8" r="1.05" />
        </>
      )}
      {name === 'conductor' && (
        <>
          {/* 指挥模式：横眼监看 + 向下派发三支箭头 */}
          <path {...common} d="M6.9 6.1C8.3 4.2 10 3.1 12 3.1s3.7 1.1 5.1 3C15.7 8 14 9.1 12 9.1s-3.7-1.1-5.1-3Z" />
          <circle {...filledDot} cx="12" cy="6.1" r="1.4" />
          <path {...common} d="M12 9.4 3.4 18.9M12 9.4v12.2M12 9.4l8.6 9.5" />
          <path {...common} d="m5.9 18.3-2.5.6.4-2.5" />
          <path {...common} d="m18.1 18.3 2.5.6-.4-2.5" />
          <path {...common} d="m10.1 19.7 1.9 1.9 1.9-1.9" />
        </>
      )}
      {name === 'goalHive' && (
        <>
          {/* Goal 模式：靶心 */}
          <circle {...common} cx="12" cy="12" r="8.6" />
          <circle {...common} cx="12" cy="12" r="4.5" />
          <circle {...filledDot} cx="12" cy="12" r="1.4" />
        </>
      )}
      {name === 'conversations' && (
        <>
          {/* 历史对话：书叠（归档成册） */}
          <rect {...common} x="4.9" y="6.6" width="14.2" height="6.4" rx="1.4" />
          <path {...common} d="M8.7 6.6v6.4" />
          <rect {...common} x="2.6" y="13.4" width="18.8" height="6.4" rx="1.4" />
          <path {...common} d="M6.4 13.4v6.4" />
        </>
      )}
      {name === 'memory' && (
        <>
          {/* 记忆体系：标准双半球大脑（放大重描 + 褶皱） */}
          <path {...common} d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z" />
          <path {...common} d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z" />
          <path {...common} d="M6.2 9.4c1.2-.5 2.4-.3 3.3.6M17.8 9.4c-1.2-.5-2.4-.3-3.3.6" />
        </>
      )}
      {name === 'mykey' && (
        <>
          {/* LLM 管理：钥匙 */}
          <circle {...common} cx="7.4" cy="8.6" r="4.4" />
          <path {...common} d="M10.6 11.8 20.6 21.4M15.8 17l1.8-1.8M18 19.2l1.5-1.5" />
        </>
      )}
      {name === 'tasks' && (
        <>
          {/* 定时任务：钟面 */}
          <circle {...common} cx="12" cy="12" r="8.6" />
          <path {...common} d="M12 7.2V12l3.2 2.2" />
        </>
      )}
      {name === 'autonomous' && (
        <>
          {/* 自主进化：循环 + 实心聚点 */}
          <path {...common} d="M19.5 11a7.6 7.6 0 0 0-13-4.8L4.8 7.9" />
          <path {...common} d="M5 3.6v4.3h4.3" />
          <path {...common} d="M4.5 13a7.6 7.6 0 0 0 13 4.8l1.7-1.7" />
          <path {...common} d="M19 20.4v-4.3h-4.3" />
          <circle {...filledDot} cx="12" cy="12" r="1.15" />
        </>
      )}
      {name === 'tokens' && (
        <>
          {/* 用量统计：柱状 */}
          <path {...common} d="M4.2 19.6v-7.4M9.4 19.6v-12M14.6 19.6v-15.4M19.8 19.6v-10" />
          <path {...common} d="M2.6 19.6h18.8" />
        </>
      )}
      {name === 'settings' && (
        <>
          {/* 系统设置：齿轮 */}
          <path {...common} d="M12 3.4v2.2M12 18.4v2.2M3.4 12h2.2M18.4 12h2.2M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6" />
          <circle {...common} cx="12" cy="12" r="4.2" />
          <circle {...filledDot} cx="12" cy="12" r="1.1" />
        </>
      )}
    </svg>
  )
}
export function SidebarNav() {
  const [items, setItems] = useState<NavItem[]>(() => getVisibleNavItems())
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('gahub.sidebar.collapsed') === '1')
  const openCommandPalette = () => window.dispatchEvent(new Event('gahub:command-palette'))
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      localStorage.setItem('gahub.sidebar.collapsed', current ? '0' : '1')
      return !current
    })
  }

  useEffect(() => {
    const refresh = () => setItems(getVisibleNavItems(getNavPreferences()))
    window.addEventListener(NAV_PREFERENCES_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => {
      window.removeEventListener(NAV_PREFERENCES_EVENT, refresh)
      window.removeEventListener('storage', refresh)
    }
  }, [])

  return (
    <aside
      data-collapsed={collapsed ? 'true' : 'false'}
      className={clsx(
        'ga-sidebar shrink-0 flex flex-col shadow-[6px_0_14px_rgba(21,27,18,0.18)]',
        'transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        collapsed ? 'w-14' : 'w-[9.5rem]',
      )}
    >
      <div className="ga-sidebar-brand-row border-b border-white/10 flex items-center">
        <div className="ga-brand-mark min-w-0" aria-label="GA Hub">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? '展开导航栏' : '折叠导航栏'}
            title={collapsed ? '展开导航栏' : '折叠导航栏'}
            className="ga-brand-toggle"
          >
            <div className="ga-brand-core">
              <div className="ga-brand-orb" aria-hidden="true">
                <span className="ga-brand-ga">GA</span>
              </div>
              {!collapsed && <span className="ga-brand-hub">HUB</span>}
            </div>
          </button>
          {!collapsed && (
            <NavLink
              to="/settings"
              onMouseEnter={() => preloadRoute('/settings')}
              onFocus={() => preloadRoute('/settings')}
              className={({ isActive }) =>
                clsx('ga-brand-settings', isActive && 'active')
              }
              aria-label="系统设置"
              title="系统设置"
            >
              <NavIcon name="settings" />
            </NavLink>
          )}
        </div>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto py-1.5 ga-sidebar-nav">
        {items.map((it) => (
          <NavLink
            key={it.to}
            to={it.to}
            title={it.label}
            onMouseEnter={() => preloadRoute(it.to)}
            onFocus={() => preloadRoute(it.to)}
            className={({ isActive }) =>
              clsx('ga-sidebar-item', collapsed && 'ga-sidebar-item-collapsed', isActive && 'active')
            }
          >
            <span className="ga-nav-icon" aria-hidden="true"><NavIcon name={it.icon} /></span>
            {!collapsed && (
              <>
                <span className="ga-nav-label">{it.label}</span>
                <span className="ga-nav-chev" aria-hidden="true">›</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className={clsx('flex flex-col gap-1.5 pb-2.5 pt-1.5', collapsed ? 'items-center px-1.5' : 'px-2.5')}>
        {!collapsed && (
          <button
            type="button"
            onClick={openCommandPalette}
            className="ga-cmd-row"
          >
            <span>命令面板</span>
            <kbd className="ga-cmd-kbd">Ctrl K</kbd>
          </button>
        )}
        {collapsed && (
          <NavLink
            to="/settings"
            onMouseEnter={() => preloadRoute('/settings')}
            onFocus={() => preloadRoute('/settings')}
            className="ga-sidebar-fold ga-sidebar-fold-collapsed"
            aria-label="系统设置"
            title="系统设置"
          >
            <NavIcon name="settings" />
          </NavLink>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="折叠/展开导航栏"
          title={collapsed ? '展开导航栏' : '折叠导航栏'}
          className={clsx(
            'ga-sidebar-fold',
            collapsed ? 'ga-sidebar-fold-collapsed' : '',
          )}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" className="ga-sidebar-fold-icon">
            {collapsed ? (
              <>
                <path d="m10 17 5-5-5-5" />
                <path d="m16 17 5-5-5-5" transform="translate(-2 0)" />
              </>
            ) : (
              <>
                <path d="m14 17-5-5 5-5" />
                <path d="m8 17-5-5 5-5" transform="translate(2 0)" />
              </>
            )}
          </svg>
          {!collapsed && <span>折叠</span>}
        </button>
      </div>
    </aside>
  )
}
