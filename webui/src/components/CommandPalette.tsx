// CommandPalette — Cmd/Ctrl+K global searchable launcher.
//
// Aggregates allowed actions from across the app into one searchable list:
//   • Page jumps              (Chat, Memory, LLM, …)
//   • LLM switching            (every entry from /api/llms)
//   • Agent control            (新对话 / 停止 / 恢复历史)
//   • Autonomous schedules     (立即触发 *)
//   • SOPs / memory            (open in the memory viewer)
//   • Conversations            (jump to detail)
//
// Keyboard model: ↑/↓ navigate, Enter executes, Esc closes. Typing filters
// by token-subsequence match (so "ai chat" matches "实时聊天 / live chat").

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { conversationCountsText } from '@/utils/conversationCounts'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Z_LAYERS } from '@/config/zLayers'
import { APP_PAGES } from '@/config/pages'
import { isTopOverlay, registerOverlay, restoreOverlayFocus } from '@/utils/overlayStack'
import { api } from '@/api/client'
import { noticeKeys, useChatStore } from '@/stores/chatStore'
import { dialog } from '@/stores/dialogStore'
import { confirmLeaveIfDirty } from '@/stores/navigationGuardStore'
import { conversationKeys } from '@/queries/conversations'
import { createAndOpenSession, upsertSessionInList, type SessionListData } from '@/queries/sessions'
import { useSessionSelectionGuard } from '@/hooks/useSessionSelectionGuard'
import { queryKeys } from '@/queries/queryKeys'
import { errorMessageFromError } from '@/utils/sessionUi'
import { Search, X } from '@/components/ActionIcons'
import { resolveSessionLlmKey } from '@/utils/llm'

interface Action {
  id: string
  group: string
  label: string
  hint?: string
  icon?: string
  run: () => void | Promise<void>
}

// Match each haystack token must contain a query token as a *subsequence*.
// Lightweight enough to run on every keystroke without measuring.
function fuzzyMatch(query: string, haystack: string): boolean {
  if (!query) return true
  const q = query.toLowerCase().trim()
  const h = haystack.toLowerCase()
  let i = 0
  for (const c of h) {
    if (c === q[i]) i++
    if (i === q.length) return true
  }
  return false
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const restoreFocusRef = useRef(true)
  const overlayIdRef = useRef<number | null>(null)
  const nav = useNavigate()
  const location = useLocation()
  const pathnameRef = useRef(location.pathname)
  pathnameRef.current = location.pathname
  const guardedNav = useCallback(async (to: string) => {
    const targetPath = to.split(/[?#]/)[0] || '/'
    if (targetPath !== pathnameRef.current && !(await confirmLeaveIfDirty())) return false
    nav(to)
    return true
  }, [nav])
  const qc = useQueryClient()
  const creatingSessionRef = useRef(false)
  const captureSelection = useSessionSelectionGuard()
  const sessionId = useChatStore((s) => s.sessionId)
  const pushSystem = useChatStore((s) => s.pushSystem)

  // Global open hotkey: Cmd+K (mac) or Ctrl+K (win/linux). Captures even
  // when focus is in textarea/select; consumers commonly want it.
  useEffect(() => {
    const openPalette = () => setOpen(true)
    const togglePalette = () => setOpen((v) => !v)
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        togglePalette()
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    window.addEventListener('gahub:command-palette', openPalette)
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true })
      window.removeEventListener('gahub:command-palette', openPalette)
    }
  }, [])

  // When opened, register in shared overlay stack, clear filter + autofocus, and restore focus when dismissed.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    openerRef.current = opener
    restoreFocusRef.current = true
    const reg = registerOverlay({
      zIndex: Z_LAYERS.palette,
      getPanel: () => panelRef.current,
      onEscape: () => setOpen(false),
      lockScroll: true,
    })
    overlayIdRef.current = reg.id
    setQ('')
    setCursor(0)
    const id = window.setTimeout(() => {
      if (isTopOverlay(overlayIdRef.current)) inputRef.current?.focus()
    }, 30)
    return () => {
      window.clearTimeout(id)
      reg.unregister()
      overlayIdRef.current = null
      if (restoreFocusRef.current) restoreOverlayFocus(openerRef.current)
    }
  }, [open])

  // Data sources — only fetched while the palette is open
  const { data: llms } = useQuery({
    queryKey: queryKeys.llms,
    queryFn: api.llms,
    enabled: open,
    staleTime: 30_000,
  })
  const { data: sessionsData } = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: api.sessions,
    enabled: open && Boolean(sessionId),
    staleTime: 30_000,
  })
  const { data: schedules } = useQuery({
    queryKey: queryKeys.schedules,
    queryFn: api.schedules,
    enabled: open,
    staleTime: 30_000,
  })
  const { data: sops } = useQuery({
    queryKey: queryKeys.memory.sops,
    queryFn: api.sops,
    enabled: open,
    staleTime: 60_000,
  })
  const { data: convs } = useQuery({
    queryKey: conversationKeys.list('', 0, 30),
    queryFn: () => api.conversations(undefined, 0, 30),
    enabled: open,
    staleTime: 30_000,
  })

  const actions = useMemo<Action[]>(() => {
    const acts: Action[] = []
    // Page jumps (derived from the single page manifest)
    for (const page of APP_PAGES) {
      acts.push({
        id: `nav:${page.to}`,
        group: '页面',
        icon: page.palette.icon,
        label: page.palette.label,
        run: () => { void guardedNav(page.to) },
      })
    }

    // Quick agent actions
    acts.push({
      id: 'agent:new', group: '快捷操作', icon: '✨',
      label: '新对话',
      hint: '创建独立会话',
      run: async () => {
        if (creatingSessionRef.current) return
        if (pathnameRef.current !== '/chat' && !(await confirmLeaveIfDirty())) return
        creatingSessionRef.current = true
        const previousSid = useChatStore.getState().sessionId
        const canSelect = captureSelection()
        try {
          const [sessions, models] = await Promise.all([
            qc.fetchQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions }),
            qc.fetchQuery({ queryKey: queryKeys.llms, queryFn: api.llms }),
          ])
          const current = sessions.items.find((item) => item.id === previousSid)
          await createAndOpenSession(qc, nav, resolveSessionLlmKey(models.llms, current?.llm_key),
            canSelect)
        } finally {
          creatingSessionRef.current = false
        }
      },
    })
    acts.push({
      id: 'agent:abort', group: '快捷操作', icon: '⏹',
      label: '停止 Agent',
      run: async () => {
        if (!sessionId) {
          pushSystem('_当前没有可停止的会话_', noticeKeys.stopNone)
          return
        }
        await api.abortSession(sessionId)
      },
    })

    // LLM switching (binds to the active chat session when present)
    const activeSession = sessionId
      ? sessionsData?.items.find((item) => item.id === sessionId)
      : undefined
    const activeLlmKey = sessionId
      ? resolveSessionLlmKey(llms?.llms ?? [], activeSession?.llm_key)
      : undefined
    for (const l of llms?.llms ?? []) {
      const isCurrent = sessionId ? l.key === activeLlmKey : Boolean(l.current)
      if (isCurrent) continue
      acts.push({
        id: `llm:${l.index}`, group: '切换 LLM', icon: '⚡',
        label: `[${l.index}] ${l.name}`,
        run: async () => {
          if (sessionId) {
            const updated = await api.updateSessionModel(sessionId, l.key)
            qc.setQueryData<SessionListData>(queryKeys.sessions, (prev) => upsertSessionInList(prev, updated))
            pushSystem(`_已切换到 [${l.index}] ${l.name}_`, noticeKeys.llmSwitch)
            return
          }
          await api.switchLLM(l.index)
          qc.invalidateQueries({ queryKey: queryKeys.llms })
          qc.invalidateQueries({ queryKey: queryKeys.servicePanel })
          pushSystem(`_已切换到 [${l.index}] ${l.name}_`, noticeKeys.llmSwitch)
        },
      })
    }

    // Trigger autonomous schedule
    for (const s of schedules?.schedules ?? []) {
      if (!s.enabled) continue
      acts.push({
        id: `sch:${s.id}`, group: '触发自主任务', icon: '🌀',
        label: `立即触发：${s.name || s.id}`,
        hint: s.type,
        run: async () => {
          if (pathnameRef.current !== '/autonomous' && !(await confirmLeaveIfDirty())) return
          const ok = await dialog.confirm('立即触发？', s.name || s.id, { confirmText: '触发' })
          if (!ok) return
          await api.triggerSchedule(s.id)
          qc.invalidateQueries({ queryKey: queryKeys.autonomous.runs })
          nav('/autonomous')
        },
      })
    }

    // SOPs
    for (const s of (sops?.sops ?? []).slice(0, 50)) {
      acts.push({
        id: `sop:${s.name}`, group: 'SOP / 记忆', icon: '📋',
        label: s.name,
        hint: `${(s.size / 1024).toFixed(1)} KB`,
        run: () => { void guardedNav(`/memory?tab=sop&sop=${encodeURIComponent(s.name)}`) },
      })
    }

    // Conversations
    for (const c of (convs?.items ?? []).slice(0, 30)) {
      acts.push({
        id: `conv:${c.id}`, group: '历史对话', icon: '💬',
        label: c.title || c.id,
        hint: conversationCountsText(c),
        run: () => { void guardedNav(`/conversations/${encodeURIComponent(c.id)}`) },
      })
    }

    return acts
  }, [llms, sessionsData, schedules, sops, convs, nav, guardedNav, qc, sessionId, pushSystem, captureSelection])

  const filtered = useMemo(() => {
    if (!q.trim()) return actions
    return actions.filter((a) => fuzzyMatch(q, `${a.group} ${a.label} ${a.hint || ''}`))
  }, [q, actions])

  // Keep cursor in range whenever the filter changes
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(0)
  }, [filtered.length, cursor])

  // Auto-scroll selected item into view
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const el = list.querySelector(`[data-cmd-idx="${cursor}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!open) return null

  const close = () => setOpen(false)
  const exec = async (a: Action) => {
    restoreFocusRef.current = false
    close()
    try { await a.run() } catch (e: any) { dialog.alert('操作失败', errorMessageFromError(e)) }
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (!isTopOverlay(overlayIdRef.current)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (filtered.length ? (c + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (filtered.length ? (c - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const a = filtered[cursor]
      if (a) exec(a)
    }
  }

  // Group items by `group` for display while keeping flat indexing for keyboard nav
  const groups: { name: string; items: Array<{ a: Action; idx: number }> }[] = []
  filtered.forEach((a, idx) => {
    let g = groups.find((x) => x.name === a.group)
    if (!g) { g = { name: a.group, items: [] }; groups.push(g) }
    g.items.push({ a, idx })
  })

  return (
    <div
      style={{ zIndex: Z_LAYERS.palette }}
      className="fixed inset-0 bg-[#241B12]/40 backdrop-blur-[3px] flex items-start justify-center pt-[9vh] px-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget && isTopOverlay(overlayIdRef.current)) close() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        className="ga-paper-popover w-full max-w-xl rounded-xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex items-center border-b border-line/80">
          <Search className="pointer-events-none absolute left-3.5 h-4 w-4 text-ink-faint" aria-hidden="true" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => { setQ(e.target.value); setCursor(0) }}
            onKeyDown={onKey}
            placeholder="跳转 · 切 LLM · 触发任务 · 搜索…"
            className="w-full bg-transparent pl-10 pr-9 py-3 text-base outline-none text-ink placeholder:text-ink-faint"
          />
          {q.length > 0 && (
            <button
              type="button"
              aria-label="清空搜索"
              title="清空搜索"
              onClick={() => {
                setQ('')
                setCursor(0)
                inputRef.current?.focus()
              }}
              className="absolute right-2.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-ink/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
          {groups.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-ink-faint">没有匹配项</div>
          )}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="px-3.5 pt-2.5 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-faint">
                {g.name}
              </div>
              {g.items.map(({ a, idx }) => (
                <button
                  key={a.id}
                  type="button"
                  data-cmd-idx={idx}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => exec(a)}
                  className={clsx(
                    'w-full flex items-center gap-3 px-3.5 py-2 text-sm text-left transition-colors',
                    idx === cursor ? 'bg-accent-soft text-accent font-medium' : 'text-ink hover:bg-ink/5',
                  )}
                >
                  <span className="text-base shrink-0">{a.icon || '·'}</span>
                  <span className="flex-1 truncate">{a.label}</span>
                  {a.hint && <span className="text-[11px] text-ink-faint shrink-0">{a.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="border-t border-line/80 bg-bg-card/50 px-3.5 py-2 text-[11px] text-ink-faint flex items-center gap-x-3 gap-y-1 flex-wrap">
          <span className="inline-flex items-center gap-1"><kbd className="ga-kbd">↑</kbd><kbd className="ga-kbd">↓</kbd> 导航</span>
          <span className="inline-flex items-center gap-1"><kbd className="ga-kbd">↵</kbd> 执行</span>
          <span className="inline-flex items-center gap-1"><kbd className="ga-kbd">Esc</kbd> 关闭</span>
          <span className="ml-auto inline-flex items-center gap-1"><kbd className="ga-kbd">⌘/Ctrl</kbd>+<kbd className="ga-kbd">K</kbd> 切换</span>
        </div>
      </div>
    </div>
  )
}
