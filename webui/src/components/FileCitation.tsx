import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
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
  const [busy, setBusy] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const gate = useRef(false)
  const binding = useRef('')
  binding.current = JSON.stringify([sessionId, projectPath, engine, path])
  useEffect(() => { setInfo(null); setMenu(null) }, [path, sessionId, projectPath, engine])
  useOverlayRegistration({
    active: Boolean(menu),
    zIndex: Z_LAYERS.contextMenu,
    getPanel: () => menuRef.current,
    onEscape: () => {
      setMenu(null)
      triggerRef.current?.focus()
    },
    trapFocus: false,
  })
  const resolved = info?.resolved || null
  const parent = resolved ? (info?.is_dir ? resolved : resolved.replace(/[/\\][^/\\]+[/\\]?$/, '')) : null

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
  const item = (label: string, action: () => void, disabled = false) => <button key={label} type="button"
    disabled={disabled} onClick={action}
    className="block w-full break-all px-3 py-1.5 text-left text-sm hover:bg-bg-soft disabled:opacity-40">{label}</button>

  return <>
    <button ref={triggerRef} type="button" className="path-link" disabled={busy}
      title={resolved || path}
      onClick={() => { void reveal() }}
      onContextMenu={event => {
        event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY })
        void resolve().catch(error => toast.error(errorMessageFromError(error, '解析失败')))
      }}>{busy ? '处理中…' : display}</button>
    {menu && createPortal(<>
      <div className="fixed inset-0" style={{ zIndex: Z_LAYERS.contextMenu }} onClick={() => setMenu(null)} />
      <div ref={menuRef} role="menu" tabIndex={-1} className="ga-paper-popover fixed max-h-[70vh] min-w-48 max-w-[90vw] overflow-auto rounded-lg py-1 text-ink focus:outline-none"
        style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 440)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 260)), zIndex: Z_LAYERS.contextMenu + 1 }}>
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
