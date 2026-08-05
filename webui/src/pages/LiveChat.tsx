// LiveChat — the UI for one durable GA-Hub session.
//
// chatStore owns only the selected session's receive-only WebSocket and
// archive-hydrated message projection. Submissions and aborts use the session
// HTTP API; switching sessions tears down the old socket and ignores stale
// async completions so events cannot leak across sessions.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { HubSession, LLMInfo, Message, SessionRuntime } from '@/api/types'
import { ImagePasteInput, type PasteAttachment } from '@/components/ImagePasteInput'
import { MessageBubble } from '@/components/MessageBubble'
import { SessionRail } from '@/components/SessionRail'
import { findLatestRewindStreamId, type SlashCommand } from '@/components/slashCommands'
import { PageShell } from '@/components/PageShell'
import { dialog } from '@/stores/dialogStore'
import { useChatStore } from '@/stores/chatStore'
import { useDraftStore } from '@/stores/draftStore'
import { sessionManager } from '@/stores/sessionManagerStore'
import { capacityConflictFromError, sessionChatHref } from '@/utils/sessionUi'

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
  const llmChangeSeqRef = useRef(0)
  const queryClient = useQueryClient()
  const sessionsQuery = useQuery({
    queryKey: ['sessions'],
    queryFn: api.sessions,
  })
  const sessions = useMemo(() => sessionsQuery.data?.items ?? [], [sessionsQuery.data])
  const runtimesQuery = useQuery({
    queryKey: ['session.runtimes', sessions.map((item) => item.id)],
    queryFn: async () => {
      const entries = await Promise.all(sessions.map(async (item) => {
        try { return [item.id, await api.sessionRuntime(item.id)] as const }
        catch { return null }
      }))
      return Object.fromEntries(
        entries.filter((entry): entry is readonly [string, SessionRuntime] => entry !== null),
      )
    },
    enabled: sessions.length > 0,
    refetchInterval: 5000,
  })
  const runtimes = runtimesQuery.data ?? {}

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
        if (!current) {
          current = await api.createSession({ title: '', llm_index: null })
          queryClient.setQueryData<{ total: number; items: HubSession[] }>(['sessions'], (cached) => ({
            total: (cached?.total ?? 0) + 1,
            items: [current!, ...(cached?.items ?? [])],
          }))
        }
        if (cancelled || sessionSwitchSeqRef.current !== initSeq) return
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

  const { data: runtime } = useQuery({
    queryKey: ['session.runtime', session?.id],
    queryFn: ({ queryKey }) => api.sessionRuntime(queryKey[1] as string),
    enabled: Boolean(session),
    refetchInterval: 1000,
  })
  const refreshRuntime = useCallback(async (sessionId?: string) => {
    const sid = sessionId ?? sessionIdRef.current
    if (!sid || sessionIdRef.current !== sid) return
    const state = await api.sessionRuntime(sid)
    if (sessionIdRef.current !== sid) return
    queryClient.setQueryData(['session.runtime', sid], state)
    return state
  }, [queryClient])
  const sessionRunning = runtime?.status === 'starting' || runtime?.status === 'running'

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
  const recomputeStuck = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    const at = dist < 80   // ~one bubble of slack
    setStuckBottom(at)
    if (at) setUnread(0)
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    recomputeStuck()
    el.addEventListener('scroll', recomputeStuck, { passive: true })
    return () => el.removeEventListener('scroll', recomputeStuck)
  }, [])

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
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setUnread(0)
  }

  const submit = () => {
    const t = text.trim()
    if (!t && atts.length === 0) return
    const sid = session?.id
    if (!sid || sessionIdRef.current !== sid || streaming || sessionRunning) return
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
    const fileMarkers = atts.map((a) => `[用户发送文件: ${a.path}]`).join('\n')
    const fileHint = atts.length ? 'If you need to show files to user, use [FILE:filepath] in your response.\n\n' : ''
    const promptText = fileHint + t + (fileMarkers ? (t ? '\n' : '') + fileMarkers : '')
    const stageId = stageWebui(t, atts)
    setStuckBottom(true)
    setUnread(0)
    api.sessionRun(sid, promptText, atts.map((a) => a.path))
      .then(() => {
        if (sessionIdRef.current !== sid) return
        useDraftStore.getState().clearDraftIfMatch(draftKey, text, atts)
        refreshRuntime(sid)
      })
      .catch((e: any) => {
        if (sessionIdRef.current !== sid) return
        rollbackWebui(stageId)
        const conflict = capacityConflictFromError(e)
        if (conflict) sessionManager.open(conflict)
        pushSystem(`_发送失败：${e?.body?.detail?.code || e?.body?.detail || e?.message || String(e)}。草稿已保留，可直接重试。_`)
      })
  }

  const newConv = async (): Promise<boolean> => {
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
  }

  const handleRewind = async (sid: string) => {
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
  }

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
      description="与 GenericAgent 进行多模态实时对话，支持图片粘贴与多会话并行工作"
      actions={
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <select
            value={session?.llm_index == null ? '' : String(session.llm_index)}
            onChange={(e) => { void changeModel(e.target.value) }}
            disabled={!session || llmLoading || llmSaving || sessionRunning}
            className="ga-btn max-w-52 text-xs"
            title="选择当前会话使用的模型"
          >
            {session?.llm_index == null && <option value="" disabled>默认模型（未选择）</option>}
            {llms.map((item) => (
              <option key={item.index} value={item.index}>{item.name}</option>
            ))}
          </select>
          <button
            onClick={() => {
              const sid = session?.id
              if (!sid || sessionIdRef.current !== sid) return
              void api.abortSession(sid).then(() => refreshRuntime(sid))
            }}
            disabled={!sessionRunning}
            className="ga-btn-danger"
            title={sessionRunning ? '停止当前会话任务' : '当前会话无进行中的任务'}
          >
            停止
          </button>
        </div>
      }    >
      <div className="flex h-full min-h-0 flex-col md:flex-row">
        <SessionRail
          sessions={sessions}
          runtimes={runtimes}
          currentId={session?.id ?? null}
          onSelect={(id) => {
            if (id === session?.id) return
            localStorage.setItem('gahub.currentSessionId', id)
            nav(sessionChatHref(id))
          }}
          onCreate={async () => {
            try {
              await newConv()
            } catch (error: any) {
              pushSystem(`_新建会话失败：${error?.body?.detail || error?.message || String(error)}_`)
            }
          }}
          creating={creatingSession}
          onRename={async (id, title) => {
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
          }}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col relative">
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-4 py-4 space-y-2">
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
            const tag = m.source && m.source !== 'webui' && m.source !== 'user'
              ? sourceLabel(m.source)
              : undefined
            return (
              <MessageBubble
                key={`${m.streamId ?? 'local'}-${i}`}
                role={role}
                content={tag ? `${tag}\n\n${m.content}` : m.content}
                streaming={m.streaming}
                attachments={m.attachments}
                streamId={role === 'assistant' ? m.streamId : undefined}
                onRewind={role === 'assistant' ? handleRewind : undefined}
              />
            )
          })}
        </div>

        {/* Floating jump-to-bottom button */}
        {!stuckBottom && (
          <button
            onClick={jumpToBottom}
            className="absolute right-8 bottom-28 z-10 px-3 py-1.5 rounded-full
                       bg-bg-soft/95 backdrop-blur border border-line shadow-lg
                       text-xs text-[#2C2418] hover:bg-bg-card flex items-center gap-1.5"
            title="跳到最新消息"
          >
            ↓ {unread > 0 ? `${unread} 条新消息` : '回到底部'}
          </button>
        )}

        <div className="border-t border-line bg-bg-soft/75 backdrop-blur-xl p-4 shadow-[0_-12px_36px_rgba(15,23,42,0.20)]">
          <ImagePasteInput
            text={text}
            onText={setText}
            attachments={atts}
            onAttachments={setAtts}
            onSubmit={submit}
            onSlashCommand={handleSlashCommand}
            disabled={!session || creatingSession}
            submitDisabled={streaming || sessionRunning}
          />
        </div>
      </div>
      </div>

    </PageShell>
  )
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
