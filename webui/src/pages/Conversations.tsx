import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { ConversationSummary } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MarkdownView } from '@/components/MarkdownView'
import { ConversationIndexRail } from '@/components/ConversationIndexRail'
import { previewText } from '@/utils/foldTurns'
import { looksLikeToolTrace, stripWrapperFences } from '@/utils/toolTrace'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import {
  applyConversationTitle,
  conversationKeys,
  removeConversationFromCache,
} from '@/queries/conversations'

type ViewMode = 'round' | 'flat'
type Msg = { role?: string; content?: string; [key: string]: any }
type TurnSummary = {
  turn: number
  summary: string
}
type Round = {
  index: number
  user: Msg | null
  assistants: Msg[]
  others: Msg[]
  turnSummaries: TurnSummary[]
  conclusion: string
  detail: string
  preview: string
}

export default function Conversations() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [restoring, setRestoring] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [page, setPage] = useState(0)
  const [viewMode, setViewMode] = useState<ViewMode>('round')
  const [openConclusion, setOpenConclusion] = useState<Record<string, boolean>>({})
  const limit = 50

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(t)
  }, [q])

  const { data } = useQuery({
    queryKey: conversationKeys.list(debouncedQ, page * limit, limit),
    queryFn: () => api.conversations(debouncedQ || undefined, page * limit, limit),
  })

  const [active, setActive] = useState<string | null>(null)
  const { data: detail } = useQuery({
    queryKey: conversationKeys.detail(active || ''),
    queryFn: () => api.conversation(active!),
    enabled: !!active,
  })

  const total = data?.total ?? 0
  const items = data?.items ?? []

  // Clamp page when the result set shrinks (e.g. after deleting the last item
  // on a trailing page, or narrowing the search) so we never get stranded on
  // an out-of-range empty page.
  useEffect(() => {
    if (total > 0 && page > 0 && page * limit >= total) {
      setPage(Math.max(0, Math.ceil(total / limit) - 1))
    }
  }, [total, page, limit])
  const rounds = useMemo(() => buildRounds((detail?.messages || []) as Msg[]), [detail])

  const handleExport = async (id: string, fmt: 'md' | 'json') => {
    try {
      const url = api.exportConversation(id, fmt)
      const resp = await fetch(url, { credentials: 'same-origin' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const filename = `${id}.${fmt}`
      // pywebview desktop shell: <a download> + blob URL is swallowed by
      // WebView2/WKWebView. Route through native save dialog via js_api.
      const pywv: any = (window as any).pywebview
      if (pywv && pywv.api && typeof pywv.api.save_export === 'function') {
        const text = await resp.text()
        const r = await pywv.api.save_export(filename, text)
        if (r && r.ok === false && !r.cancelled) {
          throw new Error(r.error || 'save failed')
        }
        if (r && r.cancelled) return
        toast.success(`已导出 ${filename}`)
        return
      }
      // Browser fallback
      const blob = await resp.blob()
      const objUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objUrl
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
    } catch (e: any) {
      dialog.alert('导出失败', String(e?.message || e))
    }
  }

  const handleRename = async (id: string, currentTitle: string) => {
    const title = await dialog.prompt('重命名历史会话', {
      message: '该名称会同步到绑定的 Chat 会话；留空可恢复默认名称。',
      defaultValue: currentTitle,
      placeholder: '输入会话名称',
      confirmText: '保存',
    })
    if (title === null) return
    try {
      const updated = await api.updateConversation(id, title.trim())
      await applyConversationTitle(qc, id, updated.title)
      toast.success('会话名称已更新')
    } catch (e: any) {
      await dialog.alert('重命名失败', e?.message || String(e))
    }
  }

  const handleDelete = async (id: string, title: string) => {
    const ok = await dialog.confirm(
      `删除历史会话「${title || id}」？`,
      '这将永久删除对应的原始会话文件，且无法撤销。',
      { confirmText: '永久删除文件', tone: 'danger' },
    )
    if (!ok) return
    try {
      await api.deleteConversation(id)
      if (active === id) setActive(null)
      await removeConversationFromCache(qc, id)
      toast.success('会话文件已删除')
    } catch (e: any) {
      await dialog.alert('删除失败', e?.message || String(e))
    }
  }

  const handleRestore = async (id: string) => {
    if (!detail) return
    const ok = await dialog.confirm(
      `恢复会话「${detail.title || id}」？`,
      `· 当前 Agent 上下文会被清空\n· 将完整恢复该会话的原生模型上下文（含工具调用与结果）\n· 之后你可以在聊天界面无缝继续对话`,
      { confirmText: '恢复并继续' },
    )
    if (!ok) return
    setRestoring(id)
    try {
      const r = await api.restoreConversation(id)
      qc.invalidateQueries({ queryKey: ['agent.status'] })
      qc.invalidateQueries({ queryKey: ['status'] })
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
      title="历史对话"
      actions={
        <div className="flex items-center gap-2">
          <div className="flex bg-bg-card border border-line rounded-lg overflow-hidden text-xs">
            {(['round', 'flat'] as ViewMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-3 py-1.5 ${viewMode === m ? 'bg-accent text-white' : 'text-slate-300 hover:bg-white/5'}`}
              >
                {m === 'round' ? '轮次摘要' : '对话视图'}
              </button>
            ))}
          </div>
          <input
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0) }}
            placeholder="搜索标题或内容…"
            className="bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent w-72"
          />
        </div>
      }
    >
      <div className="flex h-full">
        <ConversationIndexRail>
          {(collapsed) => (
            <>
              {items.map((c, index) => (
                <ConvRow
                  key={c.id}
                  c={c}
                  index={page * limit + index + 1}
                  collapsed={collapsed}
                  active={active === c.id}
                  onClick={() => setActive(c.id)}
                />
              ))}
              <div className={collapsed
                ? 'flex flex-col items-center gap-1 border-t border-line/60 py-2 text-xs text-slate-400'
                : 'p-3 flex items-center justify-between text-xs text-slate-400'}
              >
                <button
                  aria-label="上一页"
                  title="上一页"
                  disabled={page === 0}
                  onClick={() => setPage(page - 1)}
                  className="px-2 py-1 disabled:opacity-30"
                >
                  {collapsed ? '↑' : '← 上页'}
                </button>
                <span title={`第 ${page + 1} 页`}>{collapsed ? page + 1 : `第 ${page + 1} 页`}</span>
                <button
                  aria-label="下一页"
                  title="下一页"
                  disabled={(page + 1) * limit >= total}
                  onClick={() => setPage(page + 1)}
                  className="px-2 py-1 disabled:opacity-30"
                >
                  {collapsed ? '↓' : '下页 →'}
                </button>
              </div>
            </>
          )}
        </ConversationIndexRail>

        <div className="flex-1 overflow-y-auto">
          {!active && <div className="h-full flex items-center justify-center text-slate-500 text-sm">选择左侧会话查看详情</div>}
          {active && detail && (
            <div className="p-6 max-w-5xl mx-auto">
              <div className="mb-5">
                <h2 className="text-lg font-semibold break-words">{detail.title || detail.id}</h2>
                <div className="text-xs text-slate-500 mt-0.5">
                  id: {detail.id} · {detail.messages?.length || 0} 条消息 · {rounds.length} 轮
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3">
                  <button
                    onClick={() => handleRestore(detail.id)}
                    disabled={restoring === detail.id}
                    className="shrink-0 px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
                    title="把这个会话作为 Agent 的历史上下文，跳转到聊天页继续"
                  >
                    {restoring === detail.id ? '恢复中…' : '↩ 恢复并继续聊天'}
                  </button>
                  <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
                    <div className="flex overflow-hidden rounded-lg border border-line">
                      <button
                        type="button"
                        onClick={() => handleRename(detail.id, detail.title || '')}
                        className="px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5"
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(detail.id, detail.title || '')}
                        className="border-l border-line px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10"
                      >
                        删除
                      </button>
                    </div>
                    <div className="flex overflow-hidden rounded-lg border border-line">
                      <button
                        type="button"
                        onClick={() => handleExport(detail.id, 'md')}
                        className="px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5"
                      >
                        导出 MD
                      </button>
                      <button
                        type="button"
                        onClick={() => handleExport(detail.id, 'json')}
                        className="border-l border-line px-3 py-1.5 text-sm text-slate-300 hover:bg-white/5"
                      >
                        JSON
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {viewMode === 'round'
                ? (
                  <RoundView
                    convId={detail.id}
                    rounds={rounds}
                    openConclusion={openConclusion}
                    setOpenConclusion={setOpenConclusion}
                  />
                )
                : <FlatView messages={(detail.messages || []) as Msg[]} />}
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}

function RoundView({
  convId,
  rounds,
  openConclusion,
  setOpenConclusion,
}: {
  convId: string
  rounds: Round[]
  openConclusion: Record<string, boolean>
  setOpenConclusion: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}) {
  if (rounds.length === 0) {
    return <div className="text-slate-500 text-sm py-8 text-center border border-dashed border-line rounded-xl">该会话暂无消息</div>
  }

  return (
    <div className="space-y-5">
      {rounds.map((r, i) => {
        const roundKey = `${convId}:${r.index}`
        const isProcessOpen = !!openConclusion[roundKey]
        const summaryText = r.conclusion || r.turnSummaries[r.turnSummaries.length - 1]?.summary || '（无结论）'
        const detailText = r.detail && r.detail !== '（暂无最终正文）' ? r.detail : summaryText
        const hasTurnSummaries = r.turnSummaries.length > 0

        return (
          <div key={roundKey} className="rounded-2xl border border-line bg-bg-soft/40 p-4 md:p-5 shadow-sm">
            <div className="space-y-3.5">
              {r.user && (
                <div className="flex justify-end">
                  <div className="w-[70%] rounded-[18px] border border-emerald-900/30 bg-emerald-800/70 px-4 py-3 shadow-sm">
                    <div className="text-sm text-white whitespace-pre-wrap leading-6">{r.user.content || ''}</div>
                  </div>
                </div>
              )}

              <div className="flex justify-start">
                <div className="w-[86%] rounded-[18px] border border-line bg-bg-card px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-3 mb-2">
                    {hasTurnSummaries && (
                      <button
                        type="button"
                        onClick={() => setOpenConclusion((s) => ({ ...s, [roundKey]: !isProcessOpen }))}
                        className="text-xs text-accent hover:underline shrink-0"
                      >
                        {isProcessOpen ? '收起过程' : '展开过程'}
                      </button>
                    )}
                  </div>

                  {isProcessOpen && hasTurnSummaries && (
                    <div className="space-y-1.5 mb-4">
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">turn summaries</div>
                      {r.turnSummaries.map((ts, idx) => (
                        <div key={`${roundKey}-ts-${idx}`} className="rounded-lg border border-line/70 bg-bg-soft/50 px-3 py-2 text-sm text-slate-200 leading-5">
                          <span className="text-[11px] uppercase tracking-wider text-slate-500 mr-2">Turn {ts.turn}</span>
                          <span className="whitespace-pre-wrap">{ts.summary}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {detailText && (
                    <div className={isProcessOpen && hasTurnSummaries ? 'border-t border-line/70 pt-3' : ''}>
                      <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-2">assistant conclusion</div>
                      <MarkdownView mode="auto">{detailText}</MarkdownView>
                    </div>
                  )}
                </div>
              </div>

              {r.others.length > 0 && (
                <div className="space-y-2">
                  {r.others.map((m, idx) => (
                    <MessageBlock key={`o-${idx}`} m={m} label={m.role || `message ${idx + 1}`} tone="other" />
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FlatView({ messages }: { messages: Msg[] }) {
  return (
    <div className="space-y-4">
      {messages.map((m, i) => {
        const isUser = m.role === 'user'
        const isAssistant = m.role === 'assistant'
        const label = isUser ? '你' : isAssistant ? '助手' : (m.role || `消息 ${i + 1}`)
        return (
          <div key={i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div className={`w-fit max-w-[85%] ${isUser ? 'ml-12' : 'mr-12'}`}>
              <MessageBlock
                m={m}
                label={label}
                tone={isUser ? 'user' : isAssistant ? 'assistant' : 'other'}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MessageBlock({ m, label, tone }: { m: Msg; label: string; tone: 'user' | 'assistant' | 'other' }) {
  const cls = tone === 'user'
    ? 'border-accent/40 bg-accent-soft/30'
    : tone === 'assistant'
      ? 'border-line bg-bg-card'
      : 'border-slate-700 bg-bg-soft'
  return (
    <div className={`rounded-xl border ${cls} p-3`}>
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      <MarkdownView mode="auto">{m.content || ''}</MarkdownView>
    </div>
  )
}

function buildRounds(messages: Msg[]): Round[] {
  const rounds: Round[] = []
  let current: Round | null = null

  const ensureCurrent = () => {
    if (!current) {
      current = {
        index: rounds.length + 1,
        user: null,
        assistants: [],
        others: [],
        turnSummaries: [],
        conclusion: '（暂无结论）',
        detail: '（暂无最终正文）',
        preview: '（无用户输入）',
      }
      rounds.push(current)
    }
    return current
  }

  for (const m of messages) {
    const role = String(m.role || '').toLowerCase()
    if (role === 'user') {
      current = {
        index: rounds.length + 1,
        user: m,
        assistants: [],
        others: [],
        turnSummaries: [],
        conclusion: '（该 round 暂无 Agent 结论）',
        detail: '（暂无最终正文）',
        preview: previewText(stripTags(m.content || ''), 240) || '（空）',
      }
      rounds.push(current)
      continue
    }

    const box = ensureCurrent()
    if (role === 'assistant') {
      box.assistants.push(m)
      const turnSummaries = extractTurnSummaries(m.content || '')
      const detail = extractFinalBody(m.content || '')
      if (detail && detail !== '（暂无最终正文）') box.detail = detail
      if (turnSummaries.length) {
        box.turnSummaries.push(...turnSummaries)
        const lastSummary = turnSummaries[turnSummaries.length - 1].summary
        box.conclusion = lastSummary
      } else {
        const fallback = extractConclusion(m.content || '')
        if (fallback && fallback !== '（暂无结论）') {
          box.turnSummaries.push({ turn: box.turnSummaries.length + 1, summary: fallback })
          box.conclusion = fallback
        }
        if (!box.detail || box.detail === '（暂无最终正文）') box.detail = fallback || box.detail
      }
      box.preview = previewText(box.user?.content || box.conclusion || box.detail || '', 240) || '（空）'
    } else {
      box.others.push(m)
    }
  }

  return rounds
}

function normalizeSummaryText(s: string): string {
  return (s || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .join(' 路 ')
}

function stripFinalMarker(s: string): string {
  const marker = '[Info] Final response to user.'
  const idx = (s || '').lastIndexOf(marker)
  return idx >= 0 ? s.slice(0, idx) : (s || '')
}

function extractTurnSummaries(text: string): { turn: number; summary: string }[] {
  const source = stripFinalMarker(text)
  const re = /\*\*LLM Running \(Turn (\d+)\) \.{3}\*\*/g
  const matches = [...source.matchAll(re)]
  const turns: { turn: number; summary: string }[] = []

  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]
    const turn = Number(m[1])
    const start = (m.index ?? 0) + m[0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length
    const seg = source.slice(start, end)
    const sm = seg.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/)
    const summary = normalizeSummaryText(sm?.[1] || '')
    if (summary) turns.push({ turn, summary })
  }

  if (!turns.length) {
    const cleaned = source.replace(/`{3,}[\s\S]*?`{3,}/g, ' ')
    return [...cleaned.matchAll(/<summary>\s*([\s\S]*?)\s*<\/summary>/g)]
      .map((m, idx) => ({ turn: idx + 1, summary: normalizeSummaryText(m[1] || '') }))
      .filter((x) => x.summary)
  }

  return turns
}

function extractTurnSummary(text: string): string {
  return extractTurnSummaries(text).map((x) => x.summary).at(-1) || ''
}

function extractConclusion(text: string): string {
  const last = extractTurnSummary(text)
  if (last) return last
  return previewText(stripTags(text), 180) || ''
}

function stripTraceMeta(s: string): string {
  return (s || '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<summary>[\s\S]*?<\/summary>\s*/gi, '')
    .trim()
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

function extractFinalBody(text: string): string {
  const source = stripFinalMarker(text)
  const re = /(?:\*\*)?LLM Running \(Turn \d+\) \.{3}(?:\*\*)?/g
  const matches = [...source.matchAll(re)]

  if (!matches.length) {
    return extractTurnCandidate(source) || '（暂无最终正文）'
  }

  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? source.length) : source.length
    const candidate = extractTurnCandidate(source.slice(start, end))
    if (candidate) return candidate
  }

  return '（暂无最终正文）'
}

function stripTags(s: string): string {
  return (s || '')
    .replace(/<summary>[\s\S]*?<\/summary>/g, ' ')
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*\*LLM Running \(Turn \d+\) \.{3}\*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanSummary(s: string): string {
  return stripTags(s)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 500)
}

function ConvRow({ c, index, collapsed, active, onClick }: {
  c: ConversationSummary
  index: number
  collapsed: boolean
  active: boolean
  onClick: () => void
}) {
  const title = c.title || c.id
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`第 ${index} 条：${title}`}
        title={`${index}. ${title}\n${previewText(c.last_user_preview || '')}`}
        className={`flex h-11 w-full items-center justify-center border-b border-line/60 text-xs font-medium transition-colors ${active ? 'bg-accent-soft text-accent' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'}`}
      >
        {index}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full px-3 py-2.5 text-left border-b border-line/60 group ${active ? 'bg-accent-soft' : 'hover:bg-white/5'}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm text-slate-200 truncate font-medium" title={c.title}>
          {title}
        </div>
      </div>
      <div className="text-xs text-slate-500 truncate mt-0.5">{previewText(c.last_user_preview || '')}</div>
      <div className="text-[10px] text-slate-600 mt-0.5">{c.message_count} 条 · {c.id.slice(0, 19)}</div>
    </button>
  )
}
