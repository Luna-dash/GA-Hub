import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { Conversation, ConversationSummary } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MarkdownView } from '@/components/MarkdownView'
import { previewText, relTime } from '@/utils/foldTurns'
import { dialog } from '@/stores/dialogStore'

function stripTags(s: string): string {
  return (s || '')
    .replace(/<summary>[\s\S]*?<\/summary>/g, ' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*LLM Running \(Turn \d+\) \.{3}\*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeSummaryText(s: string): string {
  return (s || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' · ')
}

type TurnSummary = {
  turn: number
  summary: string
}

function stripFinalMarker(s: string): string {
  const marker = '[Info] Final response to user.'
  const idx = (s || '').lastIndexOf(marker)
  return idx >= 0 ? s.slice(0, idx) : (s || '')
}

function extractTurnSummaries(s: string): TurnSummary[] {
  const text = stripFinalMarker(s)
  const re = /\*\*LLM Running \(Turn (\d+)\) \.{3}\*\*/g
  const matches = [...text.matchAll(re)]
  const turns: TurnSummary[] = []

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]
    const turn = Number(m[1])
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length
    const seg = text.slice(start, end)
    const sm = seg.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/)
    const summary = normalizeSummaryText(sm?.[1] || '')
    if (summary) turns.push({ turn, summary })
  }

  if (!turns.length) {
    const cleaned = text.replace(/`{3,}[\s\S]*?`{3,}/g, ' ')
    const hits = [...cleaned.matchAll(/<summary>\s*([\s\S]*?)\s*<\/summary>/g)]
      .map((m, idx) => ({ turn: idx + 1, summary: normalizeSummaryText(m[1] || '') }))
      .filter((x) => x.summary)
    return hits
  }
  return turns
}

function extractSummaries(s: string): string[] {
  return extractTurnSummaries(s).map((x) => x.summary)
}

function extractConclusion(s: string): string {
  const summaries = extractSummaries(s)
  const last = summaries.at(-1)
  if (last) return last
  return previewText(stripTags(s), 180) || '—'
}

function stripTraceMeta(s: string): string {
  return (s || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<summary>[\s\S]*?<\/summary>\s*/gi, '')
    .trim()
}

function stripWrapperFences(s: string): string {
  let text = (s || '').trim()
  let prev = ''
  while (text && text !== prev) {
    prev = text
    text = text
      .replace(/^\s*`{3,}[a-zA-Z0-9_-]*\s*$/gm, '')
      .replace(/^\s*`{3,}[a-zA-Z0-9_-]*\s*\r?\n/, '')
      .replace(/\r?\n\s*`{3,}\s*$/g, '')
      .trim()
  }
  return text
}

function looksLikeToolTrace(s: string): boolean {
  const text = stripWrapperFences(s).trim()
  if (!text) return true
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() || ''
  return (
    /^`{3,}\s*$/.test(firstLine) ||
    /^🛠️\s*Tool:/i.test(firstLine) ||
    /^🛠️\s*[a-zA-Z_][\w.]*\(/.test(firstLine) ||
    /^\[Action\]/i.test(firstLine) ||
    /^\[(Info|Warn|Error|Status|Stdout|Stderr|系统)\]/i.test(firstLine) ||
    /^\{[\s\S]*\}\s*$/.test(text)
  )
}

function extractTurnCandidate(seg: string): string {
  const withoutMeta = stripTraceMeta(seg).replace(/\n?\s*`{5,}\s*$/g, '').trim()
  if (!withoutMeta) return ''

  const toolStarts = [
    ...withoutMeta.matchAll(/^\s*🛠️\s*Tool:/gim),
    ...withoutMeta.matchAll(/^\s*🛠️\s*[a-zA-Z_][\w.]*\(/gm),
  ]

  if (!toolStarts.length) {
    const cleaned = stripWrapperFences(withoutMeta)
    return looksLikeToolTrace(cleaned) ? '' : cleaned
  }

  const lastToolStart = Math.max(...toolStarts.map((m) => m.index ?? -1))
  const tail = withoutMeta.slice(lastToolStart)
  let best = ''

  // GA tool transcript separators are full-line fences with 5+ backticks.
  // Split only on those so normal markdown code fences in the final answer stay intact.
  for (const m of tail.matchAll(/^\s*`{5,}\s*$/gm)) {
    const suffix = tail
      .slice((m.index ?? 0) + m[0].length)
      .replace(/^\s*`{5,}\s*$/gm, '')
      .replace(/\n?\s*`{5,}\s*$/g, '')
      .trim()
    if (!suffix) continue
    const cleaned = stripWrapperFences(suffix)
    if (!looksLikeToolTrace(cleaned)) best = cleaned
  }

  return best
}

function extractFinalBody(s: string): string {
  const text = stripFinalMarker(s)
  const re = /(?:\*\*)?LLM Running \(Turn \d+\) \.{3}(?:\*\*)?/g
  const matches = [...text.matchAll(re)]

  if (!matches.length) {
    return extractTurnCandidate(text) || '（暂无最终正文）'
  }

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length
    const candidate = extractTurnCandidate(text.slice(start, end))
    if (candidate) return candidate
  }

  return '（暂无最终正文）'
}

type RoundView = {
  user: string
  conclusion: string
  detail: string
  turnSummaries: TurnSummary[]
  lastSummary: string
}

function buildRounds(conv?: Conversation | null): RoundView[] {
  if (!conv?.messages?.length) return []
  const rounds: RoundView[] = []
  let current: RoundView | null = null

  const ensureCurrent = () => {
    if (!current) {
      current = {
        user: '（无用户输入）',
        conclusion: '（暂无结论）',
        detail: '—',
        turnSummaries: [],
        lastSummary: '（暂无结论）',
      }
      rounds.push(current)
    }
    return current
  }

  for (const m of conv.messages) {
    if (m.role === 'user') {
      current = {
        user: previewText(stripTags(m.content), 240) || '（空）',
        conclusion: '（该 round 暂无 Agent 结论）',
        detail: '—',
        turnSummaries: [],
        lastSummary: '（该 round 暂无 Agent 结论）',
      }
      rounds.push(current)
      continue
    }
    if (m.role === 'assistant') {
      const box = ensureCurrent()
      const turnSummaries = extractTurnSummaries(m.content)
      const detail = extractFinalBody(m.content)
      if (detail && detail !== '—') box.detail = detail
      if (turnSummaries.length) {
        box.turnSummaries.push(...turnSummaries)
        box.lastSummary = turnSummaries[turnSummaries.length - 1].summary
        box.conclusion = box.lastSummary
      } else {
        const fallback = extractConclusion(m.content)
        if (fallback && fallback !== '—') {
          box.turnSummaries.push({ turn: box.turnSummaries.length + 1, summary: fallback })
          box.lastSummary = fallback
          box.conclusion = fallback
        }
        if (!box.detail || box.detail === '—') box.detail = fallback
      }
    }
  }

  return rounds
}

export function Conversations() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [restoring, setRestoring] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [page, setPage] = useState(0)
  const limit = 50

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(t)
  }, [q])

  const { data } = useQuery({
    queryKey: ['conversations', debouncedQ, page],
    queryFn: () => api.conversations(debouncedQ || undefined, page * limit, limit),
  })

  const [active, setActive] = useState<string | null>(null)
  const [openConclusion, setOpenConclusion] = useState<Record<string, boolean>>({})
  const { data: detail } = useQuery({
    queryKey: ['conv', active],
    queryFn: () => api.conversation(active!),
    enabled: !!active,
  })

  const total = data?.total ?? 0
  const items = data?.items ?? []
  const rounds = buildRounds(detail)

  const handleRename = async (id: string, current: string) => {
    const v = await dialog.prompt('重命名会话', {
      defaultValue: current,
      placeholder: '新标题',
    })
    if (v == null) return
    await api.renameConversation(id, v)
    qc.invalidateQueries({ queryKey: ['conversations'] })
  }
  const handleDelete = async (id: string) => {
    const ok = await dialog.confirm(
      '删除该会话？',
      '此操作不可逆。',
      { confirmText: '删除', tone: 'danger' },
    )
    if (!ok) return
    await api.deleteConversation(id)
    qc.invalidateQueries({ queryKey: ['conversations'] })
    if (active === id) setActive(null)
  }
  const handleRestore = async (id: string) => {
    if (!detail) return
    const ok = await dialog.confirm(
      `恢复会话「${detail.title || id}」？`,
      `· 当前 Agent 上下文会被清空\n· 该会话的消息会作为历史摘要注入 Agent 记忆\n· 之后你可以在聊天界面继续对话`,
      { confirmText: '恢复并继续' },
    )
    if (!ok) return
    setRestoring(id)
    try {
      const r = await api.restoreConversation(id)
      qc.invalidateQueries({ queryKey: ['agent.status'] })
      qc.invalidateQueries({ queryKey: ['status'] })
      // Pass messages to LiveChat via router state for visual replay
      nav('/chat', {
        state: {
          restoredFrom: id,
          restoredTitle: r.title,
          restoredLines: r.restored_lines,
          messages: detail.messages || [],
        },
      })
    } catch (e: any) {
      await dialog.alert('恢复失败', e?.message || String(e))
    } finally {
      setRestoring(null)
    }
  }

  return (
    <PageShell
      title="对话管理"
      description={`memory/chat_history.json — 共 ${total} 条会话`}
      actions={
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0) }}
          placeholder="搜索标题或内容…"
          className="bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent w-72"
        />
      }
    >
      <div className="flex h-full">
        <div className="w-96 border-r border-line bg-bg-soft overflow-y-auto">
          {items.map((c) => (
            <ConvRow
              key={c.id}
              c={c}
              active={active === c.id}
              onClick={() => setActive(c.id)}
              onRename={() => handleRename(c.id, c.title)}
              onDelete={() => handleDelete(c.id)}
            />
          ))}
          <div className="p-3 flex items-center justify-between text-xs text-slate-400">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="px-2 py-1 disabled:opacity-30">← 上页</button>
            <span>第 {page + 1} 页</span>
            <button disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)} className="px-2 py-1 disabled:opacity-30">下页 →</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!active && <div className="h-full flex items-center justify-center text-slate-500 text-sm">选择左侧会话查看详情</div>}
          {active && detail && (
            <div className="p-6 max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold">{detail.title || detail.id}</h2>
                  <div className="text-xs text-slate-500 mt-0.5">id: {detail.id}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRestore(detail.id)}
                    disabled={restoring === detail.id}
                    className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
                    title="把这个会话作为 Agent 的历史上下文，跳转到聊天页继续"
                  >
                    {restoring === detail.id ? '恢复中…' : '↩ 恢复并继续聊天'}
                  </button>
                  <a href={api.exportConversation(detail.id, 'md')}
                     className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm">
                    导出 .md
                  </a>
                  <a href={api.exportConversation(detail.id, 'json')}
                     className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm">
                    导出 .json
                  </a>
                </div>
              </div>

              <div className="space-y-8">
                {rounds.map((r, i) => {
                  const conclusionKey = `${detail.id}:${i}`
                  const isConclusionOpen = !!openConclusion[conclusionKey]
                  return (
                    <div key={i} className="space-y-3.5">
                      <div className="flex justify-end">
                        <div className="w-[70%] rounded-[18px] rounded-br-md border border-emerald-900/30 bg-emerald-800/70 px-4 py-3 shadow-sm">
                          <div className="text-sm text-white whitespace-pre-wrap leading-6">{r.user}</div>
                        </div>
                      </div>

                      <div className="flex justify-start">
                        <div className="w-[70%] rounded-[18px] rounded-bl-md border border-white/6 bg-white/[0.045] px-4 py-3 shadow-sm">
                          {!isConclusionOpen && (r.turnSummaries.length > 0 ? (
                            <div className="space-y-2.5">
                              {r.turnSummaries.map((t, idx) => (
                                <div key={`${t.turn}-${idx}`} className="text-[13px] text-slate-200 whitespace-pre-wrap leading-5.5">
                                  <span className="font-semibold text-accent mr-2">Turn {t.turn}</span>
                                  <span>{t.summary}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="text-sm text-slate-200 whitespace-pre-wrap leading-6">{r.conclusion}</div>
                          ))}
                          {(r.detail && r.detail !== '—') && (
                            <details
                              open={isConclusionOpen}
                              onToggle={(e) => {
                                const next = e.currentTarget.open
                                setOpenConclusion((prev) => ({ ...prev, [conclusionKey]: next }))
                              }}
                              className={isConclusionOpen ? 'group' : 'mt-3 group'}
                            >
                              <summary className="cursor-pointer list-none text-xs text-slate-500 hover:text-slate-300 select-none inline-flex items-center gap-2">
                                <span className="transition group-open:rotate-90">▶</span>
                                <span>{isConclusionOpen ? '收起最终结论详情' : '展开最终结论详情'}</span>
                              </summary>
                              <div className="mt-3 rounded-2xl bg-white/[0.025] px-3 py-3 text-[13px] text-slate-200 leading-6">
                                <MarkdownView>{r.detail}</MarkdownView>
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
                {!rounds.length && (
                  <div className="rounded-xl border border-line bg-bg-card p-4 text-sm text-slate-500">
                    该会话暂无可展示的 round。
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}

function ConvRow({ c, active, onClick, onRename, onDelete }: {
  c: ConversationSummary
  active: boolean
  onClick: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`px-3 py-2.5 cursor-pointer border-b border-line/60 group ${active ? 'bg-accent-soft' : 'hover:bg-white/5'}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm text-slate-200 truncate font-medium" title={c.title}>
          {c.title || c.id}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
          <button onClick={(e) => { e.stopPropagation(); onRename() }} className="text-xs text-slate-400 hover:text-slate-200 px-1">✎</button>
          <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="text-xs text-rose-400 hover:text-rose-300 px-1">✕</button>
        </div>
      </div>
      <div className="text-xs text-slate-500 truncate mt-0.5">{previewText(c.last_assistant_preview || c.last_user_preview || '')}</div>
      <div className="text-[10px] text-slate-600 mt-0.5">{c.message_count} 条 · {c.id.slice(0, 19)}</div>
    </div>
  )
}
