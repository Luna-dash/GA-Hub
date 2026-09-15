import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { readPageState, usePageState, writePageState } from '@/utils/pageState'
import type { ConversationMessage, ConversationSource, ConversationSummary, HubSession } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MessageContent } from '@/components/MessageContent'
import { bubbleTone } from '@/components/bubbleTone'
import { ConversationIndexRail } from '@/components/ConversationIndexRail'
import { VirtualMessageList } from '@/components/VirtualMessageList'
import { parseAssistantTranscript, stripAssistantTranscriptTags } from '@/utils/assistantTranscript'
import { previewText } from '@/utils/foldTurns'
import { RAIL_TITLE_SCALE_EVENT, getRailTitleScale } from '@/utils/railAppearance'
import { saveTextExport } from '@/utils/desktop'
import { errorMessageFromError, openSessionChat, structuredErrorDetailFromError } from '@/utils/sessionUi'
import { dialog } from '@/stores/dialogStore'
import { toast } from '@/stores/toastStore'
import {
  applyConversationTitle,
  conversationKeys,
  removeConversationFromCache,
} from '@/queries/conversations'
import { queryKeys } from '@/queries/queryKeys'

type ViewMode = 'round' | 'flat'
type Msg = ConversationMessage
type SourceFilter = 'all' | ConversationSource
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

// Source vocabulary, shared by the row badge and the filter chips. Only the
// bound state carries a tone — it is the one that decides the row's action
// ("打开该会话" vs "导入为会话"); the two unbound origins stay quiet neutrals
// that differ by label alone.
const SOURCE_META: Record<ConversationSource, { label: string; chipClass: string }> = {
  session: {
    label: '本机会话',
    chipClass: 'border-status-info-line bg-status-info-soft text-status-info',
  },
  im: { label: '外部接入', chipClass: 'border-line bg-bg-card text-ink-muted' },
  local: { label: '本地', chipClass: 'border-line bg-bg-card text-ink-faint' },
}

const SOURCE_FILTERS: { value: SourceFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'session', label: '本机会话' },
  { value: 'im', label: '外部接入' },
  { value: 'local', label: '本地' },
]

/** A backend without `source` (mid-upgrade) reads as 本地, never a blank chip. */
function sourceMeta(source: ConversationSummary['source'] | undefined) {
  return (source && SOURCE_META[source]) || SOURCE_META.local
}

export default function Conversations() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const { id: routeConversationId } = useParams<{ id?: string }>()
  const active = routeConversationId || null
  // Remember the last opened conversation so returning to this page via the
  // plain /conversations route restores the selection instead of an empty pane.
  const lastActiveRef = useRef<string | null>(readPageState('conversations.lastActive', null))
  const [importing, setImporting] = useState<string | null>(null)
  const [q, setQ] = usePageState('conversations.q', '')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [page, setPage] = usePageState('conversations.page', 0)
  const [viewMode, setViewMode] = usePageState<ViewMode>('conversations.viewMode', 'round')
  const [sourceFilter, setSourceFilter] = usePageState<SourceFilter>('conversations.sourceFilter', 'all')
  const [openConclusion, setOpenConclusion] = usePageState<Record<string, boolean>>('conversations.openConclusion', {})
  const detailScrollRef = useRef<HTMLDivElement>(null)
  const limit = 50

  // 会话管理栏标题字号（设置页可调，仅当前设备）
  const [titleScale, setTitleScale] = useState(getRailTitleScale)
  useEffect(() => {
    const sync = (event: Event) => setTitleScale((event as CustomEvent<number>).detail || getRailTitleScale())
    window.addEventListener(RAIL_TITLE_SCALE_EVENT, sync)
    return () => window.removeEventListener(RAIL_TITLE_SCALE_EVENT, sync)
  }, [])
  const titleStyle: CSSProperties = { fontSize: `${titleScale}%` }

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(t)
  }, [q])

  const { data } = useQuery({
    queryKey: conversationKeys.list(debouncedQ, page * limit, limit),
    queryFn: () => api.conversations(debouncedQ || undefined, page * limit, limit),
  })

  const { data: detail } = useQuery({
    queryKey: conversationKeys.detail(active || ''),
    queryFn: () => api.conversation(active!),
    enabled: !!active,
  })

  const total = data?.total ?? 0
  const items = data?.items ?? []
  // Display-only narrowing of the loaded page: the query, the detail pane and
  // every row action keep working off the unfiltered item either way.
  const visibleItems = useMemo(
    () => (sourceFilter === 'all' ? items : items.filter((c) => c.source === sourceFilter)),
    [items, sourceFilter],
  )
  const filterLabel = SOURCE_FILTERS.find((f) => f.value === sourceFilter)?.label ?? '全部'

  // Clamp page when the result set shrinks (e.g. after deleting the last item
  // on a trailing page, or narrowing the search) so we never get stranded on
  // an out-of-range empty page.
  useEffect(() => {
    if (total > 0 && page > 0 && page * limit >= total) {
      setPage(Math.max(0, Math.ceil(total / limit) - 1))
    }
  }, [total, page, limit])

  useEffect(() => {
    if (!active) return
    lastActiveRef.current = active
    writePageState('conversations.lastActive', active)
  }, [active])

  useEffect(() => {
    // One-shot on entering the page without a selection: fall back to the
    // last opened conversation. Skipped after deletion via lastActiveRef=null.
    if (active || lastActiveRef.current === null) return
    nav(`/conversations/${encodeURIComponent(lastActiveRef.current)}`, { replace: true })
  }, [])
  const detailScrollPositionsRef = useRef<Record<string, number>>(
    readPageState('conversations.detailScroll', {}),
  )

  useEffect(() => {
    // A deep-link change reuses the same page component. Restore the saved
    // reader position for the target conversation (or its header when none)
    // after the detail pane lays out, instead of an arbitrary old offset.
    if (!active) return
    const saved = detailScrollPositionsRef.current[active] ?? 0
    const frame = requestAnimationFrame(() => {
      if (detailScrollRef.current) detailScrollRef.current.scrollTop = saved
    })
    return () => cancelAnimationFrame(frame)
  }, [active, viewMode, detail])

  useEffect(() => {
    const el = detailScrollRef.current
    if (!el || !active) return
    const capture = () => {
      detailScrollPositionsRef.current[active] = el.scrollTop
      writePageState('conversations.detailScroll', trimDetailScrollPositions(detailScrollPositionsRef.current))
    }
    el.addEventListener('scroll', capture, { passive: true })
    return () => {
      el.removeEventListener('scroll', capture)
      capture()
    }
  }, [active])
  const rounds = useMemo(() => buildRounds(detail?.messages || []), [detail])
  // Non-empty only for a real chat session: the backend excludes title-only
  // archive rows from `bound_session_id`, so this drives the primary action.
  const boundSessionId = detail?.bound_session_id || null

  const handleExport = async (id: string, fmt: 'md' | 'json') => {
    try {
      const url = api.exportConversation(id, fmt)
      const resp = await fetch(url, { credentials: 'same-origin' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const filename = `${id}.${fmt}`
      const text = await resp.text()
      const saved = await saveTextExport(filename, text)
      if (!saved.ok && saved.cancelled) return
      if (!saved.ok) throw new Error(saved.error || 'save failed')
      toast.success(`已导出 ${filename}`)
    } catch (e: any) {
      dialog.alert('导出失败', errorMessageFromError(e, '导出失败'))
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
      await dialog.alert('重命名失败', errorMessageFromError(e))
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
      if (active === id) {
        nav('/conversations', { replace: true })
        lastActiveRef.current = null
        writePageState('conversations.lastActive', null)
      }
      await removeConversationFromCache(qc, id)
      toast.success('会话文件已删除')
    } catch (e: any) {
      await dialog.alert('删除失败', errorMessageFromError(e))
    }
  }

  /** Select a session the way the rail does, from outside the chat page.
   *
   * The chat page resolves `?session=` against the cached session list, and
   * that cache is fresh for 30s — so a session minted moments ago would miss
   * the lookup and the chat page would fall back to an unrelated session.
   * Refresh first, and refuse to navigate when the target is gone: opening the
   * wrong conversation is worse than not opening one.
   */
  const openSession = async (sessionId: string) => {
    let listed: { total: number; items: HubSession[] }
    try {
      listed = await qc.fetchQuery<{ total: number; items: HubSession[] }>({
        queryKey: queryKeys.sessions,
        queryFn: api.sessions,
        staleTime: 0,
      })
    } catch (e: any) {
      await dialog.alert('无法打开会话', `会话列表刷新失败：${errorMessageFromError(e)}`)
      return
    }
    if (!listed.items.some((item) => item.id === sessionId)) {
      await dialog.alert('无法打开会话', '该会话已不存在，请刷新后重试。')
      return
    }
    openSessionChat(nav, sessionId)
  }

  const handleImport = async (id: string) => {
    setImporting(id)
    try {
      const created = await api.importConversation(id)
      toast.success(`已导入为会话「${created.title || id}」（${created.imported_lines} 条消息）`)
      await openSession(created.session_id)
    } catch (e: any) {
      const payload = structuredErrorDetailFromError<{ code?: string; session_id?: unknown }>(e)
      if (payload?.code === 'archive_already_bound') {
        // The archive is spoken for, but the owner is exactly what the user
        // wants to see — hand them the session the response names.
        const owner = typeof payload.session_id === 'string' ? payload.session_id : ''
        toast.error(owner ? '该归档已属于某条会话，已为你打开该会话' : '该归档已属于某条会话')
        if (owner) await openSession(owner)
      } else if (payload?.code === 'archive_not_importable') {
        await dialog.alert('无法导入', '该归档没有可导入的完整对话。')
      } else if (e?.status === 404) {
        await dialog.alert('归档不存在', '该归档可能已被删除，请刷新列表后重试。')
      } else {
        await dialog.alert('导入失败', errorMessageFromError(e))
      }
    } finally {
      setImporting(null)
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
              {!collapsed && (
                <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-line/60 bg-bg-soft px-3 py-2">
                  {SOURCE_FILTERS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      aria-pressed={sourceFilter === f.value}
                      onClick={() => setSourceFilter(f.value)}
                      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                        sourceFilter === f.value
                          ? 'border-accent bg-accent text-white'
                          : 'border-line text-ink-muted hover:bg-white/5'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
              {visibleItems.map((c, index) => (
                <ConvRow
                  key={c.id}
                  c={c}
                  index={page * limit + index + 1}
                  collapsed={collapsed}
                  active={active === c.id}
                  titleStyle={titleStyle}
                  onClick={() => nav(`/conversations/${encodeURIComponent(c.id)}`)}
                />
              ))}
              {visibleItems.length === 0 && items.length > 0 && (
                <div className="px-3 py-6 text-center text-xs text-ink-faint">
                  本页没有「{filterLabel}」会话
                </div>
              )}
              {total > limit && (
                <div className={collapsed
                  ? 'sticky bottom-0 z-10 flex flex-col items-center gap-1 border-t border-line/60 bg-bg-soft py-2 text-xs text-slate-400'
                  : 'sticky bottom-0 z-10 p-3 flex items-center justify-between border-t border-line/60 bg-bg-soft text-xs text-slate-400'}
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
              )}
            </>
          )}
        </ConversationIndexRail>

        <div ref={detailScrollRef} className="min-w-0 flex-1 overflow-y-auto [overflow-anchor:none]">
          {!active && <div className="h-full flex items-center justify-center text-slate-500 text-sm">选择左侧会话查看详情</div>}
          {active && detail && (
            <div className="p-6 max-w-5xl mx-auto">
              <div className="mb-5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <h2 className="min-w-0 truncate text-lg font-semibold" title={conversationDisplayTitle(detail)}>
                    {conversationDisplayTitle(detail)}
                  </h2>
                  <span className="shrink-0 text-xs text-slate-500">
                    {detail.messages?.length || 0} 条消息 · {rounds.length} 轮
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/60 pt-3">
                  {boundSessionId ? (
                    <button
                      type="button"
                      onClick={() => { void openSession(boundSessionId) }}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-accent text-white text-sm"
                      title="这条归档已属于一条会话，切换到该会话继续"
                    >
                      打开该会话
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { void handleImport(detail.id) }}
                      disabled={importing === detail.id}
                      className="shrink-0 px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
                      title="把这条归档复制成一条新会话（源文件保持只读），之后可无缝继续对话"
                    >
                      {importing === detail.id ? '导入中…' : '导入为会话'}
                    </button>
                  )}
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
                        className="border-l border-line px-3 py-1.5 text-sm text-status-danger hover:bg-status-danger-soft"
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
                    key={`round:${detail.id}`}
                    convId={detail.id}
                    rounds={rounds}
                    scrollRef={detailScrollRef}
                    openConclusion={openConclusion}
                    setOpenConclusion={setOpenConclusion}
                  />
                )
                : (
                  <FlatView
                    key={`flat:${detail.id}`}
                    messages={detail.messages || []}
                    scrollRef={detailScrollRef}
                  />
                )}
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
  scrollRef,
  openConclusion,
  setOpenConclusion,
}: {
  convId: string
  rounds: Round[]
  scrollRef: RefObject<HTMLDivElement>
  openConclusion: Record<string, boolean>
  setOpenConclusion: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
}) {
  if (rounds.length === 0) {
    return <div className="text-slate-500 text-sm py-8 text-center border border-dashed border-line rounded-xl">该会话暂无消息</div>
  }

  return (
    <VirtualMessageList
      items={rounds}
      scrollRef={scrollRef}
      virtualizationThreshold={12}
      overscanPx={700}
      itemKey={roundItemKey}
      estimateSize={estimateRoundSize}
      renderItem={(r) => {
        const roundKey = `${convId}:${r.index}`
        const isProcessOpen = !!openConclusion[roundKey]
        const summaryText = r.conclusion || r.turnSummaries[r.turnSummaries.length - 1]?.summary || '（无结论）'
        const detailText = r.detail && r.detail !== '（暂无最终正文）' ? r.detail : summaryText
        const hasTurnSummaries = r.turnSummaries.length > 0

        return (
          <div className="pb-3">
            <div className="rounded-2xl border border-line bg-bg-soft/40 p-4 shadow-sm md:p-5">
              <div className="space-y-3.5">
                {r.user && (
                  <div className="flex justify-end">
                    <div className={`w-[70%] rounded-[18px] px-4 py-3 shadow-sm ${bubbleTone('user').surfaceClass}`}>
                      <MessageContent content={r.user.content || ''} format="text" className="text-sm leading-6" />
                    </div>
                  </div>
                )}

                <div className="flex justify-start">
                  <div className="w-[86%] rounded-[18px] border border-line bg-bg-card px-4 py-3 shadow-sm">
                    <div className="mb-2 flex items-center gap-3">
                      {hasTurnSummaries && (
                        <button
                          type="button"
                          onClick={() => setOpenConclusion((s) => ({ ...s, [roundKey]: !isProcessOpen }))}
                          className="shrink-0 text-xs text-accent hover:underline"
                        >
                          {isProcessOpen ? '收起过程' : '展开过程'}
                        </button>
                      )}
                    </div>

                    {isProcessOpen && hasTurnSummaries && (
                      <div className="mb-4 space-y-1.5">
                        <div className="text-[11px] uppercase tracking-wider text-slate-500">turn summaries</div>
                        {r.turnSummaries.map((ts, idx) => (
                          <div key={`${roundKey}-ts-${idx}`} className="rounded-lg border border-line/70 bg-bg-soft/50 px-3 py-2 text-sm leading-5 text-slate-200">
                            <span className="mr-2 text-[11px] uppercase tracking-wider text-slate-500">Turn {ts.turn}</span>
                            <span className="whitespace-pre-wrap">{ts.summary}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {detailText && (
                      <div className={isProcessOpen && hasTurnSummaries ? 'border-t border-line/70 pt-3' : ''}>
                        <div className="mb-2 text-[11px] uppercase tracking-wider text-slate-500">assistant conclusion</div>
                        <MessageContent content={detailText} format="markdown" />
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
          </div>
        )
      }}
    />
  )
}

function FlatView({ messages, scrollRef }: { messages: Msg[]; scrollRef: RefObject<HTMLDivElement> }) {
  return (
    <VirtualMessageList
      items={messages}
      scrollRef={scrollRef}
      virtualizationThreshold={12}
      overscanPx={700}
      itemKey={flatMessageKey}
      estimateSize={estimateFlatMessageSize}
      renderItem={(m, i) => {
        const isUser = m.role === 'user'
        const isAssistant = m.role === 'assistant'
        const label = isUser ? '你' : isAssistant ? '助手' : (m.role || `消息 ${i + 1}`)
        return (
          <div className="pb-2">
            <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              <div className={`w-fit max-w-[85%] ${isUser ? 'ml-12' : 'mr-12'}`}>
                <MessageBlock
                  m={m}
                  label={label}
                  tone={isUser ? 'user' : isAssistant ? 'assistant' : 'other'}
                />
              </div>
            </div>
          </div>
        )
      }}
    />
  )
}

function MessageBlock({ m, label, tone }: { m: Msg; label: string; tone: 'user' | 'assistant' | 'other' }) {
  return (
    <div className={`rounded-xl border ${bubbleTone(tone, 'card').surfaceClass} p-3`}>
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">{label}</div>
      {/* User prompts are literal input everywhere (live chat, round view);
          the flat view previously markdown-rendered them — converge on text. */}
      <MessageContent
        content={m.content || ''}
        format={tone === 'user' ? 'text' : 'markdown'}
        className="text-sm leading-6"
      />
    </div>
  )
}

function boundedContentFingerprint(content: string): string {
  const source = `${content.length}|${content.slice(0, 96)}|${content.slice(-96)}`
  let hash = 2_166_136_261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return (hash >>> 0).toString(36)
}

function roundItemKey(round: Round): string {
  return `round:${round.index}:${boundedContentFingerprint(round.user?.content || '')}:${boundedContentFingerprint(round.detail)}`
}

function flatMessageKey(message: Msg, index: number): string {
  return `${index}:${message.role || 'message'}:${boundedContentFingerprint(message.content || '')}`
}

function estimatedLines(content: string, columns = 90): number {
  if (!content) return 0
  const wrapped = Math.ceil(content.length / columns)
  if (wrapped >= 48) return 48
  let lineBreaks = 0
  for (let index = 0; index < content.length && lineBreaks < 48; index += 1) {
    if (content.charCodeAt(index) === 10) lineBreaks += 1
  }
  return Math.min(48, wrapped + lineBreaks)
}

function estimateRoundSize(round: Round): number {
  const userLines = estimatedLines(round.user?.content || '', 72)
  const detailLines = estimatedLines(round.detail || round.conclusion, 90)
  const otherLines = round.others.reduce(
    (total, message) => total + estimatedLines(message.content || '', 90),
    0,
  )
  return Math.min(1_600, 190 + userLines * 24 + detailLines * 22 + otherLines * 22)
}

function estimateFlatMessageSize(message: Msg): number {
  return Math.min(1_400, 92 + estimatedLines(message.content || '', 90) * 22)
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
        preview: previewText(stripAssistantTranscriptTags(m.content || ''), 240) || '（空）',
      }
      rounds.push(current)
      continue
    }

    const box = ensureCurrent()
    if (role === 'assistant') {
      box.assistants.push(m)
      const transcript = parseAssistantTranscript(m.content || '')
      const turnSummaries = transcript.turns
        .filter((turn) => turn.summary)
        .map(({ turn, summary }) => ({ turn, summary }))
      const detail = transcript.finalBody
      if (detail && detail !== '（暂无最终正文）') box.detail = detail
      if (turnSummaries.length) {
        // Archived conversations can contain more than one assistant snapshot of
        // the same transcript. Keep one row per turn; later snapshots contain
        // the most complete summary for that turn.
        const summariesByTurn = new Map(box.turnSummaries.map((item) => [item.turn, item]))
        for (const summary of turnSummaries) summariesByTurn.set(summary.turn, summary)
        box.turnSummaries = [...summariesByTurn.values()].sort((a, b) => a.turn - b.turn)
        const lastSummary = box.turnSummaries[box.turnSummaries.length - 1].summary
        box.conclusion = lastSummary
      } else {
        const fallback = previewText(
          detail || stripAssistantTranscriptTags(m.content || ''),
          180,
        )
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

function conversationDisplayTitle(detail: { title?: string; messages?: Msg[] }): string {
  const customTitle = detail.title?.trim()
  if (customTitle) return customTitle
  const originalQuestion = detail.messages?.find((message) => message.role === 'user')?.content
  return previewText(originalQuestion || '') || '未命名会话'
}

function summaryDisplayTitle(conversation: ConversationSummary): string {
  return conversation.title.trim()
    || previewText(conversation.original_user_preview || '')
    || '未命名会话'
}

function ConvRow({ c, index, collapsed, active, titleStyle, onClick }: {
  c: ConversationSummary
  index: number
  collapsed: boolean
  active: boolean
  titleStyle?: CSSProperties
  onClick: () => void
}) {
  const title = summaryDisplayTitle(c)
  const meta = sourceMeta(c.source)
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={`第 ${index} 条：${title}`}
        title={`${index}. ${title}\n${previewText(c.last_user_preview || '')}\n来源：${meta.label}`}
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
        <div className="text-sm text-slate-200 truncate font-medium" style={titleStyle} title={title}>
          {title}
        </div>
        <span
          className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] leading-4 ${meta.chipClass}`}
          title={`来源：${meta.label}`}
        >
          {meta.label}
        </span>
      </div>
      <div className="text-xs text-slate-500 truncate mt-0.5">{previewText(c.last_user_preview || '')}</div>
      <div className="text-[10px] text-slate-600 mt-0.5">{c.message_count} 条消息</div>
    </button>
  )
}

function trimDetailScrollPositions(
  positions: Record<string, number>,
  limit = 60,
): Record<string, number> {
  const entries = Object.entries(positions)
  if (entries.length <= limit) return positions
  return Object.fromEntries(entries.slice(entries.length - limit))
}
