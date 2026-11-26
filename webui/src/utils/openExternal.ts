/**
 * Open http(s) URLs outside the embedded WebView so the SPA is never replaced.
 * Open through the desktop shell's native handler.
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
    return new URL(href, window.location.href).origin === window.location.origin
  } catch {
    return false
  }
}

let desktopModulePromise: Promise<typeof import('./desktop')> | null = null

function loadDesktopModule() {
  if (!desktopModulePromise) {
    desktopModulePromise = import('./desktop').catch((error) => {
      desktopModulePromise = null
      throw error
    })
  }
  return desktopModulePromise
}

/**
 * External = different origin http(s). Open in OS default browser.
 * Returns true if we handled (caller should preventDefault).
 */
export async function openExternalIfNeeded(href: string | null | undefined): Promise<boolean> {
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return false
  if (!isHttpUrl(href)) return false
  if (isAppInternalUrl(href)) return false

  const url = new URL(href, window.location.href).href

  const { openExternalUrl } = await loadDesktopModule()
  await openExternalUrl(url)
  return true
}

/** Capture-phase listener: any external <a> click/auxclick → OS browser. */
export function installExternalLinkInterceptor(): () => void {
  const isDesktopShell = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  const onPointerOpen = (ev: MouseEvent) => {
    if (ev.defaultPrevented) return
    const isAuxClick = ev.type === 'auxclick'
    if (isAuxClick ? ev.button !== 1 : ev.button !== 0) return
    // Browser mode lets modifier/middle clicks open tabs natively; desktop WebView must trap them.
    if (!isDesktopShell() && (isAuxClick || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey)) return
    const t = ev.target as Element | null
    const a = t?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.getAttribute('href')
    if (href !== null && isHttpUrl(href) && !isAppInternalUrl(href)) {
      void openExternalIfNeeded(href).catch(() => undefined)
      ev.preventDefault()
      ev.stopPropagation()
    }
  }
  document.addEventListener('click', onPointerOpen, true)
  document.addEventListener('auxclick', onPointerOpen, true)
  return () => {
    document.removeEventListener('click', onPointerOpen, true)
    document.removeEventListener('auxclick', onPointerOpen, true)
  }
}
