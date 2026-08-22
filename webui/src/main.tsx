import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import './styles/index.css'
import 'katex/dist/katex.min.css'
import { applyTheme, loadInitialTheme } from './stores/themeStore'
import { installExternalLinkInterceptor } from './utils/openExternal'
import { DesktopRuntimeGate } from './runtime/DesktopRuntimeGate'

// Apply the saved theme synchronously *before* React mounts so the first
// paint matches user preference (no flash of dark on light-preferring
// machines, and vice versa).
applyTheme(loadInitialTheme())

// A production rebuild replaces Vite's hashed lazy-route chunks. An already
// open desktop window can still reference the previous filenames; when that
// happens, reload the no-store index once so its module map matches dist.
const CHUNK_RELOAD_KEY = 'ga-hub:chunk-reload-at'
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopRuntimeGate>
      <QueryClientProvider client={qc}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </DesktopRuntimeGate>
  </React.StrictMode>,
)
