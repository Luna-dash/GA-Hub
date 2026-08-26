// LiveChat — the UI for one durable GA-Hub session.
//
// chatStore owns only the selected session's receive-only WebSocket and
// archive-hydrated message projection. Submissions and aborts use the session
// HTTP API; switching sessions tears down the old socket and ignores stale
// async completions so events cannot leak across sessions.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type {
  HubSession,
  LLMInfo,
  ConversationMessage,
  ScheduledChat,
  SessionRuntime,
} from '@/api/types'
import {
  LiveChatComposer,
  readLiveChatDraftSnapshot,
  type LiveChatDraftSnapshot,
} from '@/components/LiveChatComposer'
import {
  LiveChatTranscript,
  type LiveChatTranscriptHandle,
} from '@/components/LiveChatTranscript'
import { SessionRail } from '@/components/SessionRail'
import {
  findLatestRewindStreamId,
  rewindTurnCountFromAssistant,
  type SlashCommand,
} from '@/components/slashCommands'
import { PageShell } from '@/components/PageShell'
import { dialog } from '@/stores/dialogStore'
import { useChatStore } from '@/stores/chatStore'
import { useDraftStore } from '@/stores/draftStore'
import { capacityConflictFromError, errorMessageFromError, sessionChatHref } from '@/utils/sessionUi'
import { isTauriDesktop, selectDirectory } from '@/utils/desktop'
import { defaultSessionLlmKey, resolveSessionLlmKey } from '@/utils/llm'
import { MainModelSelect } from '@/components/ModelSelect'
import { useHubEvent } from '@/hooks/useHubEvent'
import { queryKeys } from '@/queries/queryKeys'

interface RestoreState {
  restoredFrom?: string
  restoredTitle?: string
  restoredLines?: number
  messages?: ConversationMessage[]
}

export default function LiveChat() {
  const location = useLocation()
  const nav = useNavigate()
  const restoreState = (location.state as RestoreState | null) || null

  const streaming = useChatStore((s) => s.streaming)
  const conn = useChatStore((s) => s.conn)
  const dropSessionView = useChatStore((s) => s.dropSessionView)
  const startChat = useChatStore((s) => s.start)
  const stopChat = useChatStore((s) => s.stop)
  const stageWebui = useChatStore((s) => s.stageWebui)
  const rollbackWebui = useChatStore((s) => s.rollbackWebui)
  const clearLocal = useChatStore((s) => s.clearLocal)
  const pushSystem = useChatStore((s) => s.pushSystem)
  const restoreVisibleConversation = useChatStore((s) => s.restoreVisibleConversation)

  const [session, setSession] = useState<HubSession | null>(null)
  const draftKey = session ? `liveChat:${session.id}` : 'liveChat:pending'
  const [sessionError, setSessionError] = useState('')
  const [llms, setLlms] = useState<LLMInfo[]>([])
  const [llmLoading, setLlmLoading] = useState(false)
  const [llmSaving, setLlmSaving] = useState(false)
  const [projectSaving, setProjectSaving] = useState(false)
  const projectChangeSeqRef = useRef(0)
  const sessionIdRef = useRef<string | null>(null)
  const transcriptRef = useRef<LiveChatTranscriptHandle>(null)
  const sessionSwitchSeqRef = useRef(0)
  const creatingSessionRef = useRef(false)
  const [creatingSession, setCreatingSession] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleAt, setScheduleAt] = useState('')
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [scheduleError, setScheduleError] = useState('')
  const [scheduleNow, setScheduleNow] = useState(() => Date.now())
  const llmChangeSeqRef = useRef(0)
  const llmRepairAttemptedRef = useRef(new Map<string, string>())
  const queryClient = useQueryClient()
  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: api.sessions,
  })
  const sessions = useMemo(() => sessionsQuery.data?.items ?? [], [sessionsQuery.data])
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects,
    queryFn: api.projects,
  })
  const projects = projectsQuery.data?.items ?? []
  const runtimesQuery = useQuery({
    queryKey: queryKeys.runtimes,
    queryFn: api.sessionRuntimes,
    enabled: sessions.length > 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  })
  const runtimes = runtimesQuery.data ?? {}
  const scheduledChatsQuery = useQuery({
    queryKey: queryKeys.scheduledChats(session?.id),
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
    refetchIntervalInBackground: false,
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

  useHubEvent('session:', (event) => {
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
  })

  useEffect(() => {
    let cancelled = false
    const initSeq = ++sessionSwitchSeqRef.current
    void (async () => {
      try {
        const requestedId = new URLSearchParams(location.search).get('session')
        const storedId = localStorage.getItem('gahub.currentSessionId')
        const listed = await queryClient.fetchQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions })
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
  const activeProjectPath = session?.project_path
    ?? (session?.project_name ? projects.find((project) => project.name === session.project_name)?.path : undefined)
    ?? ''
  const defaultLlmKey = defaultSessionLlmKey(llms)
  const selectedLlmKey = resolveSessionLlmKey(llms, session?.llm_key)
  const sessionLlmNeedsRepair = Boolean(
    session
    && selectedLlmKey
    && session.llm_key !== selectedLlmKey,
  )

  // Old positional bindings, empty bindings, and bindings to deleted models
  // all converge on the first configured model. Persist the resolved key so
  // switching sessions cannot revive stale positional/model identities.
  useEffect(() => {
    const sid = session?.id
    const repairKey = `${session?.llm_key ?? ''}:${session?.llm_index ?? ''}->${selectedLlmKey ?? ''}`
    if (
      !sid
      || !selectedLlmKey
      || !sessionLlmNeedsRepair
      || llmLoading
      || llmSaving
      || sessionRunning
      || llmRepairAttemptedRef.current.get(sid) === repairKey
    ) return

    llmRepairAttemptedRef.current.set(sid, repairKey)
    const changeSeq = ++llmChangeSeqRef.current
    setLlmSaving(true)
    void api.updateSessionModel(sid, selectedLlmKey)
      .then((updated) => {
        if (sessionIdRef.current !== sid || llmChangeSeqRef.current !== changeSeq) return
        setSession(updated)
        queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => (
          cached
            ? { ...cached, items: cached.items.map((item) => item.id === sid ? updated : item) }
            : cached
        ))
      })
      .catch((e: any) => {
        if (sessionIdRef.current === sid && llmChangeSeqRef.current === changeSeq) {
          pushSystem(`_保存会话模型失败:${e?.body?.detail || e?.message || String(e)}_`, 'llm-switch-fail')
        }
      })
      .finally(() => {
        if (llmChangeSeqRef.current === changeSeq) setLlmSaving(false)
      })
  }, [llmLoading, llmSaving, queryClient, selectedLlmKey, session?.id, session?.llm_index, session?.llm_key, sessionLlmNeedsRepair, sessionRunning])

  const changeModel = async (value: string) => {
    const sid = session?.id
    if (
      !sid
      || !value
      || sessionIdRef.current !== sid
      || (value === selectedLlmKey && session.llm_key === selectedLlmKey)
    ) return
    const changeSeq = ++llmChangeSeqRef.current
    const previousKey = session.llm_key
    setLlmSaving(true)
    try {
      const updated = await api.updateSessionModel(sid, value)
      if (sessionIdRef.current !== sid || llmChangeSeqRef.current !== changeSeq) return
      setSession(updated)
      queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => (
        cached
          ? { ...cached, items: cached.items.map((item) => item.id === sid ? updated : item) }
          : cached
      ))
      pushSystem(`_已切换模型:${llms.find((item) => item.key === updated.llm_key)?.name || updated.llm_key}_`, 'llm-switch')
    } catch (e: any) {
      if (sessionIdRef.current === sid && llmChangeSeqRef.current === changeSeq) {
        setSession((current) => current ? { ...current, llm_key: previousKey } : current)
        pushSystem(`_切换模型失败:${e?.body?.detail || e?.message || String(e)}_`, 'llm-switch-fail')
      }
    } finally {
      if (llmChangeSeqRef.current === changeSeq) setLlmSaving(false)
    }
  }

  // Apply navigation-state restore once (e.g. coming from Conversations page).
  useEffect(() => {
    if (restoreState?.messages?.length) {
      // Replace the visible transcript atomically: large restored archives must
      // not grow the message array one copy at a time.
      restoreVisibleConversation(
        restoreState.messages,
        `_↩ 已从「${restoreState.restoredTitle || ''}」恢复完整原生上下文（${restoreState.restoredLines ?? restoreState.messages.length} 条可视消息）。继续对话即可。_`,
      )
      // Drop the state so reload / back-nav doesn't re-inject.
      nav('/chat', { replace: true, state: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (draft: LiveChatDraftSnapshot) => {
    const t = draft.text.trim()
    if (!t && draft.attachments.length === 0) return
    if (t === '/new') {
      const commandKey = draft.draftKey
      const commandText = draft.text
      const commandAtts = draft.attachments
      void newConv()
        .then((created) => {
          if (created) useDraftStore.getState().clearDraftIfMatch(commandKey, commandText, commandAtts)
        })
        .catch((e: any) => pushSystem(`_新建会话失败：${e?.body?.detail || e?.message || String(e)}。命令已保留，可直接重试。_`, 'session-create-fail'))
      return
    }
    if (streaming || sessionRunning || llmSaving || sessionLlmNeedsRepair || creatingSessionRef.current) return
    if (session && !selectedLlmKey) {
      pushSystem('_当前没有可用模型，请先在设置中配置模型。草稿已保留。_', 'send-blocked')
      return
    }

    const sourceKey = draft.draftKey
    const sourceText = draft.text
    const sourceAtts = draft.attachments
    void (async () => {
      let sid = session?.id
      let submitKey = sourceKey
      if (!sid) {
        creatingSessionRef.current = true
        setCreatingSession(true)
        const switchSeq = ++sessionSwitchSeqRef.current
        try {
          if (!defaultLlmKey) throw new Error('当前没有可用模型，请先配置模型')
          const created = await api.createSession({ title: '', llm_key: defaultLlmKey })
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
          nav(sessionChatHref(created.id), { replace: true })
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
      transcriptRef.current?.pinToBottom()
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
          if (conflict.reason === 'session_active') {
            pushSystem(`_当前会话仍有任务运行中（或正在停止中），请等待结束后重试。草稿已保留，可直接重试。_`, 'send-blocked')
          } else {
            const usage = conflict.activeCount != null && conflict.capacity != null
              ? `（${conflict.activeCount}/${conflict.capacity}）`
              : ''
            pushSystem(`_会话运行容量已满${usage}，请先在左侧会话栏选择一个运行中的会话并停止任务。草稿已保留，可直接重试。_`, 'send-blocked')
          }
        } else {
          const code = e?.body?.detail?.code
          pushSystem(`_发送失败：${e?.body?.detail?.detail || code || e?.body?.detail || e?.message || String(e)}。草稿已保留，可直接重试。_`, 'send-blocked')
        }
      }
    })().catch((e: any) => {
      pushSystem(`_创建会话失败：${e?.body?.detail || e?.message || String(e)}。草稿已保留，可直接重试。_`, 'session-create-fail')
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
    const draft = readLiveChatDraftSnapshot(draftKey)
    const sourceText = draft.text
    const sourceAtts = draft.attachments
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
    if (llmSaving || sessionLlmNeedsRepair) {
      setScheduleError('正在应用默认模型，请稍候。')
      return
    }
    if (session && !selectedLlmKey) {
      setScheduleError('当前没有可用模型，请先在设置中配置模型。')
      return
    }

    setScheduleSaving(true)
    setScheduleError('')
    try {
      let sid = session?.id
      if (!sid) {
        if (!defaultLlmKey) throw new Error('当前没有可用模型，请先配置模型')
        const created = await api.createSession({ title: '', llm_key: defaultLlmKey })
        sid = created.id
        queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
          total: (cached?.total ?? 0) + 1,
          items: [created, ...(cached?.items ?? [])],
        }))
        sessionIdRef.current = sid
        setSession(created)
        localStorage.setItem('gahub.currentSessionId', sid)
        nav(sessionChatHref(sid), { replace: true })
        startChat(sid)
      }
      const fileMarkers = sourceAtts.map((a) => `[用户发送文件: ${a.path}]`).join('\n')
      const fileHint = sourceAtts.length ? 'If you need to show files to user, use [FILE:filepath] in your response.\n\n' : ''
      const promptText = fileHint + t + (fileMarkers ? (t ? '\n' : '') + fileMarkers : '')
      await api.createScheduledChat(sid, promptText, sourceAtts.map((a) => a.path), scheduledFor / 1000)
      useDraftStore.getState().clearDraftIfMatch(draft.draftKey, sourceText, sourceAtts)
      await queryClient.invalidateQueries({ queryKey: queryKeys.scheduledChats(sid) })
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.scheduledChats(session.id) })
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
      const llmKey = session?.llm_key ?? defaultLlmKey
      if (!llmKey) throw new Error('当前没有可用模型，请先配置模型')
      const next = await api.createSession({ title: '', llm_key: llmKey })
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
  }, [defaultLlmKey, nav, queryClient, session?.llm_key])

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

  const changeProject = useCallback(async (value: string) => {
    const sid = sessionIdRef.current
    if (!sid || projectSaving) return
    const changeSeq = ++projectChangeSeqRef.current
    setProjectSaving(true)
    try {
      let updated: HubSession
      if (value === '__new__') {
        const proceed = await dialog.confirm(
          '选择项目根目录',
          '请选择需要 GA 协助处理的项目文件夹。GA-Hub 会为它建立项目索引，并在目录中维护 project_memory.md；不会移动或复制其他文件。',
          { confirmText: '选择目录' },
        )
        if (!proceed) return
        if (!isTauriDesktop()) {
          await dialog.alert('无法选择目录', '目录选择需要使用 GA-Hub 桌面窗口，请在桌面版中重试。')
          return
        }
        const selection = await selectDirectory()
        if (selection?.cancelled) return
        if (!selection?.ok || !selection.path) {
          throw new Error(selection?.error || '未能打开目录选择器')
        }
        const created = await api.createProject(selection.path)
        await queryClient.invalidateQueries({ queryKey: queryKeys.projects })
        updated = await api.bindProject(sid, created.name, created.path)
      } else if (!value) {
        updated = await api.unbindProject(sid)
      } else {
        const selected = projects.find((item) => item.path === value)
        if (!selected) throw new Error('所选项目已不存在，请刷新后重试')
        updated = await api.bindProject(sid, selected.name, selected.path)
      }
      queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
        total: cached?.total ?? 0,
        items: (cached?.items ?? []).map((item) => item.id === sid ? updated : item),
      }))
      if (sessionIdRef.current === sid) setSession(updated)
    } catch (error: unknown) {
      pushSystem(`_切换项目失败：${errorMessageFromError(error)}_`, 'project-switch-fail')
    } finally {
      if (projectChangeSeqRef.current === changeSeq) setProjectSaving(false)
    }
  }, [projectSaving, projects, pushSystem, queryClient])

  const deleteCurrentProject = useCallback(async () => {
    const sid = sessionIdRef.current
    const selected = projects.find((item) => item.path === session?.project_path)
    if (!sid || !selected || projectSaving) return
    const displayName = projectDisplayName(selected.path, selected.name)
    const confirmed = await dialog.confirm(
      `移除“${displayName}”的项目映射？`,
      '会移除 GA 工作区中的目录映射和项目注册，不会删除原始项目目录、代码、其中的 memory 或其他文件。当前会话将先取消绑定。',
      { confirmText: '移除映射', tone: 'danger' },
    )
    if (!confirmed) return

    const changeSeq = ++projectChangeSeqRef.current
    setProjectSaving(true)
    try {
      const updated = await api.unbindProject(sid)
      queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
        total: cached?.total ?? 0,
        items: (cached?.items ?? []).map((item) => item.id === sid ? updated : item),
      }))
      if (sessionIdRef.current === sid) setSession(updated)

      await api.deleteProject(selected.name)
        await queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    } catch (error: unknown) {
      pushSystem(`_移除项目映射失败：${errorMessageFromError(error)}_`)
    } finally {
      if (projectChangeSeqRef.current === changeSeq) setProjectSaving(false)
    }
  }, [projectSaving, projects, pushSystem, queryClient, session?.project_path])

  const deleteSession = useCallback(async (id: string) => {
    try {
      await api.deleteSession(id)
      dropSessionView(id)
      useDraftStore.getState().clearDraft(`liveChat:${id}`)
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
      nav('/chat', { replace: true })
    } catch (error: any) {
      const detail = error?.status === 409
        ? '会话仍在运行，请先停止任务。'
        : (error?.body?.detail || error?.message || String(error))
      pushSystem(`_删除会话失败：${detail}_`)
      throw error
    }
  }, [dropSessionView, nav, pushSystem, queryClient, sessions])

  // Keep the callback stable while streaming chunks update `msgs`; otherwise
  // every completed assistant bubble receives a new prop and rebuilds Markdown.
  const handleRewind = useCallback(async (sid: string) => {
    if (streaming || sessionRunning) {
      pushSystem('_当前回复还在进行中。请先停止后再回退。_', 'rollback-blocked')
      return
    }
    const targetSessionId = sessionIdRef.current
    // Capture the message projection at event time.  Subscribing this page to
    // the whole message array would rebuild the composer and page chrome for
    // every streaming chunk.
    const currentMessages = useChatStore.getState().msgs
    const turnCount = rewindTurnCountFromAssistant(currentMessages, sid)
    if (!targetSessionId || turnCount == null) {
      pushSystem('_无法确定该回复对应的会话轮次，请刷新历史后重试。_', 'rollback-blocked')
      return
    }
    const ok = await dialog.confirm(
      '回退此轮对话？',
      '本轮及之后的用户提问与 Assistant 回复都会从历史与界面中删除，且不可恢复。',
      { confirmText: '回退', tone: 'danger' },
    )
    if (!ok || sessionIdRef.current !== targetSessionId) return
    try {
      const r = await api.rewindSession(targetSessionId, { n: turnCount })
      if (sessionIdRef.current !== targetSessionId) return
      useChatStore.getState().retryHistory()
      pushSystem(`_已回退 ${turnCount} 轮（保留 ${r.kept} 轮）。_`, 'rollback')
    } catch (e: any) {
      if (sessionIdRef.current === targetSessionId) {
        await dialog.alert('回退失败', errorMessageFromError(e, '会话回退失败，请稍后重试。'))
      }
    }
  }, [pushSystem, sessionRunning, streaming])

  const handleSlashCommand = (
    command: Exclude<SlashCommand['name'], '/btw'>,
    draft: LiveChatDraftSnapshot,
  ) => {
    if (command === '/new') {
      const commandKey = draft.draftKey
      const commandText = draft.text
      const commandAtts = draft.attachments
      void newConv()
        .then((created) => {
          if (created) useDraftStore.getState().clearDraftIfMatch(commandKey, commandText, commandAtts)
        })
        .catch((error: any) => {
          pushSystem(`_新建会话失败：${error?.body?.detail || error?.message || String(error)}。命令已保留，可直接重试。_`, 'session-create-fail')
        })
      return
    }
    useDraftStore.getState().setText(draft.draftKey, '')
    const streamId = findLatestRewindStreamId(useChatStore.getState().msgs)
    if (!streamId) {
      pushSystem('_当前没有可回退的已完成回复。_', 'rollback-blocked')
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
      middleArea={
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <label
            htmlFor="current-project-select"
            className="shrink-0 text-xs font-medium text-slate-500"
          >
            绑定项目：
          </label>
          <div className="flex min-w-0 shrink-0 items-center">
            <select
              id="current-project-select"
              value={session?.project_path || ''}
              onChange={(e) => { void changeProject(e.target.value) }}
              disabled={!session || projectSaving || projectsQuery.isLoading}
              className="max-w-[220px] min-w-0 truncate rounded-l border border-line bg-bg-card px-3 py-1.5 text-sm text-[#2C2418] hover:border-accent focus:z-10 focus:border-accent focus:outline-none disabled:opacity-50"
              title={activeProjectPath || '选择当前会话的项目'}
              aria-label="当前项目"
            >
              <option value="">未绑定项目</option>
              {projects.map((project) => (
                <option key={`${project.name}:${project.path}`} value={project.path} disabled={project.dangling}>
                  {projectDisplayName(project.path, project.name)}{project.dangling ? '（路径不可用）' : ''}
                </option>
              ))}
              <option value="__new__">＋ 新建项目…</option>
            </select>
            <button
              type="button"
              onClick={() => { void deleteCurrentProject() }}
              disabled={!session?.project_path || projectSaving || !projects.some((item) => item.path === session.project_path)}
              className="-ml-px inline-flex h-[34px] w-9 shrink-0 items-center justify-center rounded-r border border-line bg-bg-card text-slate-500 hover:z-10 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-35"
              title="删除当前项目索引（不会删除目录文件）"
              aria-label="删除当前项目索引"
            >
              <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
                <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14M10 10v6m4-6v6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
          <span
            className="min-w-0 flex-1 truncate text-xs text-slate-500"
            title={activeProjectPath || '当前会话未绑定项目'}
            aria-label="当前项目路径"
          >
            {activeProjectPath || '未绑定项目'}
          </span>
        </div>
      }
      actions={
        <MainModelSelect
          llms={llms}
          value={selectedLlmKey ?? ''}
          onChange={(llmKey) => { void changeModel(llmKey) }}
          disabled={!session || !selectedLlmKey || llmLoading || llmSaving || sessionRunning}
          className="max-w-[400px]"
          title="选择当前会话使用的模型"
          aria-label="当前会话模型"
        />
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
        <LiveChatTranscript
          ref={transcriptRef}
          sessionId={session?.id ?? null}
          sessionError={sessionError}
          scheduledChats={scheduledChats}
          scheduleNow={scheduleNow}
          onCancelSchedule={cancelSchedule}
          onRewind={handleRewind}
        />
      </div>

      <LiveChatComposer
        draftKey={draftKey}
        sessionId={session?.id}
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
        submitDisabled={streaming || sessionRunning || llmSaving || sessionLlmNeedsRepair}
      />
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

function projectDisplayName(path: string, fallback: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const leaf = normalized.split(/[\\/]/).pop()?.trim()
  return leaf || fallback
}
