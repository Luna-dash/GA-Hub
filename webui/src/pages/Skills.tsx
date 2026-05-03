import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { SkillSearchHit } from '@/api/types'
import { MarkdownView } from '@/components/MarkdownView'
import { PageShell } from '@/components/PageShell'

type Mode = 'path' | 'content'

export function Skills() {
  const { data: listData } = useQuery({ queryKey: ['skills'], queryFn: () => api.skills(500) })
  const allSkills = listData?.skills ?? []

  const [mode, setMode] = useState<Mode>('path')
  const [filter, setFilter] = useState('')
  const [debouncedFilter, setDebouncedFilter] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [highlightQuery, setHighlightQuery] = useState('')

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedFilter(filter), 220)
    return () => window.clearTimeout(t)
  }, [filter])

  // Content-mode search hits.
  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ['skills.search', debouncedFilter],
    queryFn: () => api.searchSkills(debouncedFilter, 80),
    enabled: mode === 'content' && debouncedFilter.trim().length >= 2,
  })

  const { data: cur } = useQuery({
    queryKey: ['skill', active],
    queryFn: () => api.skill(active!),
    enabled: !!active,
  })

  const filteredByPath = useMemo(
    () => allSkills.filter((s) => !filter || s.path.toLowerCase().includes(filter.toLowerCase())),
    [allSkills, filter],
  )

  const sidebarPlaceholder =
    mode === 'path' ? '搜索路径…（如 vision_sop）' : '搜索内容…（输入 ≥ 2 字符）'

  const openHit = (path: string, q: string) => {
    setActive(path)
    setHighlightQuery(q)
  }

  return (
    <PageShell
      title="技能库"
      description={`memory/skill_search/ 下共 ${listData?.count ?? 0} 个文件`}
      actions={
        <div className="flex items-center gap-2">
          <div className="flex bg-bg-card border border-line rounded-lg overflow-hidden text-xs">
            {(['path', 'content'] as Mode[]).map((m) => (
              <button
                key={m}
                onClick={() => { setMode(m); setFilter(''); setDebouncedFilter('') }}
                className={`px-2.5 py-1.5 ${mode === m ? 'bg-accent text-white' : 'text-slate-300 hover:bg-white/5'}`}
              >
                {m === 'path' ? '路径' : '内容'}
              </button>
            ))}
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={sidebarPlaceholder}
            className="bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent w-72"
          />
        </div>
      }
    >
      <div className="flex h-full">
        <div className="w-[26rem] border-r border-line bg-bg-soft overflow-y-auto">
          {mode === 'path' && (
            <PathList
              items={filteredByPath}
              active={active}
              onPick={(p) => { setActive(p); setHighlightQuery('') }}
            />
          )}
          {mode === 'content' && (
            <ContentHits
              query={debouncedFilter}
              hits={searchData?.hits ?? []}
              scanned={searchData?.scanned ?? 0}
              truncated={searchData?.truncated ?? false}
              loading={searching}
              active={active}
              onPick={openHit}
            />
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {!active && (
            <div className="text-slate-500 text-sm">
              {mode === 'content' ? '在左侧输入关键词搜索文件内容' : '选择左侧 skill 文件查看内容'}
            </div>
          )}
          {active && cur && <ContentView path={cur.path} content={cur.content} highlight={highlightQuery} />}
        </div>
      </div>
    </PageShell>
  )
}

function PathList({
  items, active, onPick,
}: {
  items: { path: string; size: number }[]
  active: string | null
  onPick: (p: string) => void
}) {
  if (items.length === 0) {
    return <div className="p-6 text-slate-500 text-sm">无匹配</div>
  }
  return (
    <>
      {items.map((s) => (
        <button
          key={s.path}
          onClick={() => onPick(s.path)}
          className={`block w-full text-left px-3 py-2 text-sm border-b border-line/60 ${
            active === s.path ? 'bg-accent-soft text-accent' : 'text-slate-300 hover:bg-white/5'
          }`}
        >
          <div className="truncate font-mono text-xs">{s.path}</div>
          <div className="text-[10px] text-slate-500">{(s.size / 1024).toFixed(1)} KB</div>
        </button>
      ))}
    </>
  )
}

function ContentHits({
  query, hits, scanned, truncated, loading, active, onPick,
}: {
  query: string
  hits: SkillSearchHit[]
  scanned: number
  truncated: boolean
  loading: boolean
  active: string | null
  onPick: (path: string, q: string) => void
}) {
  if (query.trim().length < 2) {
    return <div className="p-6 text-slate-500 text-xs">输入至少 2 个字符以全文搜索。</div>
  }
  if (loading && hits.length === 0) {
    return <div className="p-6 text-slate-500 text-xs">搜索中…</div>
  }
  if (hits.length === 0) {
    return <div className="p-6 text-slate-500 text-xs">没有匹配。已扫描 {scanned} 个文件。</div>
  }
  return (
    <>
      <div className="px-3 py-2 text-[11px] text-slate-500 border-b border-line/60 bg-bg-soft sticky top-0">
        命中 {hits.length} 个文件 / 扫描 {scanned} 个{truncated ? ' · 结果已截断' : ''}
      </div>
      {hits.map((h) => (
        <button
          key={h.path}
          onClick={() => onPick(h.path, query)}
          className={`block w-full text-left px-3 py-2 border-b border-line/60 ${
            active === h.path ? 'bg-accent-soft' : 'hover:bg-white/5'
          }`}
        >
          <div className="truncate font-mono text-xs text-slate-200">{h.path}</div>
          <div className="text-[10px] text-slate-500 mb-1">{h.matches.length} 处匹配</div>
          {h.matches.slice(0, 3).map((m, i) => (
            <div key={i} className="text-[11px] font-mono text-slate-400 truncate">
              <span className="text-slate-600 mr-1.5">{m.line}</span>
              <Highlighted text={m.text} q={query} />
            </div>
          ))}
        </button>
      ))}
    </>
  )
}

function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>
  const parts = splitByQuery(text, q)
  return (
    <>
      {parts.map((p, i) =>
        p.match ? (
          <mark key={i} className="bg-amber-500/30 text-amber-200 px-0.5 rounded-sm">{p.text}</mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  )
}

function splitByQuery(text: string, q: string): { text: string; match: boolean }[] {
  if (!q) return [{ text, match: false }]
  const out: { text: string; match: boolean }[] = []
  const lower = text.toLowerCase()
  const ql = q.toLowerCase()
  let i = 0
  while (i < text.length) {
    const j = lower.indexOf(ql, i)
    if (j === -1) { out.push({ text: text.slice(i), match: false }); break }
    if (j > i) out.push({ text: text.slice(i, j), match: false })
    out.push({ text: text.slice(j, j + q.length), match: true })
    i = j + q.length
  }
  return out
}

function ContentView({ path, content, highlight }: { path: string; content: string; highlight: string }) {
  const ext = path.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? ''

  // Markdown files keep their rendered view (with no highlight, since
  // ReactMarkdown owns the DOM). Source files get a <pre> with line numbers
  // and inline match highlighting.
  if (ext === 'md' || ext === 'markdown') {
    return <MarkdownView>{content}</MarkdownView>
  }

  return (
    <CodeView content={content} highlight={highlight} />
  )
}

function CodeView({ content, highlight }: { content: string; highlight: string }) {
  const lines = useMemo(() => content.split('\n'), [content])
  const pad = String(lines.length).length

  return (
    <pre className="bg-bg-card border border-line rounded-lg p-4 text-xs leading-relaxed font-mono overflow-x-auto">
      <code>
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="text-slate-600 select-none mr-3 text-right shrink-0" style={{ width: `${pad}ch` }}>
              {i + 1}
            </span>
            <span className="whitespace-pre break-words flex-1">
              {highlight ? <Highlighted text={line || ' '} q={highlight} /> : (line || ' ')}
            </span>
          </div>
        ))}
      </code>
    </pre>
  )
}
