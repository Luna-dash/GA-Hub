import { CitationLink, FileLinkContext, FileTransferConclusion, PathLink, citationUrlTransform } from './FileCitation'
import { addTransferFile, fileTransferQueryKey } from './FileTransferBox'
import { QueryClientContext } from '@tanstack/react-query'
import { PackagePlus } from 'lucide-react'
import { toast } from '@/stores/toastStore'
import { errorMessageFromError } from '@/utils/sessionUi'
// MarkdownView — small wrapper over react-markdown that:
//   1. Tightens spacing for chat bubbles (.prose-chat in styles/index.css)
//   2. Fenced code: language label + hover copy + syntax highlight (rehype-highlight)
//   3. Tables: horizontal scroll wrapper + header styling (CSS)
//   4. Task lists / list layout (CSS + GFM)
//   5. Auto-linkifies file paths that show up in agent prose:
//      • absolute paths ending in a file extension (`/Users/.../foo.py`)
//      • repo-relative paths (`temp/...`, `memory/...`)
//      • `[FILE:path]` markers the agent emits for files it wants the user to open
//      Plain text and path-only inline code are linkified; fenced code blocks
//      remain untouched so scripts are never mangled.
//   6. Math (remark-math + KaTeX) only in mode=chat; single-$ disabled so
//      shell/$var tool dumps are not italicized as formulas. mode=plain|auto
//      keeps tool traces monochrome (GFM only, no highlight/math).
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import katex from 'katex'
import { memo, ReactNode, useContext, useMemo, useState } from 'react'
import { useCopy } from '@/utils/clipboard'
import { looksLikeToolTrace } from '@/utils/toolTrace'
import { renderMarkdownTree } from '@/utils/markdownRenderCache'
import { getRuntimeConfig } from '@/runtime/runtimeConfig'
import { normalizeMathDelimiters } from '@/utils/mathMarkdown'
import { CopyIcon } from './ActionIcons'
// Light paper-ish theme; token colors further tuned under .prose-chat in CSS
import 'highlight.js/styles/github.css'

/** chat = full prose; plain = tool-safe; auto = plain when looksLikeToolTrace. */
export type MarkdownMode = 'chat' | 'plain' | 'auto'

const RASTER_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[a-z0-9+/]+=*$/i

function isAllowedApiImagePath(url: URL): boolean {
  if (url.pathname.startsWith('/api/files/') && url.pathname.length > '/api/files/'.length) {
    return true
  }
  return url.pathname === '/api/files-by-path' && url.search.length > 1
}

/** Allow only Hub file endpoints, blob URLs, and raster base64 images in Markdown. */
export function isAllowedMarkdownImageSrc(src: unknown): src is string {
  if (typeof src !== 'string') return false
  const trimmed = src.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('blob:')) return true
  if (RASTER_DATA_IMAGE_RE.test(trimmed)) return true
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    try {
      return isAllowedApiImagePath(new URL(trimmed, 'http://localhost'))
    } catch {
      return false
    }
  }
  const apiOrigin = getRuntimeConfig().apiOrigin
  if (!apiOrigin) return false
  try {
    const parsed = new URL(trimmed)
    const allowed = new URL(apiOrigin)
    return parsed.origin === allowed.origin && isAllowedApiImagePath(parsed)
  } catch {
    return false
  }
}

function markdownUrlTransform(url: string, key?: string, node?: { tagName?: string }): string {
  if (node?.tagName === 'img' && key === 'src' && isAllowedMarkdownImageSrc(url)) {
    return url.trim()
  }
  return citationUrlTransform(url, key, node)
}

function extractTransferPathFromImageSrc(src: string): string | null {
  try {
    const parsed = new URL(src, 'http://localhost')
    if (parsed.pathname !== '/api/files-by-path') return null
    const path = parsed.searchParams.get('path')?.trim()
    return path || null
  } catch {
    return null
  }
}

function MarkdownTransferImage({ src, alt, title }: { src: string; alt: string; title?: string }) {
  const conclusion = useContext(FileTransferConclusion)
  const { sessionId, project: ctxProject } = useContext(FileLinkContext)
  const cache = useContext(QueryClientContext)
  const [saving, setSaving] = useState(false)
  const transferPath = extractTransferPathFromImageSrc(src)
  const targetSessionId = conclusion?.sessionId ?? sessionId
  const resolvedProject = conclusion?.project ?? ctxProject
  const canTransfer = Boolean(conclusion && targetSessionId && transferPath)

  const img = (
    <img
      src={src}
      alt={alt}
      title={title}
      loading="lazy"
      className={canTransfer
        ? 'block max-h-96 max-w-full rounded-lg border border-line/60 object-contain'
        : 'my-2 max-h-96 max-w-full rounded-lg border border-line/60 object-contain'}
    />
  )

  if (!canTransfer || !conclusion || !targetSessionId || !transferPath) return img

  const saveImage = async () => {
    if (saving) return
    setSaving(true)
    try {
      await addTransferFile({
        path: transferPath,
        engine: conclusion.engine,
        session_id: targetSessionId,
        ...(resolvedProject ? { project: resolvedProject } : {}),
      })
      void cache?.invalidateQueries({ queryKey: fileTransferQueryKey })
      toast.success('已放入中转箱')
    } catch (error) {
      toast.error(errorMessageFromError(error, '放入中转箱失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <span className="group/img relative my-2 inline-block max-w-full">
      {img}
      <button
        type="button"
        disabled={saving}
        title="放入中转箱"
        aria-label="将图片放入中转箱"
        onClick={() => { void saveImage() }}
        className="absolute right-2 top-2 inline-flex h-7 items-center gap-1 rounded-md border border-line bg-bg-card/95 px-2 text-xs font-medium text-ink shadow-sm opacity-0 transition-opacity hover:border-accent hover:text-accent focus-visible:opacity-100 group-hover/img:opacity-100 [@media(hover:none)]:opacity-100 disabled:opacity-50"
      >
        <PackagePlus size={13} strokeWidth={1.85} aria-hidden="true" />
        <span>放入中转箱</span>
      </button>
    </span>
  )
}

const BASE_MD_COMPONENTS = {
  // Wide GFM tables: scroll container (styles in .md-table-wrap)
  table: ({ children, ...props }: any) => (
    <div className="md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
  a: ({ href, children }: any) => <CitationLink href={href}>{children}</CitationLink>,
  img: ({ src, alt, title }: any) => {
    if (!isAllowedMarkdownImageSrc(src)) {
      const label = (typeof alt === 'string' && alt.trim()) || (typeof title === 'string' && title.trim()) || '外链图片已拦截'
      return (
        <span className="inline-block rounded border border-line px-1.5 py-0.5 text-xs text-ink-muted">
          [{label}]
        </span>
      )
    }
    return (
      <MarkdownTransferImage
        src={src.trim()}
        alt={typeof alt === 'string' ? alt : ''}
        title={typeof title === 'string' ? title : undefined}
      />
    )
  },
  // Linkify paths in flowing prose
  p: ({ children }: any) => <p>{linkifyChildren(children)}</p>,
  li: ({ children, className, ...props }: any) => (
    <li className={className} {...props}>{linkifyChildren(children)}</li>
  ),
  td: ({ children }: any) => <td>{linkifyChildren(children)}</td>,
  th: ({ children }: any) => <th>{linkifyChildren(children)}</th>,
  em: ({ children }: any) => <em>{linkifyChildren(children)}</em>,
  strong: ({ children }: any) => <strong>{linkifyChildren(children)}</strong>,
} as const

function renderPlainCode({ children, node, className, ...props }: any) {
  // react-markdown v9 has no `inline` prop. Source positions reliably
  // distinguish one-line inline code from fenced blocks; only turn an inline
  // code span into a button when its complete content is a supported path.
  // Preserve className from rehype-highlight (hljs language-*).
  const text = extractText(children).trim()
  const oneLine = node?.position?.start?.line === node?.position?.end?.line
  const path = oneLine ? matchWholePath(text) : null
  return path
    ? <PathLink path={path} display={text} />
    : <code className={className} {...props}>{children}</code>
}

// Stable component maps. Defined at module scope so React.memo's shallow
// children-equality on <MarkdownView> isn't undermined by ReactMarkdown
// internally seeing a fresh `components` prop on every render.
const MD_COMPONENTS_PLAIN = {
  ...BASE_MD_COMPONENTS,
  pre: ({ children }: any) => <CodeBlock>{children}</CodeBlock>,
  code: renderPlainCode,
} as const

const MD_COMPONENTS_CHAT = {
  ...BASE_MD_COMPONENTS,
  pre: ({ children }: any) => {
    if (hasMathClass(children, 'language-math')) {
      return <MathBlock tex={extractText(children)} />
    }
    return <CodeBlock>{children}</CodeBlock>
  },
  code: (props: any) => {
    const { children, className } = props
    if (classNameContains(className, 'math-inline')) {
      return <MathInline tex={extractText(children)} />
    }
    return renderPlainCode(props)
  },
} as const

// remark-math before gfm: math delimiters should win over GFM punctuation.
// singleDollarTextMath:false — guarded single-$ spans are normalized beforehand
// in normalizeMathDelimiters so shell $VAR / currency $5 stay literal.
const MD_REMARK_CHAT: any[] = [[remarkMath, { singleDollarTextMath: false }], remarkGfm]
const MD_REMARK_PLAIN: any[] = [remarkGfm]
// detect:false (rehype-highlight default): only fenced ```lang blocks colorize.
// Exclude `math` so ```math fenced blocks pass clean TeX to KaTeX.
const MD_REHYPE_CHAT: any[] = [[rehypeHighlight, { detect: false, plainText: ['math'] }]]
const MD_REHYPE_PLAIN: any[] = []

function renderKatexHtml(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      maxSize: 10,
      maxExpand: 1000,
      trust: false,
      errorColor: 'rgb(var(--c-status-danger-rgb))',
    })
  } catch {
    return null
  }
}

function MathInline({ tex }: { tex: string }) {
  const html = renderKatexHtml(tex, false)
  if (html === null) return <code>{tex}</code>
  return <span className="md-math-inline" dangerouslySetInnerHTML={{ __html: html }} />
}

function MathBlock({ tex }: { tex: string }) {
  const html = renderKatexHtml(tex, true)
  if (html === null) return <pre><code>{tex}</code></pre>
  return <div className="md-math-block" dangerouslySetInnerHTML={{ __html: html }} />
}

function classNameContains(cls: unknown, target: string): boolean {
  if (!cls) return false
  const parts = Array.isArray(cls) ? cls : String(cls).split(/\s+/)
  return parts.includes(target)
}

function hasMathClass(node: any, target: string): boolean {
  if (node == null) return false
  if (Array.isArray(node)) return node.some((item) => hasMathClass(item, target))
  return classNameContains(node?.props?.className, target)
}

// Memoized so historical (non-streaming) bubbles don't re-parse markdown
// when an unrelated bubble streams. Combined with chatStore's chat:next
// throttle (≤10 Hz), this keeps the WKWebView renderer below its GPU
// watchdog even on long markdown answers — see the comment in chatStore.ts
// for the failure mode this guards against.
//
// children + mode are primitives, so default shallow comparison is enough:
// equal content/mode skips ReactMarkdown re-parse; streaming bubbles still
// re-render as their content string changes.
export const MarkdownView = memo(function MarkdownView({
  children,
  mode = 'chat',
  cache = true,
}: {
  children: string
  /** Default chat. Use plain/auto for tool folds and code_run dumps. */
  mode?: MarkdownMode
  /** Streaming content changes every chunk and must not enter the LRU. */
  cache?: boolean
}) {
  const resolved: 'chat' | 'plain' =
    mode === 'plain'
      ? 'plain'
      : mode === 'auto'
        ? looksLikeToolTrace(children || '')
          ? 'plain'
          : 'chat'
        : 'chat'

  const raw = children || ''
  const remarkPlugins = resolved === 'chat' ? MD_REMARK_CHAT : MD_REMARK_PLAIN
  const rehypePlugins = resolved === 'chat' ? MD_REHYPE_CHAT : MD_REHYPE_PLAIN
  const components = resolved === 'chat' ? MD_COMPONENTS_CHAT : MD_COMPONENTS_PLAIN
  // Normalize TeX lazily inside the cache miss factory so cache hits skip
  // remark/rehype math-delimiter parsing completely.
  const rendered = useMemo(() => renderMarkdownTree(resolved, raw, () => {
    const normalized = resolved === 'chat' ? normalizeMathDelimiters(raw) : raw
    return {
      children: normalized,
      remarkPlugins,
      rehypePlugins,
      components,
      urlTransform: markdownUrlTransform,
    }
  }, cache), [cache, components, raw, rehypePlugins, remarkPlugins, resolved])

  return (
    <div
      className={
        resolved === 'plain'
          ? 'prose-chat prose-chat--plain min-w-0 max-w-full break-words [overflow-wrap:anywhere]'
          : 'prose-chat min-w-0 max-w-full break-words [overflow-wrap:anywhere]'
      }
    >
      {rendered}
    </div>
  )
})

function CodeBlock({ children }: { children: any }) {
  const { copied, copy } = useCopy()
  const text = extractText(children)
  const lang = extractCodeLang(children)
  return (
    <div className="relative group md-codeblock">
      {(lang || text) && (
        <div className="md-codeblock-bar">
          {lang ? <span className="md-code-lang">{lang}</span> : <span />}
          {text && (
            <button
              type="button"
              onClick={() => copy(text)}
              className="md-code-copy inline-flex items-center gap-1"
              title="复制代码"
            >
              <CopyIcon copied={copied} size={12} />
              <span>{copied ? '已复制' : '复制'}</span>
            </button>
          )}
        </div>
      )}
      <pre>{children}</pre>
    </div>
  )
}

function extractText(node: any): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  if (node?.props?.children) return extractText(node.props.children)
  return ''
}

/** language-foo / lang-foo from fenced code className (rehype-highlight). */
function extractCodeLang(node: any): string {
  if (node == null) return ''
  if (Array.isArray(node)) {
    for (const c of node) {
      const l = extractCodeLang(c)
      if (l) return l
    }
    return ''
  }
  const cls = node?.props?.className
  const s = Array.isArray(cls) ? cls.join(' ') : String(cls || '')
  const m = s.match(/(?:language|lang)-([a-zA-Z0-9_+-]+)/)
  if (m) return m[1].toLowerCase()
  if (node?.props?.children) return extractCodeLang(node.props.children)
  return ''
}

// ── path auto-linking ──────────────────────────────────────────────
// Three families of matches we care about (alternation order matters —
// `[FILE:...]` is most specific, then absolute paths, then relative paths):
//   1. [FILE:/abs/path] or [FILE:rel/path]  → strip wrapper, link the inner
//   2. absolute paths such as /a/b/c.ext or C:\a\b\c.ext
//   3. relative paths with a directory and extension, such as temp/a.png
const PATH_RE =
  /\[FILE:\s*([^\]\r\n]*?\S)\s*\]|((?:(?:[A-Za-z]:[\\/])|\/)[\w.\\/\-+@]+\.[A-Za-z0-9]{1,8})|((?:[\w.\-+@]+[\\/])+[\w.\-+@]+\.[A-Za-z0-9]{1,8})/g

/** Return the underlying path only when the complete string is a path marker/path. */
function matchWholePath(text: string): string | null {
  PATH_RE.lastIndex = 0
  const match = PATH_RE.exec(text)
  const path = match && match.index === 0 && match[0].length === text.length
    ? (match[1] || match[2] || match[3] || match[0]).trim()
    : null
  PATH_RE.lastIndex = 0
  return path
}

function linkifyChildren(children: ReactNode): ReactNode {
  return mapChildren(children, linkifyString)
}

/** Walk react children; replace any string node by linkifyString's output. */
function mapChildren(node: ReactNode, fn: (s: string) => ReactNode): ReactNode {
  if (typeof node === 'string') return fn(node)
  if (Array.isArray(node)) return node.map((c, i) => <Frag key={i}>{mapChildren(c, fn)}</Frag>)
  return node
}

function Frag({ children }: { children: ReactNode }) {
  // Tiny key-stable wrapper. We avoid <></> here so React keys propagate cleanly.
  return <>{children}</>
}

function linkifyString(s: string): ReactNode {
  if (!s || !PATH_RE.test(s)) return s
  PATH_RE.lastIndex = 0  // reset stateful flag from the test() above
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let idx = 0
  while ((m = PATH_RE.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const path = (m[1] || m[2] || m[3] || m[0]).trim()
    out.push(
      <PathLink key={`p-${idx++}-${m.index}`} path={path} display={m[1] ? path : m[0]} />,
    )
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
