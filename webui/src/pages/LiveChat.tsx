// LiveChat — a view over the global chatStore.
//
// The store owns the WebSocket and msg list, so navigating away no longer
// drops in-flight streams or scrollback. Autonomous-evolution / wechat /
// reflect submissions also surface here because the backend broadcasts
// every chat:* event on the same bus channel that the store subscribes to.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { Message } from '@/api/types'
import { ImagePasteInput, type PasteAttachment } from '@/components/ImagePasteInput'
import { MessageBubble } from '@/components/MessageBubble'
import { PageShell } from '@/components/PageShell'
import { relTime } from '@/utils/foldTurns'
import { detectLLMCapability, llmBadgeText, llmBadgeTitle } from '@/utils/llm'
import { dialog } from '@/stores/dialogStore'
import { useAgentStore } from '@/stores/agentStore'
import { useChatStore } from '@/stores/chatStore'

interface RestoreState {
  restoredFrom?: string
  restoredTitle?: string
  restoredLines?: number
  messages?: Message[]
}

export function LiveChat() {
  const qc = useQueryClient()
  const location = useLocation()
  const nav = useNavigate()
  const restoreState = (location.state as RestoreState | null) || null

  const msgs = useChatStore((s) => s.msgs)
  const streaming = useChatStore((s) => s.streaming)
  const conn = useChatStore((s) => s.conn)
  const hydrating = useChatStore((s) => s.hydrating)
  const agentStatus = useAgentStore((s) => s.status)
  const refreshAgentStatus = useAgentStore((s) => s.refreshStatus)
  const agentRunning = agentStatus?.is_running ?? false
  const submitWebui = useChatStore((s) => s.submitWebui)
  const abortFn = useChatStore((s) => s.abort)
  const clearLocal = useChatStore((s) => s.clearLocal)
  const pushSystem = useChatStore((s) => s.pushSystem)
  const markIdle = useChatStore((s) => s.markIdle)

  const [text, setText] = useState('')
  const [atts, setAtts] = useState<PasteAttachment[]>([])
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)

  // Smart auto-scroll state. We pin to bottom only when the user is *already*
  // near the bottom; otherwise we surface a "↓ N 条新消息" floating button so
  // they can keep reading older content while the agent streams.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [stuckBottom, setStuckBottom] = useState(true)
  const [unread, setUnread] = useState(0)

  // LLM list — kept fresh, used by the header picker
  const { data: llmsData } = useQuery({
    queryKey: ['llms'],
    queryFn: api.llms,
    refetchInterval: 8000,
  })
  const llms = llmsData?.llms ?? []
  const currentLlm = llms.find((l) => l.current)
  const cap = detectLLMCapability(currentLlm?.name ?? '')

  useEffect(() => {
    if (streaming && !agentRunning) markIdle()
  }, [streaming, agentRunning, markIdle])

  useEffect(() => {
    setTitleDraft(agentStatus?.current_title ?? '')
  }, [agentStatus?.current_title])

  const saveTitle = async () => {
    const title = titleDraft.trim()
    if (title === (agentStatus?.current_title ?? '')) return
    setTitleSaving(true)
    try {
      const r = await api.agentSetTitle(title)
      useAgentStore.setState((st) => ({
        status: st.status ? { ...st.status, current_title: r.title } : st.status,
      }))
      setTitleDraft(r.title)
      pushSystem(r.title ? `_对话标题已设为「${r.title}」_` : '_已清空对话标题，将按首条消息自动命名_')
      await refreshAgentStatus()
    } catch (e: any) {
      pushSystem(`_保存对话标题失败：${e?.body?.detail || e?.message || String(e)}_`)
    } finally {
      setTitleSaving(false)
    }
  }

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
        `_↩ 已从「${restoreState.restoredTitle || ''}」恢复 ${restoreState.restoredLines ?? restoreState.messages.length} 条历史摘要到 Agent 记忆。继续对话即可。_`,
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
    if (streaming) return
    if (t === '/new') {
      api.agentNew().then((r) => {
        clearLocal()
        pushSystem(r.message)
      })
      setText('')
      return
    }
    submitWebui(t, atts)
    setText('')
    setAtts([])
    // Sending always implies "I want to see the response" — re-stick to bottom.
    setStuckBottom(true)
    setUnread(0)
  }

  const newConv = async () => {
    const ok = await dialog.confirm(
      '开始新对话？',
      '当前 Agent 上下文会被清空。已有的会话仍可在「对话管理」页找回。',
      { confirmText: '新建', tone: 'danger' },
    )
    if (!ok) return
    const r = await api.agentNew()
    clearLocal()
    pushSystem(r.message)
  }

  const handleRewind = async (sid: string) => {
    if (streaming || agentRunning) {
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

  const switchLlm = async (idx: number) => {
    if (idx === currentLlm?.index) return
    if (streaming || agentRunning) {
      pushSystem('_当前回复还在进行中。请先点「停止」或等待完成后再切换 LLM。_')
      return
    }
    try {
      await api.switchLLM(idx)
      qc.invalidateQueries({ queryKey: ['llms'] })
      qc.invalidateQueries({ queryKey: ['status'] })
      pushSystem(`_已切换到 [${idx}] ${llms.find((l) => l.index === idx)?.name ?? ''}_`)
    } catch (e: any) {
      pushSystem(`_切换 LLM 失败：${e?.body?.detail || e?.message || String(e)}_`)
    }
  }

  return (
    <PageShell
      title="实时聊天"
      actions={
        <div className="flex items-center gap-2 text-sm flex-wrap justify-end">
          <div className="hidden md:flex items-center gap-1.5 mr-1" title="对话标题：回车或失焦保存，清空后按首条消息自动命名">
            <input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
                if (e.key === 'Escape') setTitleDraft(agentStatus?.current_title ?? '')
              }}
              disabled={titleSaving}
              placeholder="对话标题"
              className="w-48 bg-bg-card border border-line rounded-md px-3 py-2 text-xs outline-none focus:border-accent/80 focus:ring-2 focus:ring-accent/15 placeholder:text-[#86775F] disabled:opacity-60 shadow-inner"
            />
            {titleSaving && <span className="text-[10px] text-[#665741]">保存中…</span>}
          </div>
          {/* LLM picker + capability badge */}
          {llms.length > 0 && (
            <div className="flex items-center gap-1.5">
              <select
                value={currentLlm?.index ?? 0}
                onChange={(e) => switchLlm(Number(e.target.value))}
                disabled={streaming || agentRunning}
                className="bg-bg-card border border-line rounded-md px-3 py-2 text-xs outline-none focus:border-accent/80 focus:ring-2 focus:ring-accent/15 max-w-[260px] truncate disabled:opacity-50"
                title={streaming || agentRunning ? '当前回复进行中，请先停止或等待完成后再切换 LLM' : '切换 LLM'}
              >
                {llms.map((l) => (
                  <option key={l.index} value={l.index}>
                    [{l.index}] {l.name}
                  </option>
                ))}
              </select>
              <span
                className={`text-[10px] px-2 py-1 rounded-full shrink-0 border ${cap.multimodal
                  ? 'bg-[#D6E1D0] text-[#355C43] border-[#8FA67D]'
                  : 'bg-bg-soft text-[#3A3020] border-line'}`}
                title={llmBadgeTitle(cap)}
              >
                {llmBadgeText(cap)}
              </span>
            </div>
          )}
          <span className={`px-2.5 py-1 rounded-full border text-[11px] ${conn === 'open' ? 'bg-[#D6E1D0] text-[#355C43] border-[#8FA67D]' : conn === 'connecting' ? 'bg-[#E7D3A8] text-[#7A5527] border-[#B99A5B]' : 'bg-[#E2C5BD] text-[#7A3D32] border-[#B98578]'}`}>
            {conn === 'open' ? '已连接' : conn === 'connecting' ? '连接中…' : '断开'}
          </span>
          <button onClick={() => setRestoreOpen(true)} className="px-3 py-2 rounded-md border border-line text-[#3A3020] hover:bg-bg-soft hover:border-accent/30 text-sm transition" title="从历史快照恢复对话">↩ 恢复历史</button>
          <button onClick={newConv} className="px-3 py-2 rounded-md border border-line text-[#3A3020] hover:bg-bg-soft hover:border-accent/30 text-sm transition">新对话</button>
          <button onClick={abortFn} disabled={!streaming}
            className="px-3 py-2 rounded-md border border-[#B98578] text-[#7A3D32] hover:bg-[#E2C5BD] text-sm disabled:opacity-40 transition">
            停止
          </button>
        </div>
      }
    >
      <div className="flex flex-col h-full relative">
        <div ref={scrollRef} className="relative flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {hydrating && msgs.length === 0 && (
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
            disabled={streaming}
          />
        </div>
      </div>

      {restoreOpen && (
        <RestoreDrawer
          onClose={() => setRestoreOpen(false)}
          onRestored={(msg) => {
            clearLocal()
            pushSystem(msg)
            setRestoreOpen(false)
          }}
        />
      )}
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

// ── RestoreDrawer ────────────────────────────────────────────────
// Lists temp/model_responses/ snapshots produced by the agent at runtime.
// One click → POST /api/agent/sessions/{idx}/restore → backend.history is
// replaced (native blocks intact, full LLM context). Continue chatting as
// if nothing happened.

function RestoreDrawer({ onClose, onRestored }: {
  onClose: () => void
  onRestored: (msg: string) => void
}) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['agent.sessions'],
    queryFn: api.agentSessions,
  })
  const [busyIdx, setBusyIdx] = useState<number | null>(null)
  const sessions = data?.sessions ?? []

  const restore = async (idx: number) => {
    setBusyIdx(idx)
    try {
      const r = await api.agentRestoreSession(idx)
      onRestored(r.message)
    } catch (e: any) {
      await dialog.alert('恢复失败', e?.message || String(e))
    } finally {
      setBusyIdx(null)
    }
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/35 flex items-end justify-end" onClick={onClose}>
      <div className="w-[34rem] h-full bg-bg-soft border-l border-line flex flex-col"
           onClick={(e) => e.stopPropagation()}>
        <header className="px-5 py-3 border-b border-line flex items-baseline justify-between">
          <div>
            <h3 className="text-base font-semibold">恢复历史对话</h3>
            <p className="text-xs text-[#86775F] mt-0.5">来自 temp/model_responses/ 的运行时快照（完整恢复 native context）</p>
          </div>
          <button onClick={onClose} className="text-[#665741] hover:text-[#2C2418] text-xl leading-none">×</button>
        </header>

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {isLoading && <div className="text-[#86775F] text-sm p-4">载入中…</div>}
          {!isLoading && sessions.length === 0 && (
            <div className="text-[#86775F] text-sm p-6 text-center">
              尚无可恢复快照<br/>
              <span className="text-[#9A8B70] text-xs">（agent 运行后会在 temp/model_responses 留下快照）</span>
            </div>
          )}
          {sessions.map((s, idx) => (
            <div key={s.path} className="rounded-lg border border-line bg-bg-card p-3">
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <div className="text-xs text-[#665741]">{relTime(s.mtime)} · <span className="text-accent">{s.rounds} 轮</span></div>
                <button
                  onClick={() => restore(idx)}
                  disabled={busyIdx !== null}
                  className="text-xs px-2.5 py-1 rounded bg-accent text-white disabled:opacity-40"
                >
                  {busyIdx === idx ? '恢复中…' : '↩ 恢复'}
                </button>
              </div>
              <div className="text-sm text-[#2C2418] line-clamp-2 leading-snug">{s.preview || '(无预览)'}</div>
              <div className="text-[10px] text-[#9A8B70] mt-1 truncate font-mono" title={s.path}>{s.path}</div>
            </div>
          ))}
        </div>

        <footer className="border-t border-line px-4 py-2 text-xs text-[#86775F] flex items-center justify-between">
          <span>恢复后会覆盖当前 Agent 上下文</span>
          <button onClick={() => refetch()} className="text-accent hover:underline">↻ 刷新</button>
        </footer>
      </div>
    </div>
  )
}
