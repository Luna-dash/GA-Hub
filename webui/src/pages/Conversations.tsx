import { QueryLoadState } from '@/components/QueryLoadState'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { readPageState, usePageState, writePageState } from '@/utils/pageState'
import type { ConversationMessage, ConversationSource, ConversationSummary, HubSession } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MessageContent } from '@/components/MessageContent'
import { ReplyActions } from '@/components/ReplyActions'
import { bubbleTone } from '@/components/bubbleTone'
import { ConversationIndexRail } from '@/components/ConversationIndexRail'
import { TranscriptUtilityRail } from '@/components/ChatLayout'
import { ConversationTurnMinimap } from '@/components/ConversationTurnMinimap'
import { TranscriptNavDock } from '@/components/TranscriptNavDock'
import { VirtualMessageList, type VirtualMessageListHandle } from '@/components/VirtualMessageList'
import { parseAssistantTranscript, stripAssistantTranscriptTags } from '@/utils/assistantTranscript'
import { previewText } from '@/utils/foldTurns'
import { formatRelativeTime } from '@/utils/timeFormat'
import { CHAT_FONT_SCALE_EVENT, chatFontPercent, getChatFontScale } from '@/utils/chatAppearance'
import { RAIL_TITLE_SCALE_EVENT, railTitlePercent, getRailTitleScale } from '@/utils/railAppearance'
import { UI_SETTINGS_HYDRATED_EVENT } from '@/stores/uiSettingsStore'
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
import { conversationCountsText, CONVERSATION_COUNTS_HELP } from '@/utils/conversationCounts'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDisclosureIcon,
  ChevronLeft,
  ChevronRight,
  Clock,
  ExternalLink,
  FileJson,
  FileText,
  FolderDown,
  History,
  Inbox,
  Layers,
  Pencil,
  RotateCw,
  Search,
  Trash2,
  X,
} from '@/components/ActionIcons'
import { LoaderCircle, MessageSquare } from 'lucide-react'

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
    chipClass: 'border-status-info-line/80 bg-status-info-soft text-status-info',
  },
  im: { label: '外部接入', chipClass: 'border-line/70 bg-bg-soft/90 text-ink-muted' },
  local: { label: '本地', chipClass: 'border-line/65 bg-bg-soft/80 text-ink-faint' },
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

  // 会话管理栏标题字号与正文缩放（设置页可调，仅当前设备）
  const [titleScale, setTitleScale] = useState(getRailTitleScale)
  const [fontScale, setFontScale] = useState(getChatFontScale)
  useEffect(() => {
    const syncTitle = (event: Event) => setTitleScale((event as CustomEvent<number>).detail || getRailTitleScale())
    const syncFont = (event: Event) => setFontScale((event as CustomEvent<number>).detail || getChatFontScale())
    const syncHydrated = () => {
      setTitleScale(getRailTitleScale())
      setFontScale(getChatFontScale())
    }
    window.addEventListener(RAIL_TITLE_SCALE_EVENT, syncTitle)
    window.addEventListener(CHAT_FONT_SCALE_EVENT, syncFont)
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, syncHydrated)
    return () => {
      window.removeEventListener(RAIL_TITLE_SCALE_EVENT, syncTitle)
      window.removeEventListener(CHAT_FONT_SCALE_EVENT, syncFont)
      window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, syncHydrated)
    }
  }, [])
  const titleStyle: CSSProperties = { fontSize: `${railTitlePercent(titleScale)}%` }
  const messageFontStyle = useMemo<CSSProperties>(() => ({
    fontSize: `${chatFontPercent(fontScale)}%`,
    '--chat-scale': chatFontPercent(fontScale) / 100,
  } as CSSProperties), [fontScale])

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(t)
  }, [q])

  const listQuery = useQuery({
    queryKey: conversationKeys.list(debouncedQ, page * limit, limit, sourceFilter),
    queryFn: () => (
      sourceFilter === 'all'
        ? api.conversations(debouncedQ || undefined, page * limit, limit)
        : api.conversations(debouncedQ || undefined, page * limit, limit, sourceFilter)
    ),
  })
  const { data, isLoading: listLoading } = listQuery

  const {
    data: detail,
    isLoading: detailLoading,
    isError: detailError,
    error: detailErr,
    refetch: refetchDetail,
  } = useQuery({
    queryKey: conversationKeys.detail(active || ''),
    queryFn: () => api.conversation(active!),
    enabled: !!active,
  })

  const total = data?.total ?? 0
  const items = data?.items ?? []
  // Server-side `source` filters before pagination; keep the client predicate
  // as a fallback for legacy/mock responses that omit `source` filtering.
  const visibleItems = useMemo(
    () => (sourceFilter === 'all' ? items : items.filter((c) => !c.source || c.source === sourceFilter)),
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
    if (detailError && (detailErr as { status?: number })?.status === 404) {
      if (lastActiveRef.current === active) {
        lastActiveRef.current = null
        writePageState('conversations.lastActive', null)
      }
      return
    }
    lastActiveRef.current = active
    writePageState('conversations.lastActive', active)
  }, [active, detailError, detailErr])

  useEffect(() => {
    // One-shot on entering the page without a selection: fall back to the
    // last opened conversation. Skipped after deletion via lastActiveRef=null.
    if (active || lastActiveRef.current === null) return
    nav(`/conversations/${encodeURIComponent(lastActiveRef.current)}`, { replace: true })
  }, [])
  const detailScrollPositionsRef = useRef<Record<string, number>>(
    readPageState('conversations.detailScroll', {}),
  )
  const detailReadyForRef = useRef<string | null>(null)
  const detailListRef = useRef<VirtualMessageListHandle>(null)
  const [detailStuckBottom, setDetailStuckBottom] = useState(false)
  const [detailActiveTurn, setDetailActiveTurn] = useState(0)
  const detailActiveTurnRef = useRef(0)
  const detailNavTargetRef = useRef<number | null>(null)
  const detailNavLockUntilRef = useRef(0)
  const detailJumpingBottomUntilRef = useRef(0)
  const updateDetailActiveTurn = useCallback((next: number) => {
    detailActiveTurnRef.current = next
    setDetailActiveTurn((previous) => previous === next ? previous : next)
  }, [])

  const rounds = useMemo(() => buildRounds(detail?.messages || []), [detail])
  // Non-empty only for a real chat session: the backend excludes title-only
  // archive rows from `bound_session_id`, so this drives the primary action.
  const boundSessionId = detail?.bound_session_id || null

  const navTargets = useMemo(() => {
    if (!detail) return []
    if (viewMode === 'round') {
      return rounds.map((r, idx) => ({
        id: `round:${r.index}`,
        index: r.index,
        scrollIndex: idx,
        label: r.preview || `第 ${r.index} 轮`,
      }))
    }
    const msgs = detail.messages || []
    const userStarts = msgs
      .map((m, idx) => ({ m, idx }))
      .filter(({ m }) => (m.role || '').toLowerCase() === 'user')
    if (userStarts.length > 0) {
      return userStarts.map(({ m, idx }, turnIdx) => ({
        id: `flat:${idx}`,
        index: turnIdx + 1,
        scrollIndex: idx,
        label: previewText(cleanArchiveUserText(m.content || ''), 120) || `第 ${turnIdx + 1} 轮`,
      }))
    }
    return msgs.map((m, idx) => ({
      id: `flat:${idx}`,
      index: idx + 1,
      scrollIndex: idx,
      label: previewText(m.content || '', 120) || `第 ${idx + 1} 条`,
    }))
  }, [detail, rounds, viewMode])

  const syncDetailNav = useCallback(() => {
    const el = detailScrollRef.current
    if (!el) return
    const now = performance.now()
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64
    if (detailJumpingBottomUntilRef.current > now) {
      if (atBottom) {
        detailJumpingBottomUntilRef.current = 0
      } else {
        return
      }
    }
    setDetailStuckBottom(atBottom)
    if (navTargets.length === 0) {
      updateDetailActiveTurn(0)
      return
    }
    const navTarget = detailNavTargetRef.current
    if (navTarget !== null && navTarget < navTargets.length && now < detailNavLockUntilRef.current) {
      updateDetailActiveTurn(navTarget)
      return
    }
    detailNavTargetRef.current = null
    detailNavLockUntilRef.current = 0
    let currentTurn = atBottom ? navTargets.length - 1 : 0
    if (!atBottom) {
      const firstVisible = detailListRef.current?.getFirstVisibleIndex(48) ?? 0
      for (let i = 0; i < navTargets.length; i += 1) {
        if (navTargets[i].scrollIndex <= firstVisible) currentTurn = i
        else break
      }
    }
    updateDetailActiveTurn(currentTurn)
  }, [navTargets, updateDetailActiveTurn])
  const syncDetailNavRef = useRef(syncDetailNav)
  syncDetailNavRef.current = syncDetailNav

  const detailTailIndex = useMemo(() => {
    if (!detail) return -1
    return viewMode === 'round'
      ? Math.max(-1, rounds.length - 1)
      : Math.max(-1, (detail.messages?.length ?? 0) - 1)
  }, [detail, rounds.length, viewMode])

  const jumpToDetailBottom = useCallback(() => {
    const el = detailScrollRef.current
    if (!el) return
    setDetailStuckBottom(true)
    const lastTurn = navTargets.length - 1
    detailNavTargetRef.current = lastTurn >= 0 ? lastTurn : null
    detailNavLockUntilRef.current = performance.now() + 900
    detailJumpingBottomUntilRef.current = performance.now() + 900
    if (lastTurn >= 0) updateDetailActiveTurn(lastTurn)
    if (detailTailIndex >= 0) {
      detailListRef.current?.scrollToIndex(detailTailIndex, { behavior: 'auto', align: 'end' })
    }
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      if (detailJumpingBottomUntilRef.current > performance.now()) {
        el.scrollTop = el.scrollHeight
      }
    })
  }, [detailTailIndex, navTargets.length, updateDetailActiveTurn])

  const jumpToDetailTurn = useCallback((turnIndex: number) => {
    if (navTargets.length === 0) return
    const clamped = Math.max(0, Math.min(navTargets.length - 1, turnIndex))
    const target = navTargets[clamped]
    detailNavTargetRef.current = clamped
    detailNavLockUntilRef.current = performance.now() + 700
    detailJumpingBottomUntilRef.current = 0
    updateDetailActiveTurn(clamped)
    setDetailStuckBottom(false)
    if (detailListRef.current) {
      detailListRef.current.scrollToIndex(target.scrollIndex, { behavior: 'smooth', align: 'start' })
    } else if (detailScrollRef.current) {
      detailScrollRef.current.scrollTop = 0
    }
  }, [navTargets, updateDetailActiveTurn])

  const stepDetailTurn = useCallback((delta: -1 | 1) => {
    jumpToDetailTurn(detailActiveTurnRef.current + delta)
  }, [jumpToDetailTurn])

  useEffect(() => {
    // A deep-link change reuses the same page component. Wait until the target
    // detail payload is loaded before restoring its offset so spinner mounts
    // cannot overwrite the saved scroll position.
    if (!active || !detail || (detail.id && detail.id !== active)) {
      detailReadyForRef.current = null
      return
    }
    const saved = detailScrollPositionsRef.current[active] ?? 0
    const frame = requestAnimationFrame(() => {
      if (detailScrollRef.current) detailScrollRef.current.scrollTop = saved
      detailReadyForRef.current = active
      syncDetailNavRef.current()
    })
    return () => cancelAnimationFrame(frame)
  }, [active, viewMode, detail])

  useEffect(() => {
    const el = detailScrollRef.current
    if (!el || !active) return
    let persistTimer: number | null = null
    const persistPosition = (immediate: boolean) => {
      if (detailReadyForRef.current !== active) return
      detailScrollPositionsRef.current[active] = el.scrollTop
      if (immediate) {
        if (persistTimer !== null) {
          window.clearTimeout(persistTimer)
          persistTimer = null
        }
        writePageState('conversations.detailScroll', trimDetailScrollPositions(detailScrollPositionsRef.current))
        return
      }
      if (persistTimer !== null) window.clearTimeout(persistTimer)
      persistTimer = window.setTimeout(() => {
        persistTimer = null
        if (detailReadyForRef.current === active) {
          writePageState('conversations.detailScroll', trimDetailScrollPositions(detailScrollPositionsRef.current))
        }
      }, 120)
    }
    const capture = () => {
      persistPosition(false)
      syncDetailNavRef.current()
    }
    const clearNavLock = () => {
      detailNavTargetRef.current = null
      detailNavLockUntilRef.current = 0
      detailJumpingBottomUntilRef.current = 0
    }
    const onScrollEnd = () => {
      const now = performance.now()
      if (now < detailJumpingBottomUntilRef.current || now < detailNavLockUntilRef.current) {
        syncDetailNavRef.current()
        return
      }
      clearNavLock()
      syncDetailNavRef.current()
    }
    el.addEventListener('scroll', capture, { passive: true })
    el.addEventListener('scrollend', onScrollEnd, { passive: true })
    el.addEventListener('wheel', clearNavLock, { passive: true })
    el.addEventListener('touchstart', clearNavLock, { passive: true })
    el.addEventListener('pointerdown', clearNavLock, { passive: true })
    return () => {
      el.removeEventListener('scroll', capture)
      el.removeEventListener('scrollend', onScrollEnd)
      el.removeEventListener('wheel', clearNavLock)
      el.removeEventListener('touchstart', clearNavLock)
      el.removeEventListener('pointerdown', clearNavLock)
      if (persistTimer !== null) window.clearTimeout(persistTimer)
      persistPosition(true)
    }
  }, [active])

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

  const handleDelete = async (id: string, title: string, isBound: boolean) => {
    const ok = await dialog.confirm(
      `永久删除原档「${title || id}」？`,
      isBound
        ? '原始会话文件将永久删除，关联会话也会从聊天列表移除。此操作无法撤销。'
        : '原始会话文件将永久删除，无法撤销。',
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
      await Promise.all([
        removeConversationFromCache(qc, id),
        qc.invalidateQueries({ queryKey: queryKeys.sessions }),
      ])
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
      wrapHeader
      title="历史对话"
      actions={
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="ga-segmented text-xs" role="group" aria-label="视图模式">
            {(['round', 'flat'] as ViewMode[]).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={viewMode === m}
                onClick={() => setViewMode(m)}
                className={`ga-segmented-btn inline-flex items-center gap-1.5 ${viewMode === m ? 'ga-segmented-btn-active' : ''}`}
              >
                {m === 'round'
                  ? <Layers size={13} strokeWidth={1.85} aria-hidden="true" />
                  : <MessageSquare size={13} strokeWidth={1.85} aria-hidden="true" />}
                <span>{m === 'round' ? '轮次摘要' : '对话视图'}</span>
              </button>
            ))}
          </div>
          <div className="relative flex items-center">
            <Search
              size={14}
              strokeWidth={1.85}
              aria-hidden="true"
              className="pointer-events-none absolute left-2.5 text-ink-faint"
            />
            <input
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(0) }}
              placeholder="搜索标题或内容…"
              aria-label="搜索历史对话"
              className="w-56 sm:w-64 lg:w-72 rounded-lg border border-line bg-bg-card pl-8 pr-7 py-1.5 text-sm text-ink placeholder:text-ink-faint outline-none transition-colors focus:border-accent/60 focus:ring-2 focus:ring-accent/15"
            />
            {q && (
              <button
                type="button"
                onClick={() => { setQ(''); setPage(0) }}
                aria-label="清空搜索"
                title="清空搜索"
                className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-ink-faint transition-colors hover:bg-ink/10 hover:text-ink"
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      }
    >
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[96rem] flex-col gap-5 lg:flex-row px-4 py-4 sm:gap-6 sm:px-6 sm:py-6">
        <ConversationIndexRail collapsible={false}>
          <div className="sticky top-0 z-10 border-b border-line/50 bg-bg-card/95 px-3 py-2.5 backdrop-blur-[4px]">
            <div className="flex flex-wrap items-center gap-1">
              {SOURCE_FILTERS.map((f) => {
                const activeFilter = sourceFilter === f.value
                return (
                  <button
                    key={f.value}
                    type="button"
                    aria-pressed={activeFilter}
                    onClick={() => { setSourceFilter(f.value); setPage(0) }}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      activeFilter
                        ? 'bg-accent-soft text-accent ring-1 ring-accent/35'
                        : 'text-ink-muted hover:bg-bg-soft/75 hover:text-ink'
                    }`}
                  >
                    {f.label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="space-y-1.5 p-2">
            {listLoading && items.length === 0 && (
              Array.from({ length: 4 }, (_, idx) => (
                <div key={`skeleton-${idx}`} className="rounded-lg bg-bg-card/60 px-2.5 py-2.5 animate-pulse space-y-2">
                  <div className="h-3.5 w-3/4 rounded bg-ink/10" />
                  <div className="h-2.5 w-1/2 rounded bg-ink/5" />
                </div>
              ))
            )}
            {visibleItems.map((c) => (
              <ConvRow
                key={c.id}
                c={c}
                active={active === c.id}
                titleStyle={titleStyle}
                onClick={() => nav(`/conversations/${encodeURIComponent(c.id)}`)}
              />
            ))}
            {listQuery.isError && !data && <QueryLoadState query={listQuery} label="历史对话" />}
            {!listLoading && (!listQuery.isError || data) && visibleItems.length === 0 && (
              <div className="px-3 py-8 text-center">
                <Inbox size={18} strokeWidth={1.75} aria-hidden="true" className="mx-auto mb-2 text-ink-faint/70" />
                <div className="text-xs text-ink-muted">
                  {sourceFilter !== 'all'
                    ? (items.length > 0 ? `本页没有「${filterLabel}」会话` : `暂无「${filterLabel}」归档会话`)
                    : debouncedQ
                      ? '未找到匹配的归档会话'
                      : '暂无历史对话归档'}
                </div>
                {sourceFilter !== 'all' && (
                  <button
                    type="button"
                    onClick={() => { setSourceFilter('all'); setPage(0) }}
                    className="mt-2 text-[11px] font-medium text-accent hover:underline"
                  >
                    查看全部来源
                  </button>
                )}
              </div>
            )}
          </div>
          {total > limit && (
            <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 border-t border-line/50 bg-bg-card/95 px-3 py-2 text-xs text-ink-muted backdrop-blur-[4px]">
              <button
                type="button"
                aria-label="上一页"
                title="上一页"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                className="ga-btn-sm px-2 text-[11px]"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                <span>上页</span>
              </button>
              <span
                className="tabular-nums text-[11px]"
                title={`共 ${total} 条归档，当前第 ${page + 1} / ${Math.max(1, Math.ceil(total / limit))} 页`}
              >
                第 {page + 1} / {Math.max(1, Math.ceil(total / limit))} 页
              </span>
              <button
                type="button"
                aria-label="下一页"
                title="下一页"
                disabled={(page + 1) * limit >= total}
                onClick={() => setPage(page + 1)}
                className="ga-btn-sm px-2 text-[11px]"
              >
                <span>下页</span>
                <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          )}
        </ConversationIndexRail>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={detailScrollRef} className="min-h-0 flex-1 overflow-y-auto pr-12 [overflow-anchor:none]">
          {!active && (
            <div className="flex h-full items-center justify-center p-2">
              <div className="ga-paper-card max-w-sm px-8 py-9 text-center">
                <div className="mx-auto mb-3.5 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft/80 text-accent ring-1 ring-accent/20">
                  <History size={20} strokeWidth={1.85} aria-hidden="true" />
                </div>
                <p className="text-sm font-medium text-ink">选择左侧会话查看详情</p>
                <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                  支持按轮次梳理过程摘要与结论，或切换完整对话流；也可一键恢复到实时对话继续协作。
                </p>
              </div>
            </div>
          )}
          {active && detailLoading && !detail && (
            <div role="status" className="flex h-full items-center justify-center p-2">
              <div className="ga-paper-card flex items-center gap-2.5 px-5 py-3.5 text-sm text-ink-muted">
                <LoaderCircle size={16} strokeWidth={1.85} aria-hidden="true" className="animate-spin text-accent" />
                <span>正在读取会话详情…</span>
              </div>
            </div>
          )}
          {active && detailError && !detail && (
            <div role="alert" className="flex h-full items-center justify-center p-2">
              <div className="max-w-md rounded-2xl border border-status-danger-line bg-status-danger-soft/75 px-6 py-6 text-center shadow-sm">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-status-danger-soft text-status-danger ring-1 ring-status-danger-line">
                  <AlertTriangle size={18} strokeWidth={1.85} aria-hidden="true" />
                </div>
                <div className="text-sm font-medium text-status-danger">读取会话详情失败：{errorMessageFromError(detailErr)}</div>
                <div className="mt-4 flex items-center justify-center gap-2">
                  <button type="button" onClick={() => { void refetchDetail() }} className="ga-btn h-8 px-3 text-xs">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>重试</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      lastActiveRef.current = null
                      writePageState('conversations.lastActive', null)
                      nav('/conversations', { replace: true })
                    }}
                    className="ga-btn h-8 px-3 text-xs"
                  >
                    <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>返回列表</span>
                  </button>
                </div>
              </div>
            </div>
          )}
          {active && detail && (() => {
            const detailMeta = sourceMeta(detail.source)
            const matchedSummary = items.find((item) => item.id === detail.id)
            const lastActivityText = matchedSummary ? formatRelativeTime(matchedSummary.mtime) : ''
            return (
              <div className="mx-auto max-w-4xl pb-8">
                <header className="ga-paper-card mb-4 px-4 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold leading-snug text-ink" title={conversationDisplayTitle(detail)}>
                      {conversationDisplayTitle(detail)}
                    </h2>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-[11px]">
                      <span className={`rounded-md border px-1.5 py-0.5 font-medium leading-none ${detailMeta.chipClass}`}>
                        {detailMeta.label}
                      </span>
                      <span className="rounded-md border border-line/55 bg-bg-soft/85 px-1.5 py-0.5 tabular-nums leading-none text-ink-muted">
                        {detail.messages?.length || 0} 条 · {rounds.length} 轮
                      </span>
                      {lastActivityText && (
                        <span className="inline-flex items-center gap-1 rounded-md border border-line/55 bg-bg-soft/85 px-1.5 py-0.5 tabular-nums leading-none text-ink-faint">
                          <Clock size={10} strokeWidth={1.85} aria-hidden="true" />
                          <span>{lastActivityText}</span>
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    {boundSessionId ? (
                      <button
                        type="button"
                        onClick={() => { void openSession(boundSessionId) }}
                        className="ga-btn-sm-primary shrink-0"
                        title="打开对应会话继续对话"
                      >
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>打开该会话</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { void handleImport(detail.id) }}
                        disabled={importing === detail.id}
                        className="ga-btn-sm-primary shrink-0"
                        title="导入为新会话继续对话"
                      >
                        <FolderDown className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{importing === detail.id ? '导入中…' : '导入为会话'}</span>
                      </button>
                    )}
                    <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                      <div className="ga-btn-group">
                        <button
                          type="button"
                          onClick={() => handleRename(detail.id, detail.title || '')}
                          className="ga-btn-group-item"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>重命名</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(detail.id, detail.title || '', !!boundSessionId)}
                          className="ga-btn-group-item-danger"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>永久删除原档</span>
                        </button>
                      </div>
                      <div className="ga-btn-group">
                        <button
                          type="button"
                          onClick={() => handleExport(detail.id, 'md')}
                          className="ga-btn-group-item"
                        >
                          <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>导出 MD</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExport(detail.id, 'json')}
                          className="ga-btn-group-item"
                        >
                          <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>JSON</span>
                        </button>
                      </div>
                    </div>
                  </div>
                </header>

                <div data-chat-scope>
                  {viewMode === 'round'
                    ? (
                      <RoundView
                        key={`round:${detail.id}`}
                        convId={detail.id}
                        rounds={rounds}
                        scrollRef={detailScrollRef}
                        listRef={detailListRef}
                        openConclusion={openConclusion}
                        setOpenConclusion={setOpenConclusion}
                        messageFontStyle={messageFontStyle}
                      />
                    )
                    : (
                      <FlatView
                        key={`flat:${detail.id}`}
                        messages={detail.messages || []}
                        scrollRef={detailScrollRef}
                        listRef={detailListRef}
                        messageFontStyle={messageFontStyle}
                      />
                    )}
                </div>
              </div>
            )
          })()}
        </div>
        {active && detail && navTargets.length > 0 && (
          <TranscriptUtilityRail
            className="pointer-events-none absolute inset-y-3 right-2 z-10 flex w-14 flex-col items-center gap-2 pt-[52px]"
            minimap={(
              <ConversationTurnMinimap
                items={navTargets}
                activeIndex={detailActiveTurn}
                onSelect={jumpToDetailTurn}
              />
            )}
            navDock={(
              <TranscriptNavDock
                stuckBottom={detailStuckBottom}
                canPrev={detailActiveTurn > 0}
                canNext={detailActiveTurn < navTargets.length - 1}
                onJumpToBottom={jumpToDetailBottom}
                onPrev={() => stepDetailTurn(-1)}
                onNext={() => stepDetailTurn(1)}
              />
            )}
          />
        )}
        </div>
      </div>
    </PageShell>
  )
}

function cleanArchiveUserText(raw: string): string {
  if (!raw) return ''
  const cleaned = raw
    .replace(/^\[?用户发送文件:[^\]\n]*\]?\s*$/gm, '')
    .replace(/\[FILE:[^\]\n]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned || raw
}

function RoundView({
  convId,
  rounds,
  scrollRef,
  listRef,
  openConclusion,
  setOpenConclusion,
  messageFontStyle,
}: {
  convId: string
  rounds: Round[]
  scrollRef: RefObject<HTMLDivElement>
  listRef?: RefObject<VirtualMessageListHandle>
  openConclusion: Record<string, boolean>
  setOpenConclusion: React.Dispatch<React.SetStateAction<Record<string, boolean>>>
  messageFontStyle?: CSSProperties
}) {
  const renderRound = useCallback((r: Round) => {
    const roundKey = `${convId}:${r.index}`
    const isProcessOpen = !!openConclusion[roundKey]
    const summaryText = r.conclusion || r.turnSummaries[r.turnSummaries.length - 1]?.summary || '（无结论）'
    const detailText = r.detail && r.detail !== '（暂无最终正文）' ? r.detail : summaryText
    const hasTurnSummaries = r.turnSummaries.length > 0

    return (
      <div className="pb-6">
        <div className="mb-3.5 flex items-center gap-3">
          <div className="h-px flex-1 bg-line/55" />
          <span className="inline-flex items-center rounded-full border border-line/70 bg-bg-card/90 px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-ink-muted shadow-[0_1px_2px_rgba(45,34,22,0.04)]">
            第 {r.index} 轮
          </span>
          <div className="h-px flex-1 bg-line/55" />
        </div>

        <div className="space-y-3.5">
          {r.user && (
            <div className="flex justify-start">
              <div
                data-chat-box
                className={`group/msg relative max-w-[88%] rounded-lg px-3.5 py-2.5 leading-7 shadow-[0_2px_6px_rgba(45,34,22,0.16)] ${bubbleTone('user').surfaceClass}`}
                style={messageFontStyle}
              >
                <MessageContent content={cleanArchiveUserText(r.user.content || '')} format="text" />
              </div>
            </div>
          )}

          <div className="flex justify-start">
            <div
              data-chat-box
              className={`group/msg relative min-w-0 max-w-[92%] rounded-lg px-4 py-3 leading-7 shadow-[0_2px_6px_rgba(45,34,22,0.12)] ${bubbleTone('assistant').surfaceClass}`}
              style={messageFontStyle}
            >
              <div data-chat-box-chrome className="mb-2 flex min-h-6 select-none items-center justify-between gap-3 text-[11px] font-medium text-ink-muted">
                <span className="inline-flex shrink-0 items-center gap-2">
                  <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#54735D]" />
                  GA Agent
                </span>
                <div className="pointer-events-none flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                  <ReplyActions text={detailText} engine="chat" canSave={false} />
                </div>
              </div>

              {hasTurnSummaries && (
                <div className="mb-2.5 flex items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={isProcessOpen}
                    onClick={() => setOpenConclusion((s) => ({ ...s, [roundKey]: !isProcessOpen }))}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-line/70 bg-bg-soft/85 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:border-accent/45 hover:bg-accent-soft/50"
                  >
                    <ChevronDisclosureIcon open={isProcessOpen} size={12} />
                    <span>{isProcessOpen ? '收起过程' : '展开过程'}</span>
                  </button>
                  <span className="text-[11px] tabular-nums text-ink-faint">
                    {r.turnSummaries.length} 步
                  </span>
                </div>
              )}

              {isProcessOpen && hasTurnSummaries && (
                <div className="mb-3.5 rounded-lg border border-line/60 bg-bg-soft/75 px-3 py-2.5">
                  <div className="mb-2 text-xs font-medium text-ink-faint">过程摘要</div>
                  <div className="space-y-2 border-l-2 border-accent/25 pl-3">
                    {r.turnSummaries.map((ts, idx) => (
                      <div key={`${roundKey}-ts-${idx}`} className="text-sm leading-relaxed text-ink">
                        <span className="mr-2 inline-block rounded bg-bg-card px-1.5 py-0.5 font-mono text-[11px] font-medium text-ink-muted ring-1 ring-line/60">
                          Turn {ts.turn}
                        </span>
                        <span className="whitespace-pre-wrap">{ts.summary}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {detailText && (
                <div className={isProcessOpen && hasTurnSummaries ? 'border-t border-line/45 pt-3' : ''}>
                  {isProcessOpen && hasTurnSummaries && (
                    <div className="mb-2 text-xs font-medium text-ink-faint">最终回答</div>
                  )}
                  <MessageContent content={detailText} format="markdown" />
                </div>
              )}
            </div>
          </div>

          {r.others.length > 0 && (
            <div className="space-y-2">
              {r.others.map((m, idx) => (
                <MessageBlock
                  key={`o-${idx}`}
                  m={m}
                  label={m.role || `message ${idx + 1}`}
                  tone="other"
                  messageFontStyle={messageFontStyle}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    )
  }, [convId, messageFontStyle, openConclusion, setOpenConclusion])

  if (rounds.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line/75 bg-bg-card/55 py-10 text-center text-sm text-ink-faint">
        该会话暂无消息
      </div>
    )
  }

  return (
    <VirtualMessageList
      ref={listRef}
      items={rounds}
      scrollRef={scrollRef}
      virtualizationThreshold={12}
      overscanPx={700}
      itemKey={roundItemKey}
      estimateSize={estimateRoundSize}
      renderItem={renderRound}
    />
  )
}

function FlatView({
  messages,
  scrollRef,
  listRef,
  messageFontStyle,
}: {
  messages: Msg[]
  scrollRef: RefObject<HTMLDivElement>
  listRef?: RefObject<VirtualMessageListHandle>
  messageFontStyle?: CSSProperties
}) {
  const renderFlatMessage = useCallback((m: Msg, i: number) => {
    const isUser = m.role === 'user'
    const isAssistant = m.role === 'assistant'
    const label = isUser ? '你' : isAssistant ? 'GA Agent' : (m.role || `消息 ${i + 1}`)
    return (
      <div className="pb-3">
        <div className="flex justify-start">
          <div className="w-fit max-w-[90%]">
            <MessageBlock
              m={m}
              label={label}
              tone={isUser ? 'user' : isAssistant ? 'assistant' : 'other'}
              messageFontStyle={messageFontStyle}
            />
          </div>
        </div>
      </div>
    )
  }, [messageFontStyle])

  if (messages.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-line/75 bg-bg-card/55 py-10 text-center text-sm text-ink-faint">
        该会话暂无消息
      </div>
    )
  }

  return (
    <VirtualMessageList
      ref={listRef}
      items={messages}
      scrollRef={scrollRef}
      virtualizationThreshold={12}
      overscanPx={700}
      itemKey={flatMessageKey}
      estimateSize={estimateFlatMessageSize}
      renderItem={renderFlatMessage}
    />
  )
}

function MessageBlock({
  m,
  label,
  tone,
  messageFontStyle,
}: {
  m: Msg
  label: string
  tone: 'user' | 'assistant' | 'other'
  messageFontStyle?: CSSProperties
}) {
  const isUser = tone === 'user'
  const isAssistant = tone === 'assistant'
  const displayText = isUser ? cleanArchiveUserText(m.content || '') : (m.content || '')
  return (
    <div
      data-chat-box
      className={`group/msg rounded-lg px-3.5 py-2.5 leading-7 shadow-[0_2px_6px_rgba(45,34,22,0.13)] ${bubbleTone(tone).surfaceClass}`}
      style={messageFontStyle}
    >
      {isAssistant && (
        <div data-chat-box-chrome className="mb-1.5 flex min-h-6 select-none items-center justify-between gap-3 text-[11px] font-medium text-ink-muted">
          <span className="inline-flex shrink-0 items-center gap-2">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#54735D]" />
            {label}
          </span>
          <div className="pointer-events-none flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
            <ReplyActions text={displayText} engine="chat" canSave={false} />
          </div>
        </div>
      )}
      {tone === 'other' && (
        <div data-chat-box-chrome className="mb-1 select-none text-[11px] font-medium text-ink-faint">{label}</div>
      )}
      {/* User prompts are literal input everywhere (live chat, round view);
          the flat view previously markdown-rendered them — converge on text. */}
      <MessageContent
        content={displayText}
        format={isUser ? 'text' : 'markdown'}
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
      const transcript = parseAssistantTranscript(m.content || '', false, m.turn_segs)
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
    || previewText(cleanArchiveUserText(conversation.original_user_preview || ''))
    || '未命名会话'
}

function ConvRow({ c, active, titleStyle, onClick }: {
  c: ConversationSummary
  active: boolean
  titleStyle?: CSSProperties
  onClick: () => void
}) {
  const title = summaryDisplayTitle(c)
  const meta = sourceMeta(c.source)
  const lastActive = formatRelativeTime(c.mtime)
  const countsText = conversationCountsText(c)

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`group/row relative block w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
        active
          ? 'bg-accent-soft/55 shadow-[0_1px_3px_rgba(45,34,22,0.08)] ring-1 ring-accent/35'
          : 'hover:bg-bg-soft/75'
      }`}
    >
      {active && (
        <span aria-hidden="true" className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-accent" />
      )}
      <div className="flex items-start justify-between gap-2">
        <div
          className={`min-w-0 flex-1 line-clamp-2 break-words text-[13px] leading-snug ${active ? 'font-semibold text-ink' : 'font-medium text-ink/90'}`}
          style={titleStyle}
          title={title}
        >
          {title}
        </div>
        <span
          className={`mt-0.5 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none ${meta.chipClass}`}
          title={`来源：${meta.label}`}
        >
          {meta.label}
        </span>
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-ink-faint">
        {countsText && (
          <span className="truncate" title={CONVERSATION_COUNTS_HELP}>
            {countsText}
          </span>
        )}
        {lastActive && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
            <Clock size={10} strokeWidth={1.85} aria-hidden="true" className="opacity-75" />
            <span>{lastActive}</span>
          </span>
        )}
      </div>
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
