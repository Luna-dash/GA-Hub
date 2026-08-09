// LiveChat — the UI for one durable GA-Hub session.
//
// chatStore owns only the selected session's receive-only WebSocket and
// archive-hydrated message projection. Submissions and aborts use the session
// HTTP API; switching sessions tears down the old socket and ignores stale
// async completions so events cannot leak across sessions.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, EventSocket } from '@/api/client'
import type { HubSession, LLMInfo, Message, ScheduledChat, SessionRuntime } from '@/api/types'
import { ImagePasteInput, type PasteAttachment } from '@/components/ImagePasteInput'
import { MessageBubble } from '@/components/MessageBubble'
import { SessionRail } from '@/components/SessionRail'
import { findLatestRewindStreamId, type SlashCommand } from '@/components/slashCommands'
import { PageShell } from '@/components/PageShell'
import { dialog } from '@/stores/dialogStore'
import { useChatStore } from '@/stores/chatStore'
import { useDraftStore } from '@/stores/draftStore'
import { capacityConflictFromError, sessionChatHref } from '@/utils/sessionUi'
import { createRafScheduler } from '@/utils/rafScheduler'

interface RestoreState {
  restoredFrom?: string
  restoredTitle?: string
  restoredLines?: number
  messages?: Message[]
}

export default function LiveChat() {
  const location = useLocation()
  const nav = useNavigate()
  const restoreState = (location.state as RestoreState | null) || null

  const msgs = useChatStore((s) => s.msgs)
  const streaming = useChatStore((s) => s.streaming)
  const conn = useChatStore((s) => s.conn)
  const hydrating = useChatStore((s) => s.hydrating)
  const historyStatus = useChatStore((s) => s.historyStatus)
  const historyError = useChatStore((s) => s.historyError)
  const retryHistory = useChatStore((s) => s.retryHistory)
  const startChat = useChatStore((s) => s.start)
  const stopChat = useChatStore((s) => s.stop)
  const stageWebui = useChatStore((s) => s.stageWebui)
  const rollbackWebui = useChatStore((s) => s.rollbackWebui)
  const clearLocal = useChatStore((s) => s.clearLocal)
  const pushSystem = useChatStore((s) => s.pushSystem)

  const [session, setSession] = useState<HubSession | null>(null)
  const draftKey = session ? `liveChat:${session.id}` : 'liveChat:pending'
  const text = useDraftStore((state) => state.texts[draftKey] ?? '')
  const atts = useDraftStore((state) => state.attachments[draftKey] ?? [])
  const setText = (value: string) => useDraftStore.getState().setText(draftKey, value)
  const setAtts = (value: PasteAttachment[]) => useDraftStore.getState().setAttachments(draftKey, value)
  const [sessionError, setSessionError] = useState('')
  const [llms, setLlms] = useState<LLMInfo[]>([])
  const [llmLoading, setLlmLoading] = useState(false)
  const [llmSaving, setLlmSaving] = useState(false)
  const sessionIdRef = useRef<string | null>(null)
  const sessionSwitchSeqRef = useRef(0)
  const creatingSessionRef = useRef(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleNow, setScheduleNow] = useState(() => Date.now())
  const [hoveredSchedule, setHoveredSchedule] = useState<{
    task: ScheduledChat
    top: number
    right: number
  } | null>(null)
  const llmChangeSeqRef = useRef(0)
  const queryClient = useQueryClient()
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: api.sessions,
  })
  const sessions = useMemo(() => sessionsQuery.data?.items ?? [], [sessionsQuery.data])
  const runtimesQuery = useQuery({
    queryKey: ['session.runtimes'],
    queryFn: api.sessionRuntimes,
    enabled: sessions.length > 0,
    refetchInterval: 5000,
  })
  const runtimes = runtimesQuery.data ?? {}
  const scheduledChatsQuery = useQuery({
    queryKey: ['session.scheduledChats', session?.id],
    queryFn: () => api.scheduledChats(session!.id),
    enabled: Boolean(session?.id),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      if (items.length === 0) return 60_000
      const nextDueIn = Math.min(...items.map((task) => task.scheduled_for * 1000 - Date.now()))
      // Retain the low-cost minute cadence normally, then observe dispatch closely
      // so a completed task leaves the utility rail promptly.
      return nextDueIn <= 60_000 ? 1_000 : 60_000
    },
  })
  const scheduledChats = useMemo(
    () => [...(scheduledChatsQuery.data?.items ?? [])]
      .filter((task) => task.status === 'pending')
      .sort((a, b) => a.scheduled_for - b.scheduled_for),
    [scheduledChatsQuery.data],
  )

  useEffect(() => {
    const timer = window.setInterval(() => setScheduleNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const socket = new EventSocket('session:', 0)
    socket.onEvent = (event) => {
      if (event.topic !== 'session:runtime') return
      const runtime = event.payload as Partial<SessionRuntime>
      if (typeof runtime.session_id !== 'string') return
      queryClient.setQueryData<Record<string, SessionRuntime>>(
        ['session.runtimes'],
        (current) => ({
          ...(current ?? {}),
          [runtime.session_id as string]: {
            ...(current?.[runtime.session_id as string] ?? {}),
            ...runtime,
          } as SessionRuntime,
        }),
      )
    }
    return () => socket.close()
  }, [queryClient])

  useEffect(() => {
    let cancelled = false
    const initSeq = ++sessionSwitchSeqRef.current
    void (async () => {
      try {
        const requestedId = new URLSearchParams(location.search).get('session')
        const storedId = localStorage.getItem('gahub.currentSessionId')
        const listed = await queryClient.fetchQuery({ queryKey: ['sessions'], queryFn: api.sessions })
        let current = requestedId ? listed.items.find((item) => item.id === requestedId) : undefined
        if (!current) current = storedId ? listed.items.find((item) => item.id === storedId) : undefined
        if (!current) current = listed.items[0]
        if (cancelled || sessionSwitchSeqRef.current !== initSeq) return
        if (!current) {
          sessionIdRef.current = null
          localStorage.removeItem('gahub.currentSessionId')
          setSessionError('')
          setSession(null)
          stopChat()
          clearLocal()
          return
        }
        sessionIdRef.current = current.id
        localStorage.setItem('gahub.currentSessionId', current.id)
        setSessionError('')
        setSession(current)
        startChat(current.id)
      } catch (e: any) {
        if (!cancelled && sessionSwitchSeqRef.current === initSeq) {
          setSessionError(e?.body?.detail || e?.message || String(e))
        }
      }
    })()
    return () => { cancelled = true }
  }, [startChat, location.search, queryClient])

  useEffect(() => {
    let cancelled = false
    setLlmLoading(true)
    void api.llms()
      .then((result) => {
        if (!cancelled) setLlms(result.llms)
      })
      .catch((e: any) => {
        if (!cancelled) pushSystem(`_加载模型列表失败:${e?.body?.detail || e?.message || String(e)}_`)
      })
      .finally(() => {
        if (!cancelled) setLlmLoading(false)
      })
    return () => { cancelled = true }
  }, [pushSystem])

  const runtime = session ? runtimes[session.id] : undefined
  const refreshRuntime = useCallback(async (sessionId?: string) => {
    const sid = sessionId ?? sessionIdRef.current
    if (!sid || sessionIdRef.current !== sid) return
    const state = await api.sessionRuntime(sid)
    if (sessionIdRef.current !== sid) return
    queryClient.setQueryData<Record<string, SessionRuntime>>(['session.runtimes'], (cached) => ({
      ...(cached ?? {}),
      [sid]: state,
    }))
    return state
  }, [queryClient])
  const sessionRunning = runtime?.status === 'starting' || runtime?.status === 'running'
  const selectedLlmIndex = session?.llm_index
    ?? llms.find((item) => item.preferred)?.index
    ?? llms.find((item) => item.current)?.index
    ?? llms[0]?.index

  const changeModel = async (value: string) => {
    const sid = session?.id
    const nextIndex = Number(value)
    if (!sid || sessionIdRef.current !== sid || !Number.isInteger(nextIndex) || nextIndex < 0 || nextIndex === session.llm_index) return
    const changeSeq = ++llmChangeSeqRef.current
    const previousIndex = session.llm_index
    setLlmSaving(true)
    try {
      const updated = await api.updateSessionModel(sid, nextIndex)
      if (sessionIdRef.current !== sid || llmChangeSeqRef.current !== changeSeq) return
      setSession(updated)
      pushSystem(`_已切换模型:${updated.llm_index == null ? '默认' : (llms.find((item) => item.index === updated.llm_index)?.name || String(updated.llm_index))}_`)
    } catch (e: any) {
      if (sessionIdRef.current === sid && llmChangeSeqRef.current === changeSeq) {
        setSession((current) => current ? { ...current, llm_index: previousIndex } : current)
        pushSystem(`_切换模型失败:${e?.body?.detail || e?.message || String(e)}_`)
      }
    } finally {
      if (llmChangeSeqRef.current === changeSeq) setLlmSaving(false)
    }
  }

  // Smart auto-scroll state. We pin to bottom only when the user is *already*
  // near the bottom; otherwise we surface a "↓ N 条新消息" floating button so
  // they can keep reading older content while the agent streams.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stuckBottom, setStuckBottom] = useState(true)
  const [unread, setUnread] = useState(0)
  const [activeTurn, setActiveTurn] = useState(-1)
  const navigationTargetRef = useRef<number | null>(null)
  const turnCount = useMemo(() => msgs.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0), [msgs])


  // Apply navigation-state restore once (e.g. coming from Conversations page).
  useEffect(() => {
    if (restoreState?.messages?.length) {
      // Replay restored conversation as static bubbles + a banner notice.
      // Wipe local view first to avoid stacking on top of an existing chat.
      clearLocal()
      for (const m of restoreState.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        useChatStore.setState((st) => ({
          msgs: [...st.msgs, { role: m.role as 'user' | 'assistant', content: m.content }],
        }))
      }
      pushSystem(
        `_↩ 已从「${restoreState.restoredTitle || ''}」恢复完整原生上下文（${restoreState.restoredLines ?? restoreState.messages.length} 条可视消息）。继续对话即可。_`,
      )
      // Drop the state so reload / back-nav doesn't re-inject.
      nav('/chat', { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Track whether the user is still pinned to the bottom of the scroll area.
  // Turn nodes only change when the message structure changes; scroll events
  // reuse this cache and are coalesced to at most one computation per frame.
  const turnNodesRef = useRef<HTMLElement[]>([])
  const recomputeStuck = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const at = dist < 80   // ~one bubble of slack
    setStuckBottom(at)
    if (at) setUnread(0)

    const turns = turnNodesRef.current
    if (turns.length === 0) {
      setActiveTurn(-1)
      return
    }
    const navigationTarget = navigationTargetRef.current
    if (navigationTarget !== null && navigationTarget < turns.length) {
      setActiveTurn((previous) => previous === navigationTarget ? previous : navigationTarget)
      return
    }

    let current = at ? turns.length - 1 : 0
    if (!at) {
      for (let i = 0; i < turns.length; i += 1) {
        if (turns[i].offsetTop <= el.scrollTop + 48) current = i
        else break
      }
    }
    setActiveTurn((previous) => previous === current ? previous : current)
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    turnNodesRef.current = Array.from(el.querySelectorAll<HTMLElement>('[data-chat-turn]'))
    recomputeStuck()
    const scrollScheduler = createRafScheduler(recomputeStuck)
    const releaseNavigationTarget = () => { navigationTargetRef.current = null }
    el.addEventListener('scroll', scrollScheduler.schedule, { passive: true })
    el.addEventListener('wheel', releaseNavigationTarget, { passive: true })
    el.addEventListener('touchstart', releaseNavigationTarget, { passive: true })
    el.addEventListener('pointerdown', releaseNavigationTarget, { passive: true })
    return () => {
      scrollScheduler.cancel()
      el.removeEventListener('scroll', scrollScheduler.schedule)
      el.removeEventListener('wheel', releaseNavigationTarget)
      el.removeEventListener('touchstart', releaseNavigationTarget)
      el.removeEventListener('pointerdown', releaseNavigationTarget)
    }
  }, [msgs.length, session?.id])

  // On every msgs change: if we're at the bottom, glue ourselves to it; else
  // bump the unread counter so the floating jump-button shows new-msg count.
  // useLayoutEffect avoids a one-frame flash.
  const lastLenRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const grew = msgs.length > lastLenRef.current
    lastLenRef.current = msgs.length
    if (stuckBottom) {
      el.scrollTop = el.scrollHeight
    } else if (grew) {
      setUnread((n) => n + 1)
    }
  }, [msgs, stuckBottom])

  const jumpToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    const lastTurn = turnCount - 1
    navigationTargetRef.current = lastTurn >= 0 ? lastTurn : null
    if (lastTurn >= 0) setActiveTurn(lastTurn)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setUnread(0)
  }

  const jumpToTurn = (direction: -1 | 1) => {
    const el = scrollRef.current
    if (!el || turnCount === 0) return
    const current = activeTurn < 0 ? (stuckBottom ? turnCount - 1 : 0) : activeTurn
    const next = Math.max(0, Math.min(turnCount - 1, current + direction))
    if (next === current) return
    const target = turnNodesRef.current[next]
    if (!target) return

    const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight)
    const anchorTop = Math.max(0, Math.min(maxScrollTop, target.offsetTop - 16))
    const targetTop = direction < 0 && anchorTop >= el.scrollTop - 1
      ? Math.max(0, el.scrollTop - Math.max(96, el.clientHeight * 0.4))
      : anchorTop

    navigationTargetRef.current = next
    setActiveTurn(next)
    el.scrollTo({ top: targetTop, behavior: 'smooth' })
  }

  const submit = () => {
    const t = text.trim()
    if (!t && atts.length === 0) return
    if (t === '/new') {
      const commandKey = draftKey
      const commandText = text
      const commandAtts = atts
      void newConv()
        .then((created) => {
          if (created) useDraftStore.getState().clearDraftIfMatch(commandKey, commandText, commandAtts)
        })
        .catch((e: any) => pushSystem(`_新建会话失败：${e?.body?.detail || e?.message || String(e)}。命令已保留，可直接重试。_`))
      return
    }
    if (streaming || sessionRunning || creatingSessionRef.current) return

    const sourceKey = draftKey
    const sourceText = text
    const sourceAtts = atts
    void (async () => {
      let sid = session?.id
      let submitKey = sourceKey
      if (!sid) {
        creatingSessionRef.current = true
        setCreatingSession(true)
        const switchSeq = ++sessionSwitchSeqRef.current
        try {
          const created = await api.createSession({ title: '', llm_index: null })
          if (sessionSwitchSeqRef.current !== switchSeq || sessionIdRef.current) return
          sid = created.id
          submitKey = `liveChat:${created.id}`
          const drafts = useDraftStore.getState()
          drafts.setText(submitKey, sourceText)
          drafts.setAttachments(submitKey, sourceAtts)
          queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
            total: (cached?.total ?? 0) + 1,
            items: [created, ...(cached?.items ?? [])],
          }))
          sessionIdRef.current = created.id
          setSession(created)
          setSessionError('')
          localStorage.setItem('gahub.currentSessionId', created.id)
          window.history.replaceState(window.history.state, '', sessionChatHref(created.id))
          startChat(created.id)
        } finally {
          creatingSessionRef.current = false
          setCreatingSession(false)
        }
      } else if (sessionIdRef.current !== sid) {
        return
      }

      const fileMarkers = sourceAtts.map((a) => `[用户发送文件: ${a.path}]`).join('\n')
      const fileHint = sourceAtts.length ? 'If you need to show files to user, use [FILE:filepath] in your response.\n\n' : ''
      const promptText = fileHint + t + (fileMarkers ? (t ? '\n' : '') + fileMarkers : '')
      const stageId = stageWebui(t, sourceAtts)
      setStuckBottom(true)
      setUnread(0)
      try {
        await api.sessionRun(sid, promptText, sourceAtts.map((a) => a.path))
        if (sessionIdRef.current !== sid) return
        const drafts = useDraftStore.getState()
        drafts.clearDraftIfMatch(sourceKey, sourceText, sourceAtts)
        if (submitKey !== sourceKey) drafts.clearDraftIfMatch(submitKey, sourceText, sourceAtts)
        refreshRuntime(sid)
      } catch (e: any) {
        if (sessionIdRef.current !== sid) return
        rollbackWebui(stageId)
        const conflict = capacityConflictFromError(e)
        if (conflict) {
          const usage = conflict.activeCount != null && conflict.capacity != null
            ? `（${conflict.activeCount}/${conflict.capacity}）`
            : ''
          pushSystem(`_会话运行容量已满${usage}，请先在左侧会话栏选择一个运行中的会话并停止任务。草稿已保留，可直接重试。_`)
        } else {
          pushSystem(`_发送失败：${e?.body?.detail?.code || e?.body?.detail || e?.message || String(e)}。草稿已保留，可直接重试。_`)
        }
      }
    })().catch((e: any) => {
      pushSystem(`_创建会话失败：${e?.body?.detail || e?.message || String(e)}。草稿已保留，可直接重试。_`)
    })
  }

  const openSchedule = () => {
    const next = new Date(Date.now() + 5 * 60_000)
    next.setSeconds(0, 0)
    setScheduleAt(toLocalDateTimeValue(next))
    setScheduleError('')
    setScheduleOpen(true)
  }

  const saveSchedule = async () => {
    if (scheduleSaving) return
    const sourceText = text
    const sourceAtts = atts
    const t = sourceText.trim()
    if (!t && sourceAtts.length === 0) return
    const scheduledFor = new Date(scheduleAt).getTime()
    const now = Date.now()
    if (!Number.isFinite(scheduledFor) || scheduledFor <= now) {
      setScheduleError('请选择未来的发送时间。')
      return
    }
    if (scheduledFor > now + 48 * 60 * 60_000) {
      setScheduleError('发送时间不能超过未来 48 小时。')
      return
    }

    setScheduleSaving(true)
    setScheduleError('')
    try {
      let sid = session?.id
      if (!sid) {
        const created = await api.createSession({ title: '', llm_index: null })
        sid = created.id
        queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
          total: (cached?.total ?? 0) + 1,
          items: [created, ...(cached?.items ?? [])],
        }))
        sessionIdRef.current = sid
        setSession(created)
        localStorage.setItem('gahub.currentSessionId', sid)
        window.history.replaceState(window.history.state, '', sessionChatHref(sid))
        startChat(sid)
      }
      const fileMarkers = sourceAtts.map((a) => `[用户发送文件: ${a.path}]`).join('\n')
      const fileHint = sourceAtts.length ? 'If you need to show files to user, use [FILE:filepath] in your response.\n\n' : ''
      const promptText = fileHint + t + (fileMarkers ? (t ? '\n' : '') + fileMarkers : '')
      await api.createScheduledChat(sid, promptText, sourceAtts.map((a) => a.path), scheduledFor / 1000)
      useDraftStore.getState().clearDraftIfMatch(draftKey, sourceText, sourceAtts)
      await queryClient.invalidateQueries({ queryKey: ['session.scheduledChats', sid] })
      setScheduleNow(Date.now())
      setScheduleOpen(false)
    } catch (e: any) {
      setScheduleError(e?.body?.detail?.message || e?.body?.detail || e?.message || String(e))
    } finally {
      setScheduleSaving(false)
    }
  }

  const cancelSchedule = async (task: ScheduledChat) => {
    if (!session?.id) return
    const ok = await dialog.confirm(
      '取消定时发送？',
      `确定取消 ${new Date(task.scheduled_for * 1000).toLocaleString('zh-CN', { hour12: false })} 的定时消息吗？`,
      { confirmText: '取消任务', tone: 'danger' },
    )
    if (!ok) return
    try {
      await api.cancelScheduledChat(session.id, task.id)
      await queryClient.invalidateQueries({ queryKey: ['session.scheduledChats', session.id] })
    } catch (e: any) {
      pushSystem(`_取消定时消息失败：${e?.body?.detail?.message || e?.body?.detail || e?.message || String(e)}。_`)
    }
  }

  const newConv = useCallback(async (): Promise<boolean> => {
    if (creatingSessionRef.current) return false
    creatingSessionRef.current = true
    setCreatingSession(true)
    const switchSeq = ++sessionSwitchSeqRef.current
    const previousSid = sessionIdRef.current
    try {
      const next = await api.createSession({ title: '', llm_index: session?.llm_index ?? null })
      if (sessionSwitchSeqRef.current !== switchSeq || sessionIdRef.current !== previousSid) return false
      queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
        total: (cached?.total ?? 0) + 1,
        items: [next, ...(cached?.items ?? [])],
      }))
      localStorage.setItem('gahub.currentSessionId', next.id)
      nav(sessionChatHref(next.id))
      return true
    } finally {
      creatingSessionRef.current = false
      setCreatingSession(false)
    }
  }, [nav, queryClient, session?.llm_index])

  const selectSession = useCallback((id: string) => {
    if (id === sessionIdRef.current) return
    localStorage.setItem('gahub.currentSessionId', id)
    nav(sessionChatHref(id))
  }, [nav])

  const createSession = useCallback(async () => {
    try {
      await newConv()
    } catch (error: any) {
      pushSystem(`_新建会话失败：${error?.body?.detail || error?.message || String(error)}_`)
    }
  }, [newConv, pushSystem])

  const renameSession = useCallback(async (id: string, title: string) => {
    try {
      const updated = await api.updateSession(id, { title })
      queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
        total: cached?.total ?? 0,
        items: (cached?.items ?? []).map((item) => item.id === id ? updated : item),
      }))
      if (sessionIdRef.current === id) setSession(updated)
    } catch (error: any) {
      pushSystem(`_重命名失败：${error?.body?.detail || error?.message || String(error)}_`)
      throw error
    }
  }, [pushSystem, queryClient])

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id)
      const remaining = sessions.filter((item) => item.id !== id)
      queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], {
        total: remaining.length,
        items: remaining,
      })
      if (sessionIdRef.current !== id) return

      ++sessionSwitchSeqRef.current
      if (remaining.length > 0) {
        localStorage.setItem('gahub.currentSessionId', remaining[0].id)
        nav(sessionChatHref(remaining[0].id))
        return
      }

      setSession(null)
      localStorage.removeItem('gahub.currentSessionId')
      stopChat()
      clearLocal()
      nav('/chat', { replace: true })
    } catch (error: any) {
      const detail = error?.status === 409
        ? '会话仍在运行，请先停止任务。'
        : (error?.body?.detail || error?.message || String(error))
      pushSystem(`_删除会话失败：${detail}_`)
      throw error
    }
  }, [clearLocal, nav, pushSystem, queryClient, sessions, stopChat])

  // Keep the callback stable while streaming chunks update `msgs`; otherwise
  // every completed assistant bubble receives a new prop and rebuilds Markdown.
  const handleRewind = useCallback(async (sid: string) => {
    if (streaming || sessionRunning) {
      pushSystem('_当前回复还在进行中。请先停止后再回退。_')
      return
    }
    const ok = await dialog.confirm(
      '回退此轮对话？',
      '本轮的用户提问与所有 Assistant 回复都会从历史与界面中删除，且不可恢复。',
      { confirmText: '回退', tone: 'danger' },
    )
    if (!ok) return
    try {
      const r = await api.rewindTurns({ sid })
      pushSystem(`_已回退 1 轮（保留 ${r.kept} 条历史）。_`)
    } catch (e: any) {
      await dialog.alert('回退失败', e?.message || String(e))
    }
  }, [pushSystem, sessionRunning, streaming])

  const handleSlashCommand = (command: Exclude<SlashCommand['name'], '/btw'>) => {
    if (command === '/new') {
      const commandKey = draftKey
      const commandText = text
      const commandAtts = atts
      void newConv()
        .then((created) => {
          if (created) useDraftStore.getState().clearDraftIfMatch(commandKey, commandText, commandAtts)
        })
        .catch((error: any) => {
          pushSystem(`_新建会话失败：${error?.body?.detail || error?.message || String(error)}。命令已保留，可直接重试。_`)
        })
      return
    }

    setText('')
    const streamId = findLatestRewindStreamId(msgs)
    if (!streamId) {
      pushSystem('_当前没有可回退的已完成回复。_')
      return
    }
    void handleRewind(streamId)
  }

  return (
    <PageShell
      title="实时聊天"
      titleExtra={
        <span className={`ga-badge ${conn === 'open' ? 'ga-badge-connected' : conn === 'connecting' ? 'ga-badge-connecting' : 'ga-badge-offline'}`}>
          {conn === 'open' ? '已连接' : conn === 'connecting' ? '连接中…' : '断开'}
        </span>
      }
      actions={
        <select
          value={selectedLlmIndex == null ? '' : String(selectedLlmIndex)}
          onChange={(e) => { void changeModel(e.target.value) }}
          disabled={!session || llmLoading || llmSaving || sessionRunning || llms.length === 0}
          className="max-w-[400px] min-w-0 shrink-0 truncate rounded border border-line bg-bg-card px-3 py-1.5 text-sm text-[#2C2418] hover:border-accent focus:border-accent focus:outline-none disabled:opacity-50"
          title="选择当前会话使用的模型"
          aria-label="当前会话模型"
        >
          {llms.map((item) => (
            <option key={item.index} value={item.index}>{item.name}</option>
          ))}
        </select>
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <SessionRail
          sessions={sessions}
          runtimes={runtimes}
          currentId={session?.id ?? null}
          onSelect={selectSession}
          onCreate={createSession}
          creating={creatingSession}
          onRename={renameSession}
          onDelete={deleteSession}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col relative">
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto py-4 pl-4 pr-[76px] space-y-2 md:pl-10">
          {historyStatus === 'history_error' && (
            <div className="sticky top-0 z-10 mx-auto flex w-fit max-w-full items-center gap-3 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 shadow-sm">
              <span>历史消息加载失败：{historyError || '未知错误'}。实时消息仍可继续接收。</span>
              <button type="button" className="ga-btn shrink-0" onClick={retryHistory}>重试</button>
            </div>
          )}
          {sessionError && msgs.length === 0 && (
            <div className="h-full flex items-center justify-center text-red-400 text-sm">会话初始化失败：{sessionError}</div>
          )}
          {!sessionError && hydrating && msgs.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-[#86775F] text-sm">
              <div className="w-6 h-6 rounded-full border-2 border-slate-600 border-t-accent animate-spin" />
              <div>正在恢复历史对话…</div>
            </div>
          )}
          {!hydrating && msgs.length === 0 && (
            <div className="h-full flex items-center justify-center text-[#86775F] text-sm">
              开始一段对话，或粘贴一张图问个问题。
            </div>
          )}
          {msgs.map((m, i) => {
            const role = (m.role === 'system' ? 'assistant' : m.role) as 'user' | 'assistant'
            const tag = m.source && m.source !== 'webui' && m.source !== 'user' && m.source !== 'history'
              ? sourceLabel(m.source)
              : undefined
            return (
              <div
                key={`${m.streamId ?? 'local'}-${i}`}
                {...(m.role === 'user' ? { 'data-chat-turn': true } : {})}
              >
                <MessageBubble
                  role={role}
                  content={tag ? `${tag}\n\n${m.content}` : m.content}
                  streaming={m.streaming}
                  timestamp={m.timestamp}
                  startedAt={m.startedAt}
                  finishedAt={m.finishedAt}
                  attachments={m.attachments}
                  streamId={role === 'assistant' ? m.streamId : undefined}
                  onRewind={role === 'assistant' ? handleRewind : undefined}
                />
              </div>
            )
          })}
        </div>

        {/* Narrow utility rail: scheduled notices above, turn navigation below. */}
        {(scheduledChats.length > 0 || turnCount > 0) && (
          <aside
            className="absolute inset-y-3 right-2 z-10 flex w-14 flex-col gap-2"
            aria-label="对话功能区"
          >
            {scheduledChats.length > 0 && (
              <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain pr-0.5" aria-label="待发送定时消息">
                {scheduledChats.map((task) => {
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => { void cancelSchedule(task) }}
                      onMouseEnter={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        setHoveredSchedule({ task, top: rect.top, right: window.innerWidth - rect.left + 10 })
                      }}
                      onMouseLeave={() => setHoveredSchedule(null)}
                      onFocus={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        setHoveredSchedule({ task, top: rect.top, right: window.innerWidth - rect.left + 10 })
                      }}
                      onBlur={() => setHoveredSchedule(null)}
                      className="group relative flex aspect-square w-full shrink-0 items-center justify-center overflow-hidden rounded-lg p-[2px] text-center text-xs font-semibold leading-tight text-accent shadow-sm transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                      title="点击取消定时发送"
                      aria-label={`${formatCompactScheduleCountdown(task.scheduled_for, scheduleNow)}后发送；悬停查看消息；点击取消`}
                    >
                      <span
                        data-schedule-flow-border
                        aria-hidden="true"
                        className="absolute -inset-5 animate-spin bg-[conic-gradient(from_0deg,transparent_0deg,transparent_205deg,#60a5fa_245deg,#a78bfa_285deg,#f472b6_325deg,transparent_360deg)] motion-reduce:animate-none"
                        style={{ animationDuration: '3s' }}
                      />
                      <span className="relative flex h-full w-full items-center justify-center rounded-[6px] bg-bg-card/95 px-1 backdrop-blur transition-colors group-hover:bg-bg-soft">
                        {formatCompactScheduleCountdown(task.scheduled_for, scheduleNow)}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}

            {turnCount > 0 && (
              <div className="mt-auto flex shrink-0 flex-col gap-1.5 text-xs text-[#2C2418]">
                <button
                  onClick={() => jumpToTurn(-1)}
                  disabled={activeTurn <= 0}
                  className="h-9 rounded-lg border border-line bg-bg-soft/95 px-1 shadow-md backdrop-blur hover:bg-bg-card disabled:cursor-not-allowed disabled:opacity-35"
                  title="定位到上一轮问答"
                >
                  ↑ 上节
                </button>
                <button
                  onClick={() => jumpToTurn(1)}
                  disabled={activeTurn < 0 || activeTurn >= turnCount - 1}
                  className="h-9 rounded-lg border border-line bg-bg-soft/95 px-1 shadow-md backdrop-blur hover:bg-bg-card disabled:cursor-not-allowed disabled:opacity-35"
                  title="定位到下一轮问答"
                >
                  ↓ 下节
                </button>
                {!stuckBottom && (
                  <button
                    onClick={jumpToBottom}
                    className="min-h-9 rounded-lg border border-line bg-bg-soft/95 px-1 py-1 leading-tight shadow-md backdrop-blur hover:bg-bg-card"
                    title={unread > 0 ? `${unread} 条新消息，跳到最新` : '跳到最新消息'}
                  >
                    ↓ {unread > 0 ? unread : '底部'}
                  </button>
                )}
              </div>
            )}
          </aside>
        )}

        {hoveredSchedule && scheduledChats.some((task) => task.id === hoveredSchedule.task.id) && (
          <div
            data-schedule-tooltip
            role="tooltip"
            className="pointer-events-none fixed z-50 w-72 -translate-y-1 rounded-xl border border-line bg-bg-card/98 p-3 text-left shadow-xl backdrop-blur"
            style={{ top: Math.max(12, hoveredSchedule.top), right: hoveredSchedule.right }}
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
              <span>定时发送内容</span>
              <time>{new Date(hoveredSchedule.task.scheduled_for * 1000).toLocaleString('zh-CN', { hour12: false })}</time>
            </div>
            <p className="max-h-48 overflow-hidden whitespace-pre-wrap break-words text-sm leading-5 text-text">
              {hoveredSchedule.task.text || '（仅附件）'}
            </p>
            {hoveredSchedule.task.images.length > 0 && (
              <div className="mt-2 text-xs text-text-muted">附件 {hoveredSchedule.task.images.length} 个</div>
            )}
          </div>
        )}

        </div>
      </div>

      <div className="shrink-0 border-t border-line/40 bg-transparent px-3 py-2.5">
        <div className="w-full rounded-xl border border-line/60 bg-bg-card shadow-sm">
          <ImagePasteInput
            text={text}
            onText={setText}
            attachments={atts}
            onAttachments={setAtts}
            onSubmit={submit}
            onSchedule={openSchedule}
            onStop={() => {
              const sid = session?.id
              if (!sid || sessionIdRef.current !== sid || !sessionRunning) return
              void api.abortSession(sid).then(() => refreshRuntime(sid))
            }}
            stopActive={sessionRunning}
            onSlashCommand={handleSlashCommand}
            placeholder="输入消息,或输入 / 查看命令"
            disabled={creatingSession}
            submitDisabled={streaming || sessionRunning}
          />
        </div>
      </div>
      </div>

      {scheduleOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" role="dialog" aria-modal="true" aria-labelledby="schedule-title">
          <div className="w-full max-w-md rounded-2xl border border-line bg-bg-card p-5 shadow-2xl">
            <h2 id="schedule-title" className="text-lg font-semibold text-[#2C2418]">定时发送</h2>
            <p className="mt-1 text-sm text-[#86775F]">选择未来 48 小时内的发送时间，支持跨到第二天。</p>
            <label className="mt-4 block text-sm font-medium text-[#2C2418]">
              发送时间（24 小时制）
              <input
                type="datetime-local"
                value={scheduleAt}
                min={toLocalDateTimeValue(new Date(Date.now() + 60_000))}
                max={toLocalDateTimeValue(new Date(Date.now() + 48 * 60 * 60_000))}
                step="60"
                onChange={(event) => {
                  setScheduleAt(event.target.value)
                  setScheduleError('')
                }}
                className="mt-2 w-full rounded-lg border border-line bg-bg px-3 py-2 text-[#2C2418] outline-none focus:border-accent"
                autoFocus
              />
            </label>
            {scheduleError && <div className="mt-2 text-sm text-red-500">{scheduleError}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="ga-btn"
                disabled={scheduleSaving}
                onClick={() => setScheduleOpen(false)}
              >取消</button>
              <button
                type="button"
                className="ga-btn ga-btn-primary"
                disabled={scheduleSaving || !scheduleAt}
                onClick={() => { void saveSchedule() }}
              >{scheduleSaving ? '保存中…' : '确认定时'}</button>
            </div>
          </div>
        </div>
      )}
    </PageShell>
  )
}

function toLocalDateTimeValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatCompactScheduleCountdown(scheduledFor: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((scheduledFor * 1000 - now) / 60_000))
  if (minutes < 60) return `${minutes}分`
  const hours = minutes / 60
  if (hours < 24) return `${Number(hours.toFixed(1))}时`
  const days = hours / 24
  return `${Number(days.toFixed(1))}天`
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'autonomous':
    case 'reflect':
      return '🤖 [自主进化触发]'
    case 'feishu':
      return '🪽 [飞书]'
    case 'wechat':
      return '💬 [微信]'
    case 'task':
      return '📋 [任务模式]'
    case 'scheduled_task':
      return '⏰ [定时任务]'
    case 'auto_continue':
      return '🔁 [自动继续]'
    case 'chat_error_retry':
    case 'chat_error_retry_notice':
      return '[自动重试]'
    default:
      return `[${source}]`
  }
}
