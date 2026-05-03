import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import type { ConversationSummary } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { MarkdownView } from '@/components/MarkdownView'
import { previewText, relTime } from '@/utils/foldTurns'
import { dialog } from '@/stores/dialogStore'

export function Conversations() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [restoring, setRestoring] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [page, setPage] = useState(0)
  const limit = 50

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 300)
    return () => window.clearTimeout(t)
  }, [q])

  const { data } = useQuery({
    queryKey: ['conversations', debouncedQ, page],
    queryFn: () => api.conversations(debouncedQ || undefined, page * limit, limit),
  })

  const [active, setActive] = useState<string | null>(null)
  const { data: detail } = useQuery({
    queryKey: ['conv', active],
    queryFn: () => api.conversation(active!),
    enabled: !!active,
  })

  const total = data?.total ?? 0
  const items = data?.items ?? []

  const handleRename = async (id: string, current: string) => {
    const v = await dialog.prompt('重命名会话', {
      defaultValue: current,
      placeholder: '新标题',
    })
    if (v == null) return
    await api.renameConversation(id, v)
    qc.invalidateQueries({ queryKey: ['conversations'] })
  }
  const handleDelete = async (id: string) => {
    const ok = await dialog.confirm(
      '删除该会话？',
      '此操作不可逆。',
      { confirmText: '删除', tone: 'danger' },
    )
    if (!ok) return
    await api.deleteConversation(id)
    qc.invalidateQueries({ queryKey: ['conversations'] })
    if (active === id) setActive(null)
  }
  const handleRestore = async (id: string) => {
    if (!detail) return
    const ok = await dialog.confirm(
      `恢复会话「${detail.title || id}」？`,
      `· 当前 Agent 上下文会被清空\n· 该会话的消息会作为历史摘要注入 Agent 记忆\n· 之后你可以在聊天界面继续对话`,
      { confirmText: '恢复并继续' },
    )
    if (!ok) return
    setRestoring(id)
    try {
      const r = await api.restoreConversation(id)
      qc.invalidateQueries({ queryKey: ['agent.status'] })
      qc.invalidateQueries({ queryKey: ['status'] })
      // Pass messages to LiveChat via router state for visual replay
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
      title="对话管理"
      description={`memory/chat_history.json — 共 ${total} 条会话`}
      actions={
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0) }}
          placeholder="搜索标题或内容…"
          className="bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent w-72"
        />
      }
    >
      <div className="flex h-full">
        <div className="w-96 border-r border-line bg-bg-soft overflow-y-auto">
          {items.map((c) => (
            <ConvRow
              key={c.id}
              c={c}
              active={active === c.id}
              onClick={() => setActive(c.id)}
              onRename={() => handleRename(c.id, c.title)}
              onDelete={() => handleDelete(c.id)}
            />
          ))}
          <div className="p-3 flex items-center justify-between text-xs text-slate-400">
            <button disabled={page === 0} onClick={() => setPage(page - 1)} className="px-2 py-1 disabled:opacity-30">← 上页</button>
            <span>第 {page + 1} 页</span>
            <button disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)} className="px-2 py-1 disabled:opacity-30">下页 →</button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!active && <div className="h-full flex items-center justify-center text-slate-500 text-sm">选择左侧会话查看详情</div>}
          {active && detail && (
            <div className="p-6 max-w-4xl mx-auto">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold">{detail.title || detail.id}</h2>
                  <div className="text-xs text-slate-500 mt-0.5">id: {detail.id} · {detail.messages?.length || 0} 条消息</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleRestore(detail.id)}
                    disabled={restoring === detail.id}
                    className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
                    title="把这个会话作为 Agent 的历史上下文，跳转到聊天页继续"
                  >
                    {restoring === detail.id ? '恢复中…' : '↩ 恢复并继续聊天'}
                  </button>
                  <a href={api.exportConversation(detail.id, 'md')}
                     className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm">
                    导出 .md
                  </a>
                  <a href={api.exportConversation(detail.id, 'json')}
                     className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5 text-sm">
                    导出 .json
                  </a>
                </div>
              </div>

              <div className="space-y-3">
                {(detail.messages || []).map((m, i) => (
                  <div key={i} className={`rounded-xl border ${m.role === 'user' ? 'border-accent/40 bg-accent-soft/30' : 'border-line bg-bg-card'} p-3`}>
                    <div className="text-xs uppercase tracking-wider text-slate-500 mb-1">{m.role}</div>
                    <MarkdownView>{m.content}</MarkdownView>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </PageShell>
  )
}

function ConvRow({ c, active, onClick, onRename, onDelete }: {
  c: ConversationSummary
  active: boolean
  onClick: () => void
  onRename: () => void
  onDelete: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={`px-3 py-2.5 cursor-pointer border-b border-line/60 group ${active ? 'bg-accent-soft' : 'hover:bg-white/5'}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-sm text-slate-200 truncate font-medium" title={c.title}>
          {c.title || c.id}
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
          <button onClick={(e) => { e.stopPropagation(); onRename() }} className="text-xs text-slate-400 hover:text-slate-200 px-1">✎</button>
          <button onClick={(e) => { e.stopPropagation(); onDelete() }} className="text-xs text-rose-400 hover:text-rose-300 px-1">✕</button>
        </div>
      </div>
      <div className="text-xs text-slate-500 truncate mt-0.5">{previewText(c.last_user_preview || '')}</div>
      <div className="text-[10px] text-slate-600 mt-0.5">{c.message_count} 条 · {c.id.slice(0, 19)}</div>
    </div>
  )
}
