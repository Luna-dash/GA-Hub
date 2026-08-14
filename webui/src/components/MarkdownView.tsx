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
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { memo, ReactNode, useMemo, type MouseEvent } from 'react'
import { useCopy } from '@/utils/clipboard'
import { api } from '@/api/client'
import { isAppInternalUrl, isHttpUrl, openExternalIfNeeded } from '@/utils/openExternal'
import { looksLikeToolTrace } from '@/utils/toolTrace'
// Light paper-ish theme; token colors further tuned under .prose-chat in CSS
import 'highlight.js/styles/github.css'

/** chat = full prose; plain = tool-safe; auto = plain when looksLikeToolTrace. */
export type MarkdownMode = 'chat' | 'plain' | 'auto'

// Stable component map. Defined at module scope so React.memo's shallow
// children-equality on <MarkdownView> isn't undermined by ReactMarkdown
// internally seeing a fresh `components` prop on every render.
const MD_COMPONENTS = {
  // Attach lang chip + copy to fenced code blocks
  pre: ({ children }: any) => <CodeBlock>{children}</CodeBlock>,
  // Wide GFM tables: scroll container (styles in .md-table-wrap)
  table: ({ children, ...props }: any) => (
    <div className="md-table-wrap">
      <table {...props}>{children}</table>
    </div>
  ),
  // External http(s) → OS browser; same-origin stays in WebView.
  a: ({ href, children, ...props }: any) => (
    <a
      href={href}
      {...props}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        if (href !== null && isHttpUrl(href) && !isAppInternalUrl(href)) {
          void openExternalIfNeeded(href).catch(() => undefined)
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      {children}
    </a>
  ),
  // Linkify paths in flowing prose
  p: ({ children }: any) => <p>{linkifyChildren(children)}</p>,
  li: ({ children, className, ...props }: any) => (
    <li className={className} {...props}>{linkifyChildren(children)}</li>
  ),
  td: ({ children }: any) => <td>{linkifyChildren(children)}</td>,
  th: ({ children }: any) => <th>{linkifyChildren(children)}</th>,
  em: ({ children }: any) => <em>{linkifyChildren(children)}</em>,
  strong: ({ children }: any) => <strong>{linkifyChildren(children)}</strong>,
  // react-markdown v9 has no `inline` prop. Source positions reliably
  // distinguish one-line inline code from fenced blocks; only turn an inline
  // code span into a button when its complete content is a supported path.
  // Preserve className from rehype-highlight (hljs language-*).
  code: ({ children, node, className, ...props }: any) => {
    const text = extractText(children).trim()
    const oneLine = node?.position?.start?.line === node?.position?.end?.line
    const path = oneLine ? matchWholePath(text) : null
    return path
      ? <PathLink path={path} display={text} />
      : <code className={className} {...props}>{children}</code>
  },
} as const

// remark-math before gfm: math delimiters should win over GFM punctuation.
// singleDollarTextMath:false — bare $var / PowerShell must not become KaTeX.
const MD_REMARK_CHAT: any[] = [[remarkMath, { singleDollarTextMath: false }], remarkGfm]
const MD_REMARK_PLAIN: any[] = [remarkGfm]
// detect:false (rehype-highlight default): only fenced ```lang blocks colorize.
const MD_REHYPE_CHAT: any[] = [[rehypeHighlight, { detect: false }], rehypeKatex]
const MD_REHYPE_PLAIN: any[] = []

/**
 * Models often emit TeX delimiters `\\(...\\)` / `\\[...\\]` (and
 * `\\\\(...\\\\)` after JSON escaping) instead of `$$...$$`.
 * remark-math only understands dollar delimiters, so normalize first.
 * With single-$ disabled we always map to `$$` (display), never `$...$`,
 * so shell variables cannot be reintroduced as false inline math.
 * Skip fenced code blocks so shell/python snippets stay intact.
 */
function normalizeMathDelimiters(src: string): string {
  if (!src || !/[\\$]/.test(src)) return src
  const parts = src.split(/(```[\s\S]*?```)/g)
  return parts
    .map((part) => {
      if (part.startsWith('```')) return part
      // Display: \[ ... \]  (allow optional whitespace)
      let s = part.replace(/\\\[((?:.|\n)*?)\\\]/g, (_m, body: string) => {
        const t = body.trim()
        return t ? `\n$$\n${t}\n$$\n` : _m
      })
      // Inline-ish: \( ... \) → $$ (safe under singleDollarTextMath:false)
      s = s.replace(/\\\(((?:.|\n)*?)\\\)/g, (_m, body: string) => {
        const t = body.trim()
        if (!t) return _m
        return `\n$$\n${t}\n$$\n`
      })
      return s
    })
    .join('')
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
}: {
  children: string
  /** Default chat. Use plain/auto for tool folds and code_run dumps. */
  mode?: MarkdownMode
}) {
  const resolved: 'chat' | 'plain' =
    mode === 'plain'
      ? 'plain'
      : mode === 'auto'
        ? looksLikeToolTrace(children || '')
          ? 'plain'
          : 'chat'
        : 'chat'

  // Normalize TeX only in chat mode; plain keeps $ and backslashes literal.
  const text = useMemo(() => {
    const raw = children || ''
    return resolved === 'chat' ? normalizeMathDelimiters(raw) : raw
  }, [children, resolved])

  const remarkPlugins = resolved === 'chat' ? MD_REMARK_CHAT : MD_REMARK_PLAIN
  const rehypePlugins = resolved === 'chat' ? MD_REHYPE_CHAT : MD_REHYPE_PLAIN

  return (
    <div
      className={
        resolved === 'plain'
          ? 'prose-chat prose-chat--plain min-w-0 max-w-full break-words [overflow-wrap:anywhere]'
          : 'prose-chat min-w-0 max-w-full break-words [overflow-wrap:anywhere]'
      }
    >
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={MD_COMPONENTS}
      >
        {text}
      </ReactMarkdown>
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
              className="md-code-copy"
              title="复制代码"
            >
              {copied ? '✓ 已复制' : '复制'}
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
  /\[FILE:([^\]\s]+)\]|((?:(?:[A-Za-z]:[\\/])|\/)[\w.\\/\-+@]+\.[A-Za-z0-9]{1,8})|((?:[\w.\-+@]+[\\/])+[\w.\-+@]+\.[A-Za-z0-9]{1,8})/g

/** Return the underlying path only when the complete string is a path marker/path. */
function matchWholePath(text: string): string | null {
  PATH_RE.lastIndex = 0
  const match = PATH_RE.exec(text)
  const path = match && match.index === 0 && match[0].length === text.length
    ? (match[1] || match[2] || match[3] || match[0])
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
    const path = m[1] || m[2] || m[3] || m[0]
    out.push(
      <PathLink key={`p-${idx++}-${m.index}`} path={path} display={m[1] ? path : m[0]} />,
    )
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

function PathLink({ path, display }: { path: string; display: string }) {
  const reveal = async () => {
    try {
      await api.revealFile(path)
    } catch (err) {
      window.alert(err instanceof Error ? err.message : `无法定位 ${path}`)
    }
  }
  return (
    <button
      type="button"
      onClick={reveal}
      className="inline-flex items-baseline gap-0.5 text-accent hover:underline break-all text-left"
      title={`打开文件 ${path}`}
    >
      <span aria-hidden className="text-[0.75em] opacity-70">📄</span>
      <span className="font-mono text-[0.9em]">{display}</span>
    </button>
  )
}
