// MarkdownView — small wrapper over react-markdown that:
//   1. Tightens spacing for chat bubbles (.prose-chat in styles/index.css)
//   2. Adds a hover "复制" button to every fenced code block (handy for
//      the agent's frequent shell / python output)
//   3. Auto-linkifies file paths that show up in agent prose:
//      • absolute paths ending in a file extension (`/Users/.../foo.py`)
//      • repo-relative paths (`temp/...`, `memory/...`)
//      • `[FILE:path]` markers the agent emits for files it wants the user to open
//      Code (fenced or inline) is left untouched so we don't mangle scripts.
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ReactNode } from 'react'
import { useCopy } from '@/utils/clipboard'
import { api } from '@/api/client'

export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="prose-chat max-w-none break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Attach copy chip to fenced code blocks
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          // Linkify paths in flowing prose
          p: ({ children }) => <p>{linkifyChildren(children)}</p>,
          li: ({ children }) => <li>{linkifyChildren(children)}</li>,
          td: ({ children }) => <td>{linkifyChildren(children)}</td>,
          th: ({ children }) => <th>{linkifyChildren(children)}</th>,
          em: ({ children }) => <em>{linkifyChildren(children)}</em>,
          strong: ({ children }) => <strong>{linkifyChildren(children)}</strong>,
          // Don't touch <code>; leave inline + block code alone.
        }}
      >
        {children || ''}
      </ReactMarkdown>
    </div>
  )
}

function CodeBlock({ children }: { children: any }) {
  const { copied, copy } = useCopy()
  const text = extractText(children)
  return (
    <div className="relative group">
      <pre>{children}</pre>
      {text && (
        <button
          onClick={() => copy(text)}
          className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[11px] rounded
                     bg-bg-soft/80 backdrop-blur border border-line text-slate-400
                     opacity-0 group-hover:opacity-100 transition hover:text-slate-200"
          title="复制代码"
        >
          {copied ? '✓ 已复制' : '复制'}
        </button>
      )}
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

// ── path auto-linking ──────────────────────────────────────────────
// Three families of matches we care about (alternation order matters —
// `[FILE:...]` is most specific, then absolute paths, then prefixed
// relative ones):
//   1. [FILE:/abs/path] or [FILE:rel/path]  → strip wrapper, link the inner
//   2. absolute paths /a/b/c.ext (4-letter ext max, common chars only)
//   3. temp/... or memory/... relative paths
const PATH_RE =
  /\[FILE:([^\]\s]+)\]|((?:\/[\w.\-+@]+){2,}\.[A-Za-z0-9]{1,8})|((?:temp|memory)\/[\w./\-+@]+)/g

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
  // Best-effort: backend serves anything under temp/ or admin uploads/, so
  // for absolute paths this works; for relative ones we let the backend
  // try (it may 403 if the path resolves outside allowed roots — that's
  // visible feedback enough to be useful).
  const href = api.fileUrlByPath(path)
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-baseline gap-0.5 text-accent hover:underline break-all"
      title={`打开 ${path}`}
    >
      <span aria-hidden className="text-[0.75em] opacity-70">📄</span>
      <span className="font-mono text-[0.9em]">{display}</span>
    </a>
  )
}
