import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { EventSocket, api } from '@/api/client'
import type { BusEvent, FsCheckResult } from '@/api/types'
import { MessageBubble } from '@/components/MessageBubble'
import { PageShell } from '@/components/PageShell'
import { useChatStore } from '@/stores/chatStore'
import { useFeishuStore, type FeishuMsg } from '@/stores/feishuStore'

function fmtTime(ts?: number) {
  if (!ts) return '尚未检测'
  return new Date(ts * 1000).toLocaleString()
}



export function FeishuBot() {
  const qc = useQueryClient()
  const chatConn = useChatStore((s) => s.conn)
  const remoteMsgs = useFeishuStore((s) => s.msgs)
  const addMsgs = useFeishuStore((s) => s.addMsgs)
  const statusQ = useQuery({ queryKey: ['feishu-status'], queryFn: api.fsStatus, refetchInterval: 60000 })
  const checkQ = useQuery({ queryKey: ['feishu-check'], queryFn: () => api.fsCheck(false), enabled: false })
  const [notice, setNotice] = useState('')
  const [saving, setSaving] = useState(false)
  const [showKeys, setShowKeys] = useState(false)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [allowedUsers, setAllowedUsers] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set())

  function toRemoteMsg(e: BusEvent): FeishuMsg | null {
    const p = e.payload || {}
    if (e.topic !== 'feishu:chat' || !p.task_id || !p.role || p.content === undefined) return null
    const rawType = String(p.type || 'summary')
    return {
      taskId: String(p.task_id || ''),
      chatId: String(p.chat_id || ''),
      role: p.role === 'user' ? 'user' : 'assistant',
      type: rawType === 'done' ? 'final' : (rawType as FeishuMsg['type']),
      content: String(p.content || ''),
      ts: typeof p.ts === 'number' ? p.ts * 1000 : e.ts ? e.ts * 1000 : Date.now(),
    }
  }

  const loadMessages = async () => {
    try {
      const res = await api.fsRecentEvents(500)
      const msgs = (res.events || []).map(toRemoteMsg).filter(Boolean) as FeishuMsg[]
      if (msgs.length > 0) addMsgs(msgs)
    } catch { /* ignore */ }
  }

  // 挂载时拉取一次历史；放弃实时推送，改为手动刷新以避免卡顿
  useEffect(() => {
    loadMessages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleRefresh() {
    setRefreshing(true)
    try {
      await Promise.all([statusQ.refetch(), checkQ.refetch(), loadMessages()])
    } finally {
      setRefreshing(false)
    }
  }

  const st = statusQ.data
  const check: FsCheckResult | null | undefined = checkQ.data || st?.last_check
  const connected = Boolean(st?.running)
  const configured = Boolean(check?.ready)
  const state = useMemo(() => {
    if (!st) return { label: '检测中', dot: 'bg-amber-400', text: '读取飞书长连接状态…' }
    if (!configured) return { label: '未配置', dot: 'bg-rose-500', text: '请在下方发送框里填入飞书 Key。' }
    if (connected) return { label: '已连接', dot: 'bg-emerald-500', text: st.pid ? `PID ${st.pid}` : '长连接在线' }
    return { label: '未连接', dot: 'bg-slate-400', text: 'Key 已配置，网关未运行。' }
  }, [st, connected, configured])

  const grouped = useMemo(() => {
    const map = new Map<string, FeishuMsg[]>()
    for (const m of remoteMsgs) {
      const key = m.taskId || `${m.chatId}:${m.ts}`
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(m)
    }
    // 先对每个task内部排序：user消息在前，assistant消息在后
    const tasks = Array.from(map.values()).map((msgs) => {
      msgs.sort((a, b) => {
        // 按 role 排序：user=0, assistant=1
        const roleOrder = { user: 0, assistant: 1 }
        const aOrder = roleOrder[a.role] ?? 99
        const bOrder = roleOrder[b.role] ?? 99
        if (aOrder !== bOrder) return aOrder - bOrder
        // role 相同时按时间戳升序
        return a.ts - b.ts
      })
      return msgs
    })
    // 再对外层task数组排序：按每个task的最新消息时间戳升序（旧对话在上面）
    tasks.sort((a, b) => {
      const aMax = Math.max(...a.map(m => m.ts))
      const bMax = Math.max(...b.map(m => m.ts))
      return aMax - bMax
    })
    return tasks
  }, [remoteMsgs])

  async function saveKeys() {
    setSaving(true); setNotice('')
    try {
      await api.fsSaveKeys(appId, appSecret, allowedUsers)
      setNotice('飞书 Key 已保存。重启飞书网关后生效。')
      setShowKeys(false); setAppSecret('')
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['feishu-status'] }),
        qc.invalidateQueries({ queryKey: ['feishu-check'] }),
      ])
    } catch (e: any) {
      setNotice(`保存失败：${e?.message || e}`)
    } finally { setSaving(false) }
  }

  return <PageShell 
    title="飞书 Bot" 
    description="远程飞书对话流"
    actions={
      <div className="flex items-center gap-2 text-sm flex-wrap justify-end">
        <span className={clsx(
          'flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full border',
          !st ? 'bg-bg-soft text-[#3A3020] border-line'
            : !configured ? 'bg-[#F3D6D6] text-[#8A3A3A] border-[#C98A8A]'
            : connected ? 'bg-[#D6E1D0] text-[#355C43] border-[#8FA67D]'
            : 'bg-bg-soft text-[#3A3020] border-line'
        )}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', state.dot)} />
          {state.label}
        </span>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="bg-bg-card border border-line rounded-md px-3 py-2 text-xs outline-none hover:border-accent/80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {refreshing ? '刷新中…' : '刷新'}
        </button>
        <button
          onClick={() => setShowKeys((v) => !v)}
          className="bg-bg-card border border-line rounded-md px-3 py-2 text-xs outline-none hover:border-accent/80"
        >
          飞书 Key
        </button>
      </div>
    }
  >
    <div className="relative flex h-full flex-col overflow-hidden">
      <main className="relative flex-1 overflow-y-auto px-4 py-4">
        {notice && <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">{notice}</div>}
        {grouped.length === 0 ? <div className="grid h-full place-items-center text-center text-sm text-slate-500">
          <div>
            <div className="mb-2 text-3xl">🪽</div>
            <div className="font-medium text-slate-700">暂无飞书远程对话</div>
            <div className="mt-1">飞书用户发来的消息和 GA 回复会显示在这里。</div>
          </div>
        </div> : <div className="space-y-3">
          {grouped.map((task, ti) => {
            const expanded = expandedTasks.has(ti)
            const summaryIdx: number[] = []
            task.forEach((m, i) => { if (m.type === 'summary') summaryIdx.push(i) })
            const FOLD_AFTER = 5
            // 超过 5 条 summary 时，第 5 条之后的 summary 默认折叠
            const hideFrom = summaryIdx.length > FOLD_AFTER ? summaryIdx[FOLD_AFTER] : -1
            const hiddenCount = hideFrom >= 0 ? summaryIdx.length - FOLD_AFTER : 0
            const toggle = () => setExpandedTasks((prev) => {
              const next = new Set(prev)
              next.has(ti) ? next.delete(ti) : next.add(ti)
              return next
            })
            return <div key={ti} className="space-y-1.5 rounded-xl border border-[#E8DFD1] bg-white p-2 shadow-sm">
              {task.map((m, mi) => {
                // 折叠区间：仅折叠 summary，且未展开时
                if (hideFrom >= 0 && !expanded && m.type === 'summary' && mi >= hideFrom) {
                  // 在第一个被折叠的位置插入展开按钮，其余跳过
                  if (mi === hideFrom) {
                    return <button key={mi} onClick={toggle} className="w-full rounded-lg border border-dashed border-[#D8CBB4] bg-slate-50/60 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 transition-colors">
                      展开其余 {hiddenCount} 条中间步骤 ▾
                    </button>
                  }
                  return null
                }
                if (m.type === 'summary') {
                  return <div key={mi} className="rounded-lg bg-slate-50 px-3 py-1.5 text-xs text-slate-600">⏳ {m.content}</div>
                }
                return <MessageBubble key={mi} role={m.role} content={m.content} streaming={false} streamId={m.taskId} compact />
              })}
              {hideFrom >= 0 && expanded && <button onClick={toggle} className="w-full rounded-lg border border-dashed border-[#D8CBB4] bg-slate-50/60 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-100 transition-colors">
                收起中间步骤 ▴
              </button>}
            </div>
          })}
        </div>}
      </main>

      {showKeys && <div className="absolute inset-0 z-20 grid place-items-center bg-black/30 p-4" onClick={() => setShowKeys(false)}>
        <div className="w-full max-w-md rounded-2xl border border-[#E8DFD1] bg-white p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-[#2C2418]">飞书 Key 信息</h2>
              <p className="text-xs text-slate-500">保存到 GA keychain：feishu_app_id / feishu_app_secret / feishu_allowed_users。</p>
            </div>
            <button onClick={() => setShowKeys(false)} className="rounded-full px-3 py-1 text-slate-500 hover:bg-slate-100">✕</button>
          </div>
          <div className="grid gap-3">
            <input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="app_id" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#2C2418]" />
            <input value={appSecret} onChange={(e) => setAppSecret(e.target.value)} placeholder="app_secret" type="password" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#2C2418]" />
            <input value={allowedUsers} onChange={(e) => setAllowedUsers(e.target.value)} placeholder="allowed_users，可选" className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#2C2418]" />
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button onClick={() => setShowKeys(false)} className="rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">取消</button>
            <button disabled={saving || !appId.trim() || !appSecret.trim()} onClick={saveKeys} className="rounded-xl bg-[#2C2418] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">{saving ? '保存中…' : '保存'}</button>
          </div>
        </div>
      </div>}
    </div>
  </PageShell>
}
