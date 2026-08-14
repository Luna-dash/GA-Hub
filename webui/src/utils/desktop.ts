/**
 * Desktop integration helpers. Tauri is the production shell; pywebview is
 * retained only as the documented source-checkout recovery path.
 */
import { openUrl } from '@tauri-apps/plugin-opener'

export interface DesktopDirectorySelection {
  ok: boolean
  path?: string
  cancelled?: boolean
  error?: string
}

export interface DesktopExportResult {
  ok: boolean
  path?: string
  cancelled?: boolean
  error?: string
}

/** True only inside the Tauri desktop shell. */
export function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** True in either supported desktop shell; used for affordance messaging. */
export function isDesktopShell(): boolean {
  return isTauriDesktop() || Boolean(window.pywebview?.api)
}

/** Open an http(s) URL with the OS handler without leaving the WebView. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriDesktop()) {
    await openUrl(url)
    return
  }

  const bridge = window.pywebview?.api
  if (typeof bridge?.open_url === 'function') {
    await bridge.open_url(url)
    return
  }

  fallbackOpen(url)
}

/** Select a directory through the current desktop shell. */
export async function selectDirectory(): Promise<DesktopDirectorySelection> {
  if (isTauriDesktop()) {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ directory: true, multiple: false })
    if (selected === null) return { ok: false, cancelled: true }
    return { ok: true, path: selected }
  }

  const bridge = window.pywebview?.api
  if (typeof bridge?.select_directory === 'function') {
    const result = await bridge.select_directory()
    return normalizeDesktopResult(result)
  }

  return { ok: false, error: 'not-desktop' }
}

/** Save text through the current desktop shell, with a browser fallback. */
export async function saveTextExport(
  filename: string,
  content: string,
): Promise<DesktopExportResult> {
  if (isTauriDesktop()) {
    const extension = filename.split('.').at(-1)?.toLowerCase() ?? ''
    const filterName = extension === 'md' ? 'Markdown' : extension === 'json' ? 'JSON' : 'All files'
    const filters = extension
      ? [{ name: filterName, extensions: [extension] }]
      : undefined
    const { save } = await import('@tauri-apps/plugin-dialog')
    const target = await save({ defaultPath: filename, filters })
    if (!target) return { ok: false, cancelled: true }

    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('save_text_export', { target, contents: content })
    return { ok: true, path: target }
  }

  const bridge = window.pywebview?.api
  if (typeof bridge?.save_export === 'function') {
    const result = await bridge.save_export(filename, content)
    return normalizeDesktopResult(result)
  }

  fallbackDownload(filename, content)
  return { ok: true }
}

function normalizeDesktopResult(result: unknown): DesktopExportResult {
  if (typeof result !== 'object' || result === null) {
    return { ok: false, error: 'invalid-desktop-result' }
  }

  const value = result as Partial<DesktopExportResult>
  return {
    ok: Boolean(value.ok),
    path: typeof value.path === 'string' ? value.path : undefined,
    cancelled: Boolean(value.cancelled),
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

function fallbackOpen(url: string): void {
  const opened = window.open(url, '_blank', 'noopener,noreferrer')
  if (opened) return

  const anchor = document.createElement('a')
  anchor.href = url
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

function fallbackDownload(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
