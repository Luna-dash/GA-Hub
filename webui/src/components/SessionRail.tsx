import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { HubSession, ProjectItem, SessionRuntime } from '@/api/types'
import { sessionActivity, sessionPreview, sessionRecencyMs, sessionStatusLabel } from '@/utils/sessionUi'
import { usePageState } from '@/utils/pageState'
import { RAIL_TITLE_SCALE_EVENT, railTitlePercent, getRailTitleScale } from '@/utils/railAppearance'
import { storageKeys } from '@/config/storageKeys'
import {
  ChevronDown,
  CollapseChevronsIcon,
  Download,
  PinGlyph,
  Plus,
  RailFoldGlyph,
  Trash2,
} from './ActionIcons'

interface SessionRailProps {
  storageScope?: 'anti'
  deleteDetail?: string
  projects?: ProjectItem[]
  sessions: HubSession[]
  runtimes: Record<string, SessionRuntime>
  currentId: string | null
  onSelect: (sessionId: string) => void
  onCreate?: () => Promise<void> | void
  /** Second entry of the create menu: adopt an archive from the history page.
   * The rail only routes there — picking an archive needs the full index. */
  onImportFromHistory?: () => void
  onRename?: (sessionId: string, title: string) => Promise<void> | void
  onDelete?: (sessionId: string) => Promise<void> | void
  creating?: boolean
}

const activityDot = {
  // Glow rings reuse the status hex from tailwind.config.js — the old
  // emerald/sky/rose rgba values were pre-palette hues that no token owns.
  active: 'bg-status-success shadow-[0_0_0_3px_rgba(45,106,63,0.18)]',
  completed: 'bg-status-info shadow-[0_0_0_3px_rgba(40,90,120,0.16)]',
  // Idle is a neutral on purpose (palette comment sanctions it), shared
  // with Conductor's stopped dot — one hex, not two near-misses.
  idle: 'bg-[#9A8E7D]',
  error: 'bg-status-danger shadow-[0_0_0_3px_rgba(158,51,40,0.16)]',
  unknown: 'bg-status-warning',
}

const activityCard = {
  active: 'bg-status-success-soft text-status-success',
  completed: 'bg-status-info-soft text-status-info',
  idle: 'text-ink-muted hover:bg-bg-card',
  error: 'bg-status-danger-soft text-status-danger',
  unknown: 'bg-status-warning-soft text-status-warning',
}

const activityLabel = {
  active: '运行中',
  completed: '已完成',
  idle: '空闲',
  error: '异常',
  unknown: '空闲',
}

const activityRail = {
  active: 'bg-status-success shadow-[0_0_0_3px_rgba(60,138,82,0.13)] group-hover:bg-status-success-strong',
  completed: 'bg-status-info shadow-[0_0_0_3px_rgba(31,74,99,0.11)] group-hover:bg-status-info-strong',
  idle: 'bg-[#8D7B5D]/55 shadow-[0_0_0_3px_rgba(141,123,93,0.10)] group-hover:bg-[#8D7B5D]/70',
  error: 'bg-status-danger shadow-[0_0_0_3px_rgba(126,42,32,0.11)] group-hover:bg-status-danger-strong',
  unknown: 'bg-status-warning shadow-[0_0_0_3px_rgba(154,83,21,0.11)] group-hover:bg-status-warning-strong',
}

const LEGACY_RECENT_KEY = storageKeys.sessionRailLegacyRecentActivity
const TERMINAL_KEY = storageKeys.sessionRailTerminalState
const SEEN_COMPLETED_KEY = storageKeys.sessionRailSeenCompletedRuns
const GROUP_COLLAPSE_KEY = storageKeys.sessionRailGroupCollapse
const GROUP_SHOW_ALL_KEY = storageKeys.sessionRailGroupShowAll
/** 组内默认态预览条数（v3 三态中的 D；标题行展开按钮也使用此阈值）。 */
const GROUP_PREVIEW_LIMIT = 3
const PINNED_GROUPS_KEY = storageKeys.sessionRailGroupPinned
type TerminalState = 'completed' | 'error'
type TerminalMap = Record<string, TerminalState>
type SessionGroup = { key: string; name: string; projectPath: string | null; sessions: HubSession[] }

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '')
    return value && typeof value === 'object' ? value as T : fallback
  } catch {
    return fallback
  }
}

function sessionTitle(session: HubSession) {
  return session.title.trim() || `未命名会话 · ${session.id.slice(0, 8)}`
}

function SessionRailComponent({ projects: projectItems, sessions, runtimes, currentId, onSelect, onCreate, onImportFromHistory, onRename, onDelete, creating, storageScope, deleteDetail }: SessionRailProps) {
  const [collapsed, setCollapsed] = usePageState(storageScope === 'anti' ? 'antiChat.sessionRailCollapsed' : 'liveChat.sessionRailCollapsed', storageScope !== 'anti')
  const terminal_key = storageScope ? `${TERMINAL_KEY}.${storageScope}` : TERMINAL_KEY
  const seen_completed_key = storageScope ? `${SEEN_COMPLETED_KEY}.${storageScope}` : SEEN_COMPLETED_KEY
  const group_collapse_key = storageScope ? `${GROUP_COLLAPSE_KEY}.${storageScope}` : GROUP_COLLAPSE_KEY
  const group_show_all_key = storageScope ? `${GROUP_SHOW_ALL_KEY}.${storageScope}` : GROUP_SHOW_ALL_KEY
  const pinned_groups_key = storageScope ? `${PINNED_GROUPS_KEY}.${storageScope}` : PINNED_GROUPS_KEY
  const [editingId, setEditingId] = useState<string | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const deleteConfirmRef = useRef<HTMLDivElement>(null)
  const [terminalState, setTerminalState] = useState<TerminalMap>(() => readJson<TerminalMap>(terminal_key, {}))
  const [seenCompletedRuns, setSeenCompletedRuns] = useState<Record<string, string>>(
    () => readJson<Record<string, string>>(seen_completed_key, {}),
  )
  const previousActivity = useRef<Record<string, ReturnType<typeof sessionActivity>>>({})
  // 置顶的分组键按置顶先后排列，持久化到本设备；未置顶组仍按最近活动排序。
  const [pinnedGroups, setPinnedGroups] = useState<string[]>(() => {
    const stored = readJson<string[]>(pinned_groups_key, [])
    return Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : []
  })

  useEffect(() => {
    if (!storageScope) {
      try { localStorage.removeItem(LEGACY_RECENT_KEY) } catch { /* legacy cleanup */ }
    }
  }, [storageScope])

  useEffect(() => {
    const nextTerminal = { ...terminalState }
    const nextPrevious = { ...previousActivity.current }
    let terminalChanged = false

    sessions.forEach((session) => {
      const activity = sessionActivity(runtimes[session.id])
      const previous = nextPrevious[session.id]
      if (activity === 'active') {
        if (nextTerminal[session.id]) {
          delete nextTerminal[session.id]
          terminalChanged = true
        }
      } else if (activity === 'error' && previous === 'active' && nextTerminal[session.id] !== 'error') {
        nextTerminal[session.id] = 'error'
        terminalChanged = true
      } else if (
        activity === 'idle'
        && runtimes[session.id]?.completed_run_id
        && seenCompletedRuns[session.id] !== runtimes[session.id].completed_run_id
        && nextTerminal[session.id] !== 'completed'
      ) {
        nextTerminal[session.id] = 'completed'
        terminalChanged = true
      } else if (activity === 'idle' && previous === 'active' && nextTerminal[session.id] !== 'completed') {
        nextTerminal[session.id] = 'completed'
        terminalChanged = true
      }
      nextPrevious[session.id] = activity
    })

    previousActivity.current = nextPrevious
    if (terminalChanged) {
      setTerminalState(nextTerminal)
      localStorage.setItem(terminal_key, JSON.stringify(nextTerminal))
    }
  }, [runtimes, sessions, seenCompletedRuns, terminalState])

  const orderedSessions = useMemo(() => {
    // Single stable key: latest activity first. Deliberately NOT state-grouped
    // (the old unstarted/active/other bands made a session jump between bands
    // whenever a run started or stopped), so stopping a run never moves a row.
    // Ties keep the incoming order (Array#sort is stable) — that order is the
    // sidecar's own recency sort, so there is no second client-side opinion.
    return [...sessions].sort((a, b) => sessionRecencyMs(b) - sessionRecencyMs(a))
  }, [sessions])

  const displayState = (session: HubSession): 'active' | 'completed' | 'idle' | 'error' => {
    const activity = sessionActivity(runtimes[session.id])
    if (activity === 'active') return 'active'
    return terminalState[session.id] || activity
  }

  // 项目抽屉：自由会话一组，其余按 project_name 分组；组间按最近活动排序，
  // 与会话行共用同一把稳定钥匙（活动时间），不因运行状态切换而跳变。
  const sessionGroups = useMemo<SessionGroup[]>(() => {
    const free: HubSession[] = []
    const projects = new Map<string, HubSession[]>()
    orderedSessions.forEach((session) => {
      const name = session.project_name?.trim()
      if (!name) {
        free.push(session)
        return
      }
      const bucket = projects.get(name)
      if (bucket) bucket.push(session)
      else projects.set(name, [session])
    })
    const groupActivity = (list: HubSession[]) => list.reduce(
      (latest, session) => Math.max(latest, sessionRecencyMs(session)),
      0,
    )
    const groups: SessionGroup[] = [
      { key: 'free', name: '自由会话', projectPath: null, sessions: free },
      ...Array.from(projects.entries()).map(([name, sessions]) => ({
        key: `project:${name}`,
        name: projectItems?.find(project => project.name === name)?.display_name || name.replace(/-[a-f0-9]{8}$/i, '') || name,
        projectPath: sessions[0]?.project_path || null,
        sessions,
      })),
    ].filter((group) => group.sessions.length > 0)
    // 置顶组稳定排在最前（按置顶先后），其余组仍按最近活动排序。
    // 注意不能对未置顶组用 Infinity 下标相减：Infinity - Infinity = NaN 会让
    // sort 行为不可预期，必须显式分支比较。
    groups.sort((a, b) => {
      const aIndex = pinnedGroups.indexOf(a.key)
      const bIndex = pinnedGroups.indexOf(b.key)
      const aPinned = aIndex !== -1
      const bPinned = bIndex !== -1
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      if (aPinned && bPinned) return aIndex - bIndex
      return groupActivity(b.sessions) - groupActivity(a.sessions)
    })
    return groups
  }, [orderedSessions, pinnedGroups, projectItems])
  const hasProjectGroups = sessionGroups.some((group) => group.key !== 'free')

  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    () => readJson<Record<string, boolean>>(group_collapse_key, {}),
  )
  const [showAllGroups, setShowAllGroups] = useState<Record<string, boolean>>(
    () => readJson<Record<string, boolean>>(group_show_all_key, {}),
  )

  // v3 三态：C（全折叠，collapsed[key]=true）/ D（默认预览 ≤3）/ E（展开全部，
  // showAll[key]=true）。两个存储对象互斥写入，皆非 true 即 D。
  // 组头 chevron 只走 C ↔ D（从 C 展开恒回默认，绝不直接落回 E）；E 由标题行图标
  // 进入/退出（折叠时也可直接展开全部）；E 态下组内活动抬升（含提交/btw/回退的乐观 updated_at）时
  // 自动落回 D（见下方 effect）。
  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((current) => {
      const next = { ...current }
      if (current[key] === true) delete next[key] // C → D
      else next[key] = true // D/E → C；E 的悬挂标志由随后的 showAll 清理
      try { localStorage.setItem(group_collapse_key, JSON.stringify(next)) } catch { /* 私有模式等 */ }
      return next
    })
    setShowAllGroups((current) => {
      if (current[key] !== true) return current
      const next = { ...current }
      delete next[key]
      try { localStorage.setItem(group_show_all_key, JSON.stringify(next)) } catch { /* 私有模式等 */ }
      return next
    })
  }, [])

  const toggleGroupShowAll = useCallback((key: string) => {
    setCollapsedGroups((current) => {
      if (current[key] !== true) return current
      const next = { ...current }
      delete next[key]
      try { localStorage.setItem(group_collapse_key, JSON.stringify(next)) } catch { /* 私有模式等 */ }
      return next
    })
    setShowAllGroups((current) => {
      const next = { ...current }
      if (current[key] === true) delete next[key] // E → D
      else next[key] = true // C/D → E；collapsed 标志同时清除
      try { localStorage.setItem(group_show_all_key, JSON.stringify(next)) } catch { /* 私有模式等 */ }
      return next
    })
  }, [])

  // E 态只活在纯浏览时段：组内任一会话的最近活动被抬升即回落默认态。首帧只建立
  // 基线，不算激活——刷新页面后 E 照常保留。
  const previousGroupActivity = useRef<Record<string, number>>({})
  useEffect(() => {
    const next: Record<string, number> = {}
    const activated: string[] = []
    for (const group of sessionGroups) {
      const latest = group.sessions.reduce(
        (max, session) => Math.max(max, sessionRecencyMs(session)),
        0,
      )
      next[group.key] = latest
      const before = previousGroupActivity.current[group.key]
      if (before !== undefined && latest > before) activated.push(group.key)
    }
    previousGroupActivity.current = next
    if (activated.length === 0) return
    setShowAllGroups((current) => {
      if (!activated.some((key) => current[key] === true)) return current
      const updated = { ...current }
      for (const key of activated) delete updated[key]
      try { localStorage.setItem(group_show_all_key, JSON.stringify(updated)) } catch { /* 私有模式等 */ }
      return updated
    })
  }, [sessionGroups])

  const attentionSessions = useMemo(() => (
    orderedSessions
      .filter((session) => {
        const activity = displayState(session)
        return activity === 'active' || activity === 'completed' || activity === 'error'
      })
      .slice(0, 3)
      .reverse()
  ), [orderedSessions, runtimes, terminalState])

  const acknowledgeSession = useCallback((sessionId: string) => {
    const completedRunId = runtimes[sessionId]?.completed_run_id
    if (completedRunId) {
      const storedSeen = readJson<Record<string, string>>(seen_completed_key, {})
      if (storedSeen[sessionId] !== completedRunId) {
        const nextSeen = { ...storedSeen, [sessionId]: completedRunId }
        localStorage.setItem(seen_completed_key, JSON.stringify(nextSeen))
        setSeenCompletedRuns(nextSeen)
      }
    }

    const storedTerminal = readJson<TerminalMap>(terminal_key, {})
    if (storedTerminal[sessionId]) {
      const nextStored = { ...storedTerminal }
      delete nextStored[sessionId]
      localStorage.setItem(terminal_key, JSON.stringify(nextStored))
    }
    setTerminalState((current) => {
      if (!current[sessionId]) return current
      const next = { ...current }
      delete next[sessionId]
      return next
    })
  }, [runtimes])

  useEffect(() => {
    if (!currentId) return
    const acknowledgeCurrent = () => acknowledgeSession(currentId)
    window.addEventListener('pointerdown', acknowledgeCurrent, true)
    window.addEventListener('keydown', acknowledgeCurrent, true)
    window.addEventListener('wheel', acknowledgeCurrent, true)
    window.addEventListener('focus', acknowledgeCurrent)
    return () => {
      window.removeEventListener('pointerdown', acknowledgeCurrent, true)
      window.removeEventListener('keydown', acknowledgeCurrent, true)
      window.removeEventListener('wheel', acknowledgeCurrent, true)
      window.removeEventListener('focus', acknowledgeCurrent)
    }
  }, [acknowledgeSession, currentId])

  const selectSession = (sessionId: string) => {
    acknowledgeSession(sessionId)
    onSelect(sessionId)
  }

  const toggle = () => {
    setCollapsed((current) => !current)
  }

  const togglePin = useCallback((key: string) => {
    setPinnedGroups((current) => {
      const next = current.includes(key)
        ? current.filter((pinned) => pinned !== key)
        : [key, ...current]
      try { localStorage.setItem(pinned_groups_key, JSON.stringify(next)) } catch { /* 私有模式等 */ }
      return next
    })
  }, [])

  const createEmptySession = () => {
    void onCreate?.()
  }

  const importFromHistory = () => {
    onImportFromHistory?.()
  }

  const beginRename = (session: HubSession) => {
    setEditingId(session.id)
    setTitleDraft(session.title)
  }

  const finishRename = async (session: HubSession) => {
    if (savingId) return
    const title = titleDraft.trim()
    setEditingId(null)
    if (!onRename || title === session.title) return
    setSavingId(session.id)
    try {
      await onRename(session.id, title)
    } finally {
      setSavingId(null)
    }
  }

  // The confirm strip must not be sticky. It used to be dismissable only
  // through its own 取消 button, which at this rail width read as a trap — a
  // stray strip also sat on top of the row behind it. A press anywhere outside
  // the strip (or Escape) cancels instead. While a delete is in flight the
  // strip is pinned: it is the only place showing 删除中….
  useEffect(() => {
    if (!confirmDeleteId || deletingId) return
    const dismiss = (event: Event) => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      const target = event.target
      if (event.type !== 'keydown' && target instanceof Node && deleteConfirmRef.current?.contains(target)) return
      setConfirmDeleteId(null)
    }
    window.addEventListener('pointerdown', dismiss, true)
    window.addEventListener('keydown', dismiss, true)
    return () => {
      window.removeEventListener('pointerdown', dismiss, true)
      window.removeEventListener('keydown', dismiss, true)
    }
  }, [confirmDeleteId, deletingId])

  const removeSession = async (session: HubSession) => {
    if (!onDelete || deletingId || sessionActivity(runtimes[session.id]) === 'active') return
    setDeletingId(session.id)
    try {
      await onDelete(session.id)
      setConfirmDeleteId(null)
    } finally {
      setDeletingId(null)
    }
  }

  // 会话管理栏标题字号：100% 对应桌面保存的旧 60% 大小，仅当前设备。
  const [titleScale, setTitleScale] = useState(getRailTitleScale)
  useEffect(() => {
    const sync = (event: Event) => setTitleScale((event as CustomEvent<number>).detail || getRailTitleScale())
    window.addEventListener(RAIL_TITLE_SCALE_EVENT, sync)
    return () => window.removeEventListener(RAIL_TITLE_SCALE_EVENT, sync)
  }, [])

  return (
    <div
      data-collapsed={collapsed ? 'true' : 'false'}
      className={clsx(
        'relative z-20 shrink-0 transition-[width,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
        collapsed ? 'h-0 w-full md:h-auto md:w-0' : 'h-32 w-full md:h-auto md:w-[200px]',
      )}
    >
      <aside
        aria-label="会话工作区"
        aria-hidden={collapsed}
        className={clsx(
          'absolute inset-0 overflow-x-auto border-b border-line/70 bg-bg-card/55 p-2 md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r',
          'transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
          collapsed
            ? 'pointer-events-none -translate-y-3 opacity-0 md:-translate-x-3 md:translate-y-0'
            : 'translate-x-0 translate-y-0 opacity-100',
        )}
      >
        {(onCreate || onImportFromHistory) && (
          // 单一组件三段式：左窄条「＋」与中部「新会话」触发同一动作，右侧图
          // 标区是历史导入。整体底色比页面大背景深一档（bg-soft），导入区回到
          // 大背景色（bg），作为「次要入口」的视觉层级。
          <div
            data-testid="create-session-row"
            className="mb-3 flex w-full items-stretch overflow-hidden rounded-xl border border-line/70 bg-bg-soft shadow-sm"
          >
            {onCreate && (
              <Fragment>
                <button
                  type="button"
                  onClick={createEmptySession}
                  disabled={creating}
                  aria-label="新建空会话"
                  title="新建空会话"
                  className="flex w-8 flex-none items-center justify-center border-r border-line/50 text-accent transition hover:bg-black/5 active:scale-[0.98] disabled:opacity-50"
                >
                  <Plus className="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={createEmptySession}
                  disabled={creating}
                  aria-label="新建会话"
                  data-testid="create-session-empty"
                  className="min-w-0 flex-1 px-2 py-2.5 text-center text-sm font-semibold text-accent transition hover:bg-black/5 active:scale-[0.99] disabled:opacity-50"
                >
                  {creating ? '创建中…' : '新会话'}
                </button>
              </Fragment>
            )}
            {onImportFromHistory && (
              <button
                type="button"
                onClick={importFromHistory}
                aria-label="历史导入"
                title="从历史导入…"
                data-testid="create-session-import"
                className="flex w-9 flex-none items-center justify-center border-l border-line/50 bg-bg text-ink-muted transition hover:text-ink active:scale-[0.98]"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        <div className="flex gap-2 md:flex-col md:gap-3">
          {sessionGroups.map((group) => {
            const groupClosed = collapsedGroups[group.key] === true
            const sessions = group.sessions
            if (sessions.length === 0) return null
            // v3 三态可见集：C（上面的 groupClosed）→ 0 条；D → 最近 3 条（当前
            // 会话不在其中时顶入第 3 位，保证可见）；E → 全量，经标题行图标进入。
            // 纯自由区（rail 里没有任何项目分组可被遮挡）不参与收折：恒全量、无链接。
            const groupExpandable = hasProjectGroups && sessions.length > GROUP_PREVIEW_LIMIT
            const groupShowAll = groupExpandable && !groupClosed && showAllGroups[group.key] === true
            const visibleSessions = !hasProjectGroups || groupShowAll
              ? sessions
              : sessionPreview(sessions, currentId, GROUP_PREVIEW_LIMIT)
            const cards = (
              <div className={clsx('flex gap-1 md:flex-col md:gap-0.5', hasProjectGroups && !groupClosed && 'md:pl-1')}>
                {visibleSessions.map((session) => {
                  const runtime = runtimes[session.id]
                  const activity = displayState(session)
                  const current = session.id === currentId
                  const editing = editingId === session.id
                  return (
                  <div
                    key={session.id}
                    data-activity={activity}
                    data-session-id={session.id}
                    className={clsx(
                      'group relative w-52 shrink-0 rounded-md transition-colors md:w-full',
                      activityCard[activity],
                      // 当前行以底色强调，无框会话行不再加描边。
                      current && 'bg-accent/10 font-medium',
                    )}
                  >
                    <div className="relative">
                      {editing ? (
                        <input
                          autoFocus
                          value={titleDraft}
                          onChange={(event) => setTitleDraft(event.target.value)}
                          onBlur={() => { void finishRename(session) }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur()
                            if (event.key === 'Escape') setEditingId(null)
                          }}
                          disabled={savingId === session.id}
                          aria-label={`重命名 ${sessionTitle(session)}`}
                          className="m-2 mb-1 w-[calc(100%-1rem)] rounded-md border border-accent/45 bg-white/90 px-2 py-1 text-sm text-ink outline-none ring-accent/20 focus:ring-2"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => selectSession(session.id)}
                          onDoubleClick={() => beginRename(session)}
                          aria-current={current ? 'page' : undefined}
                          title={`${sessionTitle(session)} · ${sessionStatusLabel(runtime)}${session.project_name ? ` · ${session.project_name}` : ''}`}
                          className="block min-h-7 w-full px-2 py-1 text-left"
                        >
                          <span className="flex items-center gap-2 pr-8">
                            <span aria-hidden="true" title={sessionStatusLabel(runtime)} className={clsx('h-2 w-2 shrink-0 rounded-full', activityDot[activity])} />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium" style={{ fontSize: `${railTitlePercent(titleScale)}%` }} title={sessionTitle(session)}>{sessionTitle(session)}</span>
                          </span>
                        </button>
                      )}
                      {!editing && (
                        <div
                          className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 has-[:focus-visible]:opacity-100 [@media(hover:none)]:opacity-100"
                        >
                          {onDelete && (
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(session.id)}
                              disabled={activity === 'active' || deletingId === session.id}
                              aria-label={`删除 ${sessionTitle(session)}`}
                              title={activity === 'active' ? '请先停止任务再删除' : (deleteDetail ?? '删除会话')}
                              className="flex h-6 w-6 items-center justify-center rounded text-status-danger transition-colors hover:bg-status-danger-soft disabled:cursor-not-allowed disabled:opacity-25"
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                    {editing && (
                      <span className="block px-3 pb-2 pl-7 text-[10px] opacity-70">{savingId === session.id ? '保存中…' : sessionStatusLabel(runtime)}</span>
                    )}
                    {confirmDeleteId === session.id && (
                      <div
                        ref={deleteConfirmRef}
                        role="alertdialog"
                        aria-label={`确认删除 ${sessionTitle(session)}`}
                        className="mx-2 mb-2 flex items-center justify-between gap-2 rounded-lg border border-status-danger-line bg-status-danger-soft px-2 py-1.5 text-[11px] text-status-danger"
                      >
                        <span className="whitespace-nowrap" title={deleteDetail}>{deleteDetail ? '删除会话？' : '删除索引？'}</span>
                        <button
                          type="button"
                          disabled={deletingId === session.id}
                          // Failure is reported by the page (pushSystem); without
                          // this catch the rejection would surface as an
                          // unhandled promise rejection in the renderer.
                          onClick={() => { void removeSession(session).catch(() => {}) }}
                          // leading-none: at 200px rail width the inherited
                          // 1.5 line-height made this button 24.5px tall and
                          // the strip 38.5px — compact it to ~33px.
                          className="shrink-0 whitespace-nowrap rounded bg-status-danger px-2 py-1 leading-none text-white disabled:opacity-50"
                        >
                          {deletingId === session.id ? '删除中…' : '确认'}
                        </button>
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            )
            if (!hasProjectGroups) return <Fragment key={group.key}>{cards}</Fragment>
            const isPinned = pinnedGroups.includes(group.key)
            return (
              <section key={group.key}>
                {/* 右侧固定三列：置顶 / 展开全部 / 计数；计数中心与会话删除键对齐。 */}
                <div data-project-header className="group/project-header relative flex w-full items-center rounded-md border border-line bg-bg-card pl-0.5 pr-[7px]">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!groupClosed}
                    title={group.projectPath || group.name}
                    className="flex min-h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-xs font-bold tracking-wide text-ink-muted/90 transition hover:text-ink"
                  >
                    <ChevronDown
                      aria-hidden="true"
                      className={clsx('h-3 w-3 flex-none transition-transform duration-200', groupClosed && '-rotate-90')}
                    />
                    <span className="min-w-0 flex-1 truncate">{group.name}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => togglePin(group.key)}
                    aria-pressed={isPinned}
                    aria-label={isPinned ? `取消置顶 ${group.name}` : `置顶 ${group.name}`}
                    data-testid={`pin-project-${group.key}`}
                    title={isPinned ? '取消置顶' : '置顶此项目空间'}
                    className={clsx(
                      'flex h-6 w-6 flex-none items-center justify-center rounded opacity-0 transition hover:bg-accent/10 focus-visible:opacity-100 focus-visible:outline-accent group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100 [@media(hover:none)]:opacity-100',
                      isPinned ? 'text-accent' : 'text-ink-faint/70 hover:text-ink-muted',
                    )}
                  >
                    <PinGlyph pinned={isPinned} className="h-3 w-3" />
                  </button>
                  {groupExpandable && (
                    <button
                      type="button"
                      onClick={() => toggleGroupShowAll(group.key)}
                      data-testid={`group-show-all-${group.key}`}
                      aria-label={groupShowAll ? '收起（仅显示最近3个）' : `展开全部 ${sessions.length} 个会话`}
                      aria-pressed={groupShowAll}
                      title={groupShowAll ? '仅显示最近3个会话' : '展开全部会话'}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition hover:bg-accent/10 hover:text-accent focus-visible:opacity-100 focus-visible:outline-accent group-hover/project-header:opacity-100 group-focus-within/project-header:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <CollapseChevronsIcon direction={groupShowAll ? 'expand' : 'collapse'} className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {!groupExpandable && <span aria-hidden="true" className="h-6 w-6 flex-none" />}
                  <span data-project-session-count aria-label={`${sessions.length} 个会话`} className="flex h-6 w-6 flex-none items-center justify-center text-[10px] font-normal tabular-nums text-ink-faint">{sessions.length}</span>
                </div>
                {!groupClosed && (
                  <div className="md:pt-1">
                    {cards}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </aside>
      <div
        aria-label="最近活动会话"
        className={clsx(
          // z-25 is not a Tailwind scale step — the class never generated
          // CSS. This float sits between the rail shell (z-20) and the
          // collapse button (z-30), so 20 is the intended layer.
          'absolute z-20 flex gap-1.5 transition-[opacity,transform] duration-300 md:flex-col',
          'left-2 right-2 top-1 md:bottom-[calc(50%+2.125rem)] md:left-auto md:right-[-1.5rem] md:top-auto md:w-6',
          collapsed ? 'pointer-events-auto translate-y-0 opacity-100 md:translate-x-0' : 'pointer-events-none -translate-y-2 opacity-0 md:translate-x-2 md:translate-y-0',
        )}
      >
        {attentionSessions.map((session) => {
          const activity = displayState(session)
          return (
            <button
              key={session.id}
              type="button"
              onClick={() => selectSession(session.id)}
              title={`${sessionTitle(session)} · ${activityLabel[activity]}`}
              aria-label={`${sessionTitle(session)}，${activityLabel[activity]}`}
              className={clsx(
                'group flex h-6 w-6 min-w-6 flex-none items-center justify-center rounded-full border border-line bg-bg-card/95 p-0 shadow-sm backdrop-blur-sm transition-[background-color,box-shadow,transform] hover:-translate-y-px hover:bg-white hover:shadow-md focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hover:-translate-x-px md:hover:translate-y-0',
                currentId === session.id && 'border-[#A69676] bg-white shadow-md',
              )}
            >
              <span
                aria-hidden="true"
                className={clsx('h-3 w-3 rounded-full transition-colors', activityRail[activity])}
              />
            </button>
          )
        })}
      </div>
      <button
        type="button"
        aria-label={collapsed ? '展开会话管理' : '折叠会话管理'}
        aria-expanded={!collapsed}
        onClick={toggle}
        title={collapsed ? '展开会话管理' : '折叠会话管理'}
        className={clsx(
          // 外侧半椭圆：桌面竖向且薄，保留渐变浮雕；SVG 几何居中。
          'absolute z-30 flex items-center justify-center border border-line/70 bg-[var(--c-scrollbar-thumb)] bg-gradient-to-b from-bg-card/20 to-transparent text-bg-card shadow-[inset_0_1px_0_rgb(255_255_255_/_0.3),0_2px_5px_rgb(0_0_0_/_0.16)] transition-[filter,background-color,box-shadow] duration-300 hover:bg-[var(--c-scrollbar-thumb-hover)] hover:brightness-105 hover:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.4),0_3px_7px_rgb(0_0_0_/_0.2)] active:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
          'left-1/2 h-5 w-[60px] -translate-x-1/2 rounded-[0_0_50%_50%/0_0_100%_100%] border-t-0',
          'md:left-auto md:top-1/2 md:h-[60px] md:w-5 md:translate-x-0 md:-translate-y-1/2 md:rounded-[0_100%_100%_0/0_50%_50%_0] md:border-l-0 md:border-t',
          collapsed ? 'top-0 md:-right-5' : 'top-32 md:-right-5 md:top-1/2',
        )}
      >
        <RailFoldGlyph direction={collapsed ? 'down' : 'up'} className="h-3.5 w-3.5 shrink-0 md:hidden" />
        <RailFoldGlyph direction={collapsed ? 'right' : 'left'} className="hidden h-3.5 w-3.5 shrink-0 md:block" />
      </button>
    </div>
  )
}

export const SessionRail = memo(SessionRailComponent)
