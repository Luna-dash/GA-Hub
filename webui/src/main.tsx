import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './styles/index.css'
import { installExternalLinkInterceptor } from './utils/openExternal'
import { DesktopRuntimeGate } from './runtime/DesktopRuntimeGate'
import { DesktopChrome } from './components/DesktopChrome'
import { ErrorBoundary } from './components/ErrorBoundary'
import { storageKeys } from './config/storageKeys'
import { initThemeAppearance } from './utils/themeAppearance'

// A production rebuild replaces Vite's hashed lazy-route chunks. An already
// open desktop window can still reference the previous filenames; when that
// happens, reload the no-store index once so its module map matches dist.
const CHUNK_RELOAD_KEY = storageKeys.chunkReloadAt
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const now = Date.now()
  const lastReload = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) || 0)
  if (now - lastReload > 10_000) {
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now))
    window.location.reload()
  }
})

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

// External http(s) links → OS default browser (Tauri opener plugin).
// Prevents WebView2 from navigating away from the SPA with no back UI.
installExternalLinkInterceptor()
initThemeAppearance()

if (typeof document !== 'undefined') {
  const syncPageVisibility = () => {
    if (document.visibilityState === 'hidden') {
      document.documentElement.setAttribute('data-page-hidden', 'true')
    } else {
      document.documentElement.removeAttribute('data-page-hidden')
    }
  }
  syncPageVisibility()
  document.addEventListener('visibilitychange', syncPageVisibility)
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopChrome>
      <DesktopRuntimeGate>
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </BrowserRouter>
        </QueryClientProvider>
      </DesktopRuntimeGate>
    </DesktopChrome>
  </React.StrictMode>,
)
