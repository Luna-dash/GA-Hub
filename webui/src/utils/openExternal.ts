/**
 * Open http(s) URLs outside the embedded WebView so the SPA is never replaced.
 * Prefer pywebview js_api (default OS browser); fall back to window.open / <a>.
 */

export function isHttpUrl(href: string | null | undefined): boolean {
  if (!href) return false
  try {
    const u = new URL(href, window.location.href)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Same-origin app routes stay in the WebView (SPA). */
export function isAppInternalUrl(href: string): boolean {
  try {
    const u = new URL(href, window.location.href)
    if (u.origin !== window.location.origin) return false
    // backend API / docs / static still "internal" to hub host
    return true
  } catch {
    return false
  }
}

/**
 * External = different origin http(s). Open in OS default browser.
 * Returns true if we handled (caller should preventDefault).
 */
export function openExternalIfNeeded(href: string | null | undefined): boolean {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false
  if (!isHttpUrl(href)) return false
  if (isAppInternalUrl(href)) return false

  const url = new URL(href, window.location.href).href

  const api = window.pywebview?.api
  if (api && typeof api.open_url === 'function') {
    try {
      void Promise.resolve(api.open_url(url)).catch(() => {
        fallbackOpen(url)
      })
      return true
    } catch {
      /* fall through */
    }
  }

  fallbackOpen(url)
  return true
}

function fallbackOpen(url: string) {
  try {
    const w = window.open(url, '_blank', 'noopener,noreferrer')
    if (w) return
  } catch {
    /* ignore */
  }
  const a = document.createElement('a')
  a.href = url
  a.target = '_blank'
  a.rel = 'noopener noreferrer'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Capture-phase listener: any external <a> click → OS browser. */
export function installExternalLinkInterceptor(): () => void {
  const onClick = (ev: MouseEvent) => {
    if (ev.defaultPrevented) return
    if (ev.button !== 0) return
    if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return
    const t = ev.target as Element | null
    const a = t?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href')
    if (openExternalIfNeeded(href)) {
      ev.preventDefault()
      ev.stopPropagation()
    }
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
