// CommandPalette — Cmd/Ctrl+K global searchable launcher.
//
// Aggregates actions from across the app into one searchable list:
//   • Page jumps              (Dashboard, Chat, Memory, …)
//   • LLM switching            (every entry from /api/llms)
//   • Agent control            (新对话 / 停止 / 恢复历史)
//   • Autonomous schedules     (立即触发 *)
//   • SOPs / skills            (open in their respective viewers)
//   • Conversations            (jump to detail)
//
// Keyboard model: ↑/↓ navigate, Enter executes, Esc closes. Typing filters
// by token-subsequence match (so "ai chat" matches "实时聊天 / live chat").

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api } from '@/api/client'
import { useChatStore } from '@/stores/chatStore'
import { dialog } from '@/stores/dialogStore'

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
  const nav = useNavigate()
  const qc = useQueryClient()
  const abortAgent = useChatStore((s) => s.abort)
  const clearLocal = useChatStore((s) => s.clearLocal)
  const pushSystem = useChatStore((s) => s.pushSystem)

  // Global open hotkey: Cmd+K (mac) or Ctrl+K (win/linux). Captures even
  // when focus is in textarea/select; consumers commonly want it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // When opened, clear filter + autofocus
  useEffect(() => {
    if (open) {
      setQ('')
      setCursor(0)
      const id = window.setTimeout(() => inputRef.current?.focus(), 30)
      return () => window.clearTimeout(id)
    }
  }, [open])

  // Data sources — only fetched while the palette is open
  const { data: llms } = useQuery({
    queryKey: ['llms'],
    queryFn: api.llms,
    enabled: open,
    staleTime: 30_000,
  })
  const { data: schedules } = useQuery({
    queryKey: ['schedules'],
    queryFn: api.schedules,
    enabled: open,
    staleTime: 30_000,
  })
  const { data: sops } = useQuery({
    queryKey: ['sops'],
    queryFn: api.sops,
    enabled: open,
    staleTime: 60_000,
  })
  const { data: convs } = useQuery({
    queryKey: ['conversations', '', 0],
    queryFn: () => api.conversations(undefined, 0, 30),
    enabled: open,
    staleTime: 30_000,
  })

  const actions = useMemo<Action[]>(() => {
    const acts: Action[] = []
    // Page jumps
    const pages = [
      { p: '/dashboard', label: '仪表盘 / Dashboard', icon: '📊' },
      { p: '/chat', label: '实时聊天 / Live Chat', icon: '💬' },
      { p: '/wechat', label: '微信机器人 / WeChat Bot', icon: '🤖' },
      { p: '/conversations', label: '对话管理 / Conversations', icon: '🗂️' },
      { p: '/memory', label: '记忆 & SOP / Memory', icon: '🧠' },
      { p: '/skills', label: '技能库 / Skills', icon: '🌳' },
      { p: '/llms', label: '选择 LLM', icon: '⚡' },
      { p: '/autonomous', label: '自主进化 / Autonomous', icon: '🌀' },
      { p: '/settings', label: '设置 / Settings', icon: '⚙️' },
    ]
    for (const x of pages) {
      acts.push({
        id: `nav:${x.p}`, group: '页面', icon: x.icon, label: x.label,
        run: () => nav(x.p),
      })
    }

    // Quick agent actions
    acts.push({
      id: 'agent:new', group: '快捷操作', icon: '✨',
      label: '新对话',
      hint: '清空当前 Agent 上下文',
      run: async () => {
        const ok = await dialog.confirm('开始新对话？', '当前 Agent 上下文会被清空。', {
          confirmText: '新建', tone: 'danger',
        })
        if (!ok) return
        const r = await api.agentNew()
        clearLocal()
        pushSystem(r.message)
        nav('/chat')
      },
    })
    acts.push({
      id: 'agent:abort', group: '快捷操作', icon: '⏹',
      label: '停止 Agent',
      run: () => abortAgent(),
    })

    // LLM switching
    for (const l of llms?.llms ?? []) {
      if (l.current) continue
      acts.push({
        id: `llm:${l.index}`, group: '切换 LLM', icon: '⚡',
        label: `[${l.index}] ${l.name}`,
        run: async () => {
          await api.switchLLM(l.index)
          qc.invalidateQueries({ queryKey: ['llms'] })
          qc.invalidateQueries({ queryKey: ['status'] })
          pushSystem(`_已切换到 [${l.index}] ${l.name}_`)
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
          const ok = await dialog.confirm('立即触发？', s.name || s.id, { confirmText: '触发' })
          if (!ok) return
          await api.triggerSchedule(s.id)
          qc.invalidateQueries({ queryKey: ['auto.runs'] })
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
        run: () => nav('/memory'),
      })
    }

    // Conversations
    for (const c of (convs?.items ?? []).slice(0, 30)) {
      acts.push({
        id: `conv:${c.id}`, group: '历史对话', icon: '💬',
        label: c.title || c.id,
        hint: `${c.message_count} 条`,
        run: () => nav('/conversations'),
      })
    }

    return acts
  }, [llms, schedules, sops, convs, nav, qc, abortAgent, clearLocal, pushSystem])

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
    close()
    try { await a.run() } catch (e: any) { dialog.alert('操作失败', e?.message || String(e)) }
  }

  const onKey = (e: React.KeyboardEvent) => {
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
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
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
      className="fixed inset-0 z-40 bg-black/55 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-4"
      onClick={close}
    >
      <div
        className="w-full max-w-xl bg-bg-soft border border-line rounded-xl shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); setCursor(0) }}
          onKeyDown={onKey}
          placeholder="跳转 · 切 LLM · 触发任务 · 搜索…"
          className="w-full bg-transparent border-b border-line px-4 py-3 text-base outline-none text-slate-200 placeholder:text-slate-500"
        />
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
          {groups.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-slate-500">没有匹配项</div>
          )}
          {groups.map((g) => (
            <div key={g.name}>
              <div className="px-3 pt-2.5 pb-1 text-[10px] uppercase tracking-wider text-slate-500">
                {g.name}
              </div>
              {g.items.map(({ a, idx }) => (
                <button
                  key={a.id}
                  data-cmd-idx={idx}
                  onMouseEnter={() => setCursor(idx)}
                  onClick={() => exec(a)}
                  className={clsx(
                    'w-full flex items-center gap-3 px-3 py-2 text-sm text-left transition',
                    idx === cursor ? 'bg-accent-soft text-accent' : 'text-slate-300 hover:bg-white/5',
                  )}
                >
                  <span className="text-base shrink-0">{a.icon || '·'}</span>
                  <span className="flex-1 truncate">{a.label}</span>
                  {a.hint && <span className="text-[10px] text-slate-500 shrink-0">{a.hint}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="border-t border-line px-3 py-1.5 text-[10px] text-slate-500 flex items-center gap-3">
          <span>↑↓ 导航</span>
          <span>↵ 执行</span>
          <span>Esc 关闭</span>
          <span className="ml-auto">⌘/Ctrl + K 切换</span>
        </div>
      </div>
    </div>
  )
}
