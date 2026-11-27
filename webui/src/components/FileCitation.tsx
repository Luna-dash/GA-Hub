import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { QueryClientContext } from '@tanstack/react-query'
import { addTransferFile, fileTransferQueryKey } from './FileTransferBox'
import { useInRouterContext } from 'react-router-dom'
import { GuardedLink } from './GuardedLink'
import { defaultUrlTransform } from 'react-markdown'
import { api } from '@/api/client'
import { toast } from '@/stores/toastStore'
import { writeClipboard } from '@/utils/clipboard'
import { errorMessageFromError } from '@/utils/sessionUi'
import { isAppInternalUrl, isHttpUrl, openExternalIfNeeded } from '@/utils/openExternal'
import { Z_LAYERS } from '@/config/zLayers'
import { APP_PAGES } from '@/config/pages'
import { useOverlayRegistration } from '@/hooks/useOverlayRegistration'
import { restoreOverlayFocus } from '@/utils/overlayStack'

export const FileLinkContext = createContext<{ sessionId?: string; projectPath?: string; project?: string; engine?: 'chat' | 'anti' }>({})
export const FileTransferConclusion = createContext<{ engine: 'chat' | 'anti'; sessionId?: string; project?: string } | null>(null)
const APP_ROUTE = new RegExp(
  `^/(?:${APP_PAGES.map((page) => page.id).join('|')})(?:[/?#]|$)`,
)

export function isLocalCitation(target: string): boolean {
  if (!target || target.startsWith('#') || APP_ROUTE.test(target) || /^\/api\/(?:files(?:\/|\?|$)|files-by-path(?:\?|$))/.test(target)) return false
  if (/^(?:https?:|mailto:|tel:|data:)/i.test(target)) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^(?:file:|[a-z]:[\\/])/i.test(target)) return false
  return /^(?:file:|[a-z]:[\\/]|\\\\|\/|\.\.?[\\/])/i.test(target) || /[\\/]/.test(target) || /\.[^/\\:?#]+(?:[?#].*)?$/.test(target)
}

// Preserve local citations only on anchor hrefs before react-markdown filters
// drive letters; other elements/attributes still pass through defaultUrlTransform.
export const citationUrlTransform = (
  url: string,
  key?: string,
  node?: { tagName?: string },
) => (node?.tagName === 'a' && key === 'href' && isLocalCitation(url)) ? url : defaultUrlTransform(url)

// Markdown hrefs are URLs, unlike raw [FILE:...] paths. Decode once here;
// file: URLs keep their explicit decoding boundary in the backend resolver.
function citationPathFromUrl(url: string): string {
  if (/^file:/i.test(url)) return url
  try { return decodeURIComponent(url) }
  catch { return url }
}

export function CitationLink({ href, children }: { href?: string; children: ReactNode }) {
  const inRouter = useInRouterContext()
  const target = href?.trim() || ''
  if (!target) return <>{children}</>
  if (isLocalCitation(target)) return <PathLink path={citationPathFromUrl(target)} display={children} />
  if (APP_ROUTE.test(target) && inRouter) return <GuardedLink to={target}>{children}</GuardedLink>
  return <a href={target} target={target.startsWith('/api/files') ? '_blank' : undefined} rel="noopener noreferrer" onClick={(event) => {
    if (isHttpUrl(target) && !isAppInternalUrl(target)) {
      event.preventDefault()
      void openExternalIfNeeded(target).catch(error => toast.error(errorMessageFromError(error, '打开链接失败')))
    }
  }}>{children}</a>
}

type PathInfo = Awaited<ReturnType<typeof api.resolveFile>>
const pendingPaths = new Map<string, Promise<PathInfo>>()
const pendingActions = new Map<string, Promise<unknown>>()

function lookup(path: string, sessionId?: string, projectPath?: string, engine?: 'chat' | 'anti'): Promise<PathInfo> {
  const key = JSON.stringify([sessionId, projectPath, engine, path])
  const pending = pendingPaths.get(key)
  if (pending) return pending
  const task = (engine === 'anti' ? api.resolveFile(path, sessionId, engine) : api.resolveFile(path, sessionId)).finally(() => pendingPaths.delete(key))
  pendingPaths.set(key, task)
  return task
}

export function PathLink({ path, display }: { path: string; display: ReactNode }) {
  const { sessionId, projectPath, engine } = useContext(FileLinkContext)
  const conclusion = useContext(FileTransferConclusion)
  const cache = useContext(QueryClientContext)
  const transferSessionId = conclusion?.sessionId ?? sessionId
  const [info, setInfo] = useState<PathInfo | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const gate = useRef(false)
  const binding = useRef('')
  binding.current = JSON.stringify([sessionId, projectPath, engine, path])
  useEffect(() => { setInfo(null); setMenu(null) }, [path, sessionId, projectPath, engine])
  const closeMenu = useCallback((restoreFocus = false) => {
    setMenu(null)
    if (restoreFocus) restoreOverlayFocus(triggerRef.current)
  }, [])
  useOverlayRegistration({
    active: Boolean(menu),
    zIndex: Z_LAYERS.contextMenu + 1,
    getPanel: () => menuRef.current,
    onEscape: () => closeMenu(true),
    trapFocus: false,
  })
  const resolved = info?.resolved || null
  const parent = resolved ? (info?.is_dir ? resolved : resolved.replace(/[/\\][^/\\]+[/\\]?$/, '')) : null

  useLayoutEffect(() => {
    if (!menu) { setMenuPos(null); return }
    const panel = menuRef.current
    if (!panel) return
    const rect = panel.getBoundingClientRect()
    const pad = 8
    const width = rect.width || 240
    const height = rect.height || 180
    const maxLeft = Math.max(pad, window.innerWidth - width - pad)
    const maxTop = Math.max(pad, window.innerHeight - height - pad)
    setMenuPos({
      left: Math.max(pad, Math.min(menu.x, maxLeft)),
      top: Math.max(pad, Math.min(menu.y, maxTop)),
    })
  }, [menu, info, resolved])

  useEffect(() => {
    if (!menu) return
    const panel = menuRef.current
    if (!panel) return
    const firstEnabled = panel.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')
    if (firstEnabled) {
      if (!panel.contains(document.activeElement) || document.activeElement === panel) {
        firstEnabled.focus()
      }
    } else if (!panel.contains(document.activeElement)) {
      panel.focus()
    }
  }, [menu, info, resolved, busy])

  const resolve = async () => {
    const key = binding.current
    const result = await lookup(path, sessionId, projectPath, engine)
    if (key !== binding.current) throw new Error('项目已切换，请重新点击')
    setInfo(result)
    return result
  }
  const reveal = async (mode: 'open' | 'folder' = 'open', chosen?: string) => {
    if (gate.current) return
    gate.current = true; setBusy(true)
    try {
      const result = chosen ? null : await resolve()
      const target = chosen || result?.resolved
      if (!target) { setMenu({ x: 24, y: 80 }); return }
      const key = JSON.stringify([target, mode])
      let task = pendingActions.get(key)
      if (!task) {
        task = api.revealFile(target, mode).finally(() => pendingActions.delete(key))
        pendingActions.set(key, task)
      }
      await task
      setMenu(null)
    } catch (error) { toast.error(errorMessageFromError(error, '文件操作失败')) }
    finally { gate.current = false; setBusy(false) }
  }
  const addToTransferBox = async () => {
    if (!conclusion || !transferSessionId || !resolved || info?.is_dir || gate.current) return
    gate.current = true; setBusy(true)
    try {
      await addTransferFile({ path: resolved, engine: conclusion.engine, session_id: transferSessionId, project: conclusion.project })
      void cache?.invalidateQueries({ queryKey: fileTransferQueryKey })
      toast.success('已放入中转箱')
      setMenu(null)
    } catch (error) { toast.error(errorMessageFromError(error, '放入中转箱失败')) }
    finally { gate.current = false; setBusy(false) }
  }
  const copy = async (value: string, label: string) => {
    try {
      if (!await writeClipboard(value)) throw new Error(`复制${label}失败`)
      toast.success(`已复制${label}`)
    }
    catch (error) { toast.error(errorMessageFromError(error, `复制${label}失败`)) }
    finally { setMenu(null) }
  }
  const openMenuAt = (x: number, y: number) => {
    setMenu({ x, y })
    void resolve().catch(error => toast.error(errorMessageFromError(error, '解析失败')))
  }
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      closeMenu(false)
      return
    }
    const panel = menuRef.current
    if (!panel) return
    const items = Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])'))
    if (items.length === 0) return
    const currentIndex = items.findIndex((element) => element === document.activeElement)
    let nextIndex = -1
    if (event.key === 'ArrowDown') nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : 0
    else if (event.key === 'ArrowUp') nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : items.length - 1
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = items.length - 1
    if (nextIndex !== -1) {
      event.preventDefault()
      items[nextIndex].focus()
    }
  }
  const item = (label: string, action: () => void, disabled = false) => <button key={label} type="button" role="menuitem" tabIndex={-1}
    disabled={disabled} onClick={action}
    className="block w-full break-all px-3 py-1.5 text-left text-sm hover:bg-bg-soft focus:bg-bg-soft focus:outline-none disabled:opacity-40">{label}</button>

  const fallbackLeft = menu ? Math.max(8, Math.min(menu.x, window.innerWidth - 240)) : 8
  const fallbackTop = menu ? Math.max(8, Math.min(menu.y, window.innerHeight - 180)) : 8

  return <>
    <button ref={triggerRef} type="button" className="path-link" disabled={busy}
      title={resolved || path}
      aria-haspopup="menu"
      aria-expanded={Boolean(menu)}
      onClick={() => { void reveal() }}
      onKeyDown={event => {
        if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          openMenuAt(rect.left, rect.bottom + 4)
        }
      }}
      onContextMenu={event => {
        event.preventDefault()
        openMenuAt(event.clientX, event.clientY)
      }}>{busy ? '处理中…' : display}</button>
    {menu && createPortal(<>
      <div className="fixed inset-0" style={{ zIndex: Z_LAYERS.contextMenu }} onClick={() => closeMenu(false)} />
      <div ref={menuRef} role="menu" tabIndex={-1} onKeyDown={handleMenuKeyDown} className="ga-paper-popover fixed max-h-[70vh] min-w-48 max-w-[90vw] overflow-auto rounded-lg py-1 text-ink focus:outline-none"
        style={{ left: menuPos?.left ?? fallbackLeft, top: menuPos?.top ?? fallbackTop, zIndex: Z_LAYERS.contextMenu + 1 }}>
        <div className="px-3 py-1 text-xs break-all">匹配范围：{info?.scope || projectPath || '未绑定项目'}</div>
        {info && !resolved && <div className="px-3 py-1 text-sm">{info.incomplete ? '搜索达到预算或部分目录不可读，结果未完整；请选择明确路径' : info.ambiguous ? '存在多个匹配，请选择' : '未找到文件，请使用完整路径'}</div>}
        {!resolved && info?.candidates?.map(candidate => item(candidate, () => { void reveal('open', candidate) }, busy))}
        {item(info?.is_dir ? '打开文件夹' : '定位文件', () => { void reveal('open', resolved!) }, busy || !resolved)}
        {item('在资源管理器中显示', () => { void reveal('folder', resolved!) }, busy || !resolved)}
        {conclusion && transferSessionId && !info?.is_dir && item('放入中转箱', () => { void addToTransferBox() }, busy || !resolved)}
        {item('复制完整路径', () => { void copy(resolved!, '完整路径') }, !resolved)}
        {item('复制所在文件夹', () => { void copy(parent!, '文件夹路径') }, !parent)}
      </div>
    </>, document.body)}
  </>
}
