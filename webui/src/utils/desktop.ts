/**
 * Desktop integration helpers. Tauri is the production shell and the only
 * desktop entry; plain browser mode falls back to standard web behavior.
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

/**
 * Ask the Tauri shell to stop and respawn the Python sidecar in place.
 * Port/instance-token stay identical, so the SPA can simply re-poll and reload.
 */
export async function restartDesktopBackend(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('restart_backend')
}

/** Open an http(s) URL with the OS handler without leaving the WebView. */
export async function openExternalUrl(url: string): Promise<void> {
  if (isTauriDesktop()) {
    await openUrl(url)
    return
  }
  fallbackOpen(url)
}

/** Select a directory through the desktop shell's native dialog. */
export async function selectDirectory(): Promise<DesktopDirectorySelection> {
  if (!isTauriDesktop()) return { ok: false, error: 'not-desktop' }
  const { open } = await import('@tauri-apps/plugin-dialog')
  const selected = await open({ directory: true, multiple: false })
  if (selected === null) return { ok: false, cancelled: true }
  return { ok: true, path: selected }
}

/** Save text through the desktop shell's native save dialog. */
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

  fallbackDownload(filename, content)
  return { ok: true }
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
