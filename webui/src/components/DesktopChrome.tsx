import { useEffect, useState, type ReactNode } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Z_LAYERS } from '@/config/zLayers'
import './DesktopChrome.css'

/** Outside the runtime gate: window controls must survive backend failure. */
export function DesktopChrome({ children }: { children: ReactNode }) {
  const desktop = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
  const [maximized, setMaximized] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!desktop) return
    const appWindow = getCurrentWindow()
    let disposed = false
    const unlisten: Array<() => void> = []
    const sync = () => {
      void appWindow.isMaximized().then(value => {
        if (!disposed) setMaximized(value)
      }).catch(() => { /* A later resize/focus event retries the query. */ })
    }
    sync()
    for (const subscribe of [appWindow.onResized.bind(appWindow), appWindow.onFocusChanged.bind(appWindow)]) {
      void subscribe(sync).then(stop => {
        if (disposed) stop()
        else unlisten.push(stop)
      }).catch(() => { /* Controls still work if event registration fails. */ })
    }
    return () => {
      disposed = true
      unlisten.forEach(stop => stop())
    }
  }, [desktop])

  if (!desktop) return <>{children}</>

  const run = (operation: () => Promise<unknown>) => {
    setError('')
    void operation().catch(cause => {
      console.error('Desktop window control failed', cause)
      setError('窗口操作失败，请重试')
    })
  }
  const toggleMaximize = () => run(async () => {
    const appWindow = getCurrentWindow()
    await appWindow.toggleMaximize()
    setMaximized(await appWindow.isMaximized())
  })

  return (
    <div className="ga-desktop-frame" onMouseDown={event => {
      const target = event.target as HTMLElement
      if (event.button !== 0 || target.closest('button, a, input, textarea, select, [role="button"], [role="combobox"], [role="menu"], [role="dialog"], [contenteditable="true"], [data-no-window-drag]')) return
      if (!target.closest('.ga-page-header, .ga-sidebar-brand-row, .ga-desktop-drag')) return
      event.preventDefault()
      if (event.detail === 2) toggleMaximize()
      else run(() => getCurrentWindow().startDragging())
    }}>
      <div className="ga-desktop-titlebar" style={{ zIndex: Z_LAYERS.chrome }} aria-label="窗口标题栏">
        <div
          className="ga-desktop-drag"
          aria-label="拖动窗口，双击最大化或还原"
        >
        </div>
        {error && <span role="status" className="ga-desktop-window-error">{error}</span>}
        <div className="ga-desktop-controls" role="group" aria-label="窗口控制">
          <button type="button" aria-label="最小化" title="最小化" onClick={() => run(() => getCurrentWindow().minimize())}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5h10" /></svg>
          </button>
          <button type="button" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={toggleMaximize}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              {maximized ? <path d="M5.5 5.5v-2h7v7h-2m-7-5h7v7h-7z" /> : <rect x="3.5" y="3.5" width="9" height="9" />}
            </svg>
          </button>
          <button type="button" className="ga-desktop-close" aria-label="关闭窗口" title="关闭窗口" onClick={() => run(() => getCurrentWindow().close())}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" /></svg>
          </button>
        </div>
      </div>
      <div className="ga-desktop-content">{children}</div>
    </div>
  )
}
