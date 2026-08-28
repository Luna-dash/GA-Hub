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
    strokeWidth: 2.15,
  }
  const filledDot = { fill: 'currentColor', stroke: 'none' }

  return (
    <svg className="ga-nav-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {name === 'dashboard' && (
        <>
          <rect {...common} x="4.5" y="4.5" width="6" height="6" rx="1" />
          <rect {...common} x="13.5" y="4.5" width="6" height="6" rx="1" />
          <rect {...common} x="4.5" y="13.5" width="6" height="6" rx="1" />
          <rect {...common} x="13.5" y="13.5" width="6" height="6" rx="1" />
        </>
      )}
      {name === 'chat' && (
        <>
          <path {...common} d="M5 6.2h14v8.7H12l-4.3 3.3v-3.3H5z" />
          <path {...common} d="M8.4 9.5h7.2M8.4 12.2h4.8" />
        </>
      )}
      {name === 'conversations' && (
        <>
          <path {...common} d="M4.8 6.2h10.8v6.9H9.3l-3.4 2.8v-2.8H4.8z" />
          <path {...common} d="M9 15.2h5.9l3.2 2.6v-2.6h1.1V8.7h-2" />
        </>
      )}
      {name === 'memory' && (
        <>
          <path {...common} d="M6.2 5.2h7.3a2.4 2.4 0 0 1 2.4 2.4v12H8.1a2 2 0 0 1-2-2z" />
          <path {...common} d="M8.9 5.2v14M11.2 8.3h3.1M11.2 11.3h4.7" />
          <path {...common} d="M15.9 7.6h1.7a1.3 1.3 0 0 1 1.3 1.3v10.7h-3" />
        </>
      )}
      {name === 'conductor' && (
        <>
          <path {...common} d="M6 6.1h4.2v4.2H6zM13.8 6.1H18v4.2h-4.2zM9.9 15h4.2v4.2H9.9z" />
          <path {...common} d="M10.2 8.2h3.6M12 10.3V15" />
        </>
      )}
      {name === 'goalHive' && (
        <>
          <path {...common} d="M12 3.9 16.1 6.3v4.8L12 13.5 7.9 11.1V6.3z" />
          <path {...common} d="M7.8 12.9 11.9 15.3v4.2l-4.1-2.3-4-2.4v-4.2z" />
          <path {...common} d="M16.2 12.9v4.3l-4.1 2.3v-4.2z" />
        </>
      )}
      {name === 'mykey' && (
        <>
          <circle {...common} cx="8.5" cy="10" r="3.5" />
          <path {...common} d="M11 12.5 18.6 20M15 16.4l2.1-2.1M17.1 18.5l1.5-1.5" />
          <circle {...filledDot} cx="8.5" cy="10" r="0.85" />
        </>
      )}
      {name === 'tasks' && (
        <>
          <path {...common} d="M6.4 5.6h11.2v13.2H6.4z" />
          <path {...common} d="M8.8 9.2l1.2 1.2 2.2-2.4M13.8 9.8h2.2M8.8 14.5l1.2 1.2 2.2-2.4M13.8 15.1h2.2" />
        </>
      )}
      {name === 'autonomous' && (
        <>
          <path {...common} d="M18.5 11.2a6.5 6.5 0 0 0-11-4.1L6 8.5M5.5 12.8a6.5 6.5 0 0 0 11 4.1l1.5-1.4" />
          <path {...common} d="M6 4.8v3.7h3.7M18 19.2v-3.7h-3.7" />
          <circle {...common} cx="12" cy="12" r="2.5" />
          <circle {...filledDot} cx="12" cy="12" r="0.8" />
        </>
      )}
      {name === 'tokens' && (
        <>
          <path {...common} d="M5 18.5V12M10 18.5V8M15 18.5V5M20 18.5V10" />
          <path {...common} d="M3.5 18.5h18" />
        </>
      )}
      {name === 'settings' && (
        <>
          <path {...common} d="M12 5.2v2M12 16.8v2M5.2 12h2M16.8 12h2M7.2 7.2l1.4 1.4M15.4 15.4l1.4 1.4M16.8 7.2l-1.4 1.4M8.6 15.4l-1.4 1.4" />
          <circle {...common} cx="12" cy="12" r="4.1" />
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
        {collapsed ? (
          <>
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="命令面板 (Ctrl K)"
              title="命令面板 (Ctrl K)"
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/6 text-[#EFE5CA] hover:bg-white/10 hover:border-white/20 transition"
            >
              <svg className="ga-nav-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="2.15" strokeLinecap="round">
                <circle cx="11" cy="11" r="5.5" />
                <path d="M15.2 15.2 20 20" />
              </svg>
            </button>
            <NavLink
              to="/settings"
              onMouseEnter={() => preloadRoute('/settings')}
              onFocus={() => preloadRoute('/settings')}
              className="flex h-8 w-8 items-center justify-center rounded-xl border border-white/10 bg-white/6 text-[#EFE5CA] hover:bg-white/10 hover:border-white/20 transition"
              aria-label="系统设置"
              title="系统设置"
            >
              <NavIcon name="settings" />
            </NavLink>
          </>
        ) : (
          <button
            type="button"
            onClick={openCommandPalette}
            className="w-full rounded-xl border border-white/10 bg-white/6 px-2.5 py-1.5 text-left text-xs text-[#EFE5CA] hover:bg-white/10 hover:border-white/20 transition flex items-center justify-between gap-2"
          >
            <span>命令面板</span>
            <kbd className="px-1.5 py-0.5 rounded-md border border-white/12 bg-black/16 font-mono text-[11px] text-[#EFE5CA]/80">Ctrl K</kbd>
          </button>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="折叠/展开导航栏"
          title="折叠/展开导航栏"
          className={clsx(
            'flex items-center rounded-xl border border-white/10 bg-white/6 text-xs text-[#EFE5CA]/90 hover:bg-white/10 hover:border-white/20 transition',
            collapsed ? 'h-8 w-8 justify-center' : 'w-full justify-between px-2.5 py-1.5',
          )}
        >
          <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
          {!collapsed && <span>折叠</span>}
        </button>
      </div>
    </aside>
  )
}
