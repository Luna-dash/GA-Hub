// WeChat bot management — QR login, single-stream chat view, manual send.
//
// UI model: a personal bot binds to ONE WeChat account. The page shows
// every inbound/outbound message in time order; no contacts sidebar
// because in real personal-bot use one talks to oneself or a small set
// of people, not a CRM-style contact roster. The composer auto-targets
// the most recent inbound sender; if the log contains multiple senders,
// a small dropdown lets the user switch. Allowlist + log-clear live in
// an overflow menu so the main surface stays clean.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { EventSocket, api } from '@/api/client'
import type { BusEvent, WxLogEntry } from '@/api/types'
import { ImagePasteInput, type PasteAttachment } from '@/components/ImagePasteInput'
import { PageShell } from '@/components/PageShell'
import { QRCodeDisplay } from '@/components/QRCodeDisplay'
import { dialog } from '@/stores/dialogStore'

export function WechatBot() {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['wxStatus'],
    queryFn: api.wxStatus,
    refetchInterval: 3000,
  })

  // Pull the full log (all uids, time-sorted on server). 1000 entries is
  // plenty for the scroll buffer; older history sits on disk and reloads
  // on next launch.
  const { data: msgData } = useQuery({
    queryKey: ['wxMessages'],
    queryFn: () => api.wxMessages(undefined, 1000),
    refetchInterval: 4000,
    enabled: !!status?.logged_in,
  })
  const messages = msgData?.messages ?? []

  // Live event push: refresh on incoming/outgoing
  useEffect(() => {
    const s = new EventSocket('wechat:', 0)
    s.onEvent = (e: BusEvent) => {
      if (e.topic === 'wechat:message_in' || e.topic === 'wechat:message_out' || e.topic === 'wechat:log_cleared') {
        qc.invalidateQueries({ queryKey: ['wxMessages'] })
      }
      if (e.topic === 'wechat:qr_status' || e.topic === 'wechat:logout' || e.topic === 'wechat:polling') {
        qc.invalidateQueries({ queryKey: ['wxStatus'] })
      }
    }
    s.open()
    return () => s.close()
  }, [qc])

  // Auto-track the most recent inbound sender as reply target. User can
  // override via the dropdown; their pick persists until they clear it.
  const recentInbounds = useMemo(() => {
    const seen = new Map<string, { uid: string; nickname: string; ts: number }>()
    for (const m of messages) {
      if (m.direction !== 'in') continue
      const prev = seen.get(m.uid)
      if (!prev || m.ts > prev.ts) {
        seen.set(m.uid, { uid: m.uid, nickname: m.nickname || '', ts: m.ts })
      }
    }
    return Array.from(seen.values()).sort((a, b) => b.ts - a.ts)
  }, [messages])

  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyManual, setReplyManual] = useState(false)
  useEffect(() => {
    if (replyManual) return
    if (recentInbounds.length && recentInbounds[0].uid !== replyTo) {
      setReplyTo(recentInbounds[0].uid)
    }
  }, [recentInbounds, replyTo, replyManual])

  // Auto-scroll to bottom on new message (unless user has scrolled up).
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages])

  // ── send composer ──
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<PasteAttachment[]>([])
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!replyTo) return
    const t = text.trim()
    if (!t && atts.length === 0) return
    setBusy(true)
    try {
      if (t) await api.wxSend(replyTo, t)
      for (const a of atts) {
        await api.wxSend(replyTo, undefined, a.path)
      }
      setText('')
      setAtts([])
      qc.invalidateQueries({ queryKey: ['wxMessages'] })
    } catch (e: any) {
      await dialog.alert('发送失败', e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  // ── login flow ──
  const startLogin = async () => {
    await api.wxLogin()
    qc.invalidateQueries({ queryKey: ['wxStatus'] })
  }
  const logout = async () => {
    const ok = await dialog.confirm('确认退出微信登录？', undefined, {
      confirmText: '退出',
      tone: 'danger',
    })
    if (!ok) return
    await api.wxLogout()
    qc.invalidateQueries({ queryKey: ['wxStatus'] })
  }
  const clearLog = async () => {
    const ok = await dialog.confirm('清空微信对话记录？', '本地与磁盘上的 wechat_log.jsonl 都会被删除，无法撤销。', {
      confirmText: '清空',
      tone: 'danger',
    })
    if (!ok) return
    await api.wxClearMessages()
    qc.invalidateQueries({ queryKey: ['wxMessages'] })
  }

  const [showAllow, setShowAllow] = useState(false)
  const [showMenu, setShowMenu] = useState(false)

  return (
    <PageShell
      title="微信机器人"
      description="管理个人微信 Bot：扫码登录、查看并回复消息（支持图片粘贴）。"
      actions={
        <div className="flex items-center gap-2 text-sm">
          <span className={`px-2 py-0.5 rounded ${status?.logged_in ? 'bg-emerald-900/40 text-emerald-300' : 'bg-rose-900/40 text-rose-300'}`}>
            {status?.logged_in ? `已登录 · ${status.bot_id}` : '未登录'}
          </span>
          {status?.logged_in && (
            <span className={`px-2 py-0.5 rounded ${status.polling ? 'bg-emerald-900/40 text-emerald-300' : 'bg-amber-900/40 text-amber-300'}`}>
              {status.polling ? '轮询中' : '轮询已停止'}
            </span>
          )}
          {status?.logged_in
            ? <button onClick={logout} className="px-3 py-1.5 rounded-lg border border-rose-700/60 text-rose-300 hover:bg-rose-900/20">退出登录</button>
            : <button onClick={startLogin} className="px-3 py-1.5 rounded-lg bg-accent text-white">扫码登录</button>}
          <div className="relative">
            <button
              onClick={() => setShowMenu((v) => !v)}
              className="px-2.5 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5"
              aria-label="更多"
              title="更多"
            >⋯</button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 mt-1 w-40 bg-bg-soft border border-line rounded-lg shadow-lg z-20 overflow-hidden">
                  <MenuItem onClick={() => { setShowMenu(false); setShowAllow(true) }}>白名单</MenuItem>
                  <MenuItem onClick={() => { setShowMenu(false); clearLog() }} danger>清空记录</MenuItem>
                </div>
              </>
            )}
          </div>
        </div>
      }
    >
      {!status?.logged_in ? (
        <LoginPanel status={status} />
      ) : (
        <div className="flex flex-col h-full">
          <div
            ref={scrollerRef}
            className="flex-1 overflow-y-auto p-6 space-y-2"
            onScroll={(e) => {
              const t = e.currentTarget
              stickToBottomRef.current =
                t.scrollHeight - t.scrollTop - t.clientHeight < 40
            }}
          >
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-slate-500 text-sm">
                尚无消息记录。让用户给 Bot 发一条消息试试。
              </div>
            ) : (
              messages.map((m, i) => {
                const prev = i > 0 ? messages[i - 1] : undefined
                const showSender =
                  m.direction === 'in' && (!prev || prev.uid !== m.uid || prev.direction !== 'in')
                return <WxMessage key={i} m={m} showSender={showSender} />
              })
            )}
          </div>
          <div className="border-t border-line bg-bg-soft p-4">
            <ReplyTargetBar
              replyTo={replyTo}
              recentInbounds={recentInbounds}
              onChange={(uid) => { setReplyTo(uid); setReplyManual(true) }}
              onAuto={() => setReplyManual(false)}
              manual={replyManual}
            />
            <ImagePasteInput
              text={text}
              onText={setText}
              attachments={atts}
              onAttachments={setAtts}
              onSubmit={send}
              disabled={busy || !replyTo}
              placeholder={
                replyTo
                  ? `回复消息（粘贴图片直接发图）`
                  : '等对方先发一条消息再回复…'
              }
            />
          </div>
        </div>
      )}

      {showAllow && <AllowlistDrawer onClose={() => setShowAllow(false)} />}
    </PageShell>
  )
}

function MenuItem({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 text-sm hover:bg-white/5 ${danger ? 'text-rose-300' : 'text-slate-200'}`}
    >{children}</button>
  )
}

function ReplyTargetBar({
  replyTo, recentInbounds, onChange, onAuto, manual,
}: {
  replyTo: string | null
  recentInbounds: { uid: string; nickname: string; ts: number }[]
  onChange: (uid: string) => void
  onAuto: () => void
  manual: boolean
}) {
  if (!replyTo) return null
  const cur = recentInbounds.find((r) => r.uid === replyTo)
  const label = cur?.nickname || replyTo.slice(0, 16) + '…'
  return (
    <div className="flex items-center gap-2 text-xs text-slate-500 mb-2">
      <span>回复给:</span>
      {recentInbounds.length > 1 ? (
        <select
          value={replyTo}
          onChange={(e) => onChange(e.target.value)}
          className="bg-bg-card border border-line rounded px-2 py-0.5 text-slate-300 text-xs outline-none focus:border-accent"
        >
          {recentInbounds.map((r) => (
            <option key={r.uid} value={r.uid}>
              {r.nickname || r.uid.slice(0, 16) + '…'}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-slate-300">{label}</span>
      )}
      {manual && (
        <button
          onClick={onAuto}
          className="text-slate-500 hover:text-slate-300 underline-offset-2 hover:underline"
          title="跟随最新发言者"
        >自动跟随</button>
      )}
    </div>
  )
}

function LoginPanel({ status }: { status?: any }) {
  const qr = status?.qr || {}
  const url = qr.url
  const st = qr.status || 'idle'
  const stLabel: Record<string, string> = {
    idle: '点击右上角"扫码登录"开始',
    waiting_scan: '请用微信扫描下方二维码',
    scanning: '已扫描，等待手机端确认…',
    confirmed: '✅ 登录成功',
    expired: '❌ 二维码已过期，请重新登录',
    error: '❌ ' + (qr.error || '错误'),
    timeout: '轮询超时，正在重试…',
  }
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4 p-8 rounded-xl border border-line bg-bg-card">
        <div className="text-base font-semibold">微信机器人未登录</div>
        <div className="text-sm text-slate-400">{stLabel[st] || st}</div>
        {url && st !== 'confirmed' && <QRCodeDisplay url={url} />}
      </div>
    </div>
  )
}

function WxMessage({ m, showSender }: { m: WxLogEntry; showSender: boolean }) {
  const isOut = m.direction === 'out'
  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div className="flex flex-col max-w-[75%]">
        {showSender && (
          <div className="text-[11px] text-slate-500 mb-0.5 ml-2 truncate">
            {m.nickname || m.uid.slice(0, 16) + '…'}
          </div>
        )}
        <div className={`rounded-2xl px-3.5 py-2 text-sm ${isOut ? 'bg-emerald-700/80 text-white' : 'bg-bg-card border border-line'}`}>
          {m.text && <div className="whitespace-pre-wrap break-words leading-6">{m.text}</div>}
          {m.media?.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {m.media.map((p, i) => (
                <a key={i} href={api.fileUrlByPath(p)} target="_blank" rel="noreferrer">
                  {/\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(p)
                    ? <img src={api.fileUrlByPath(p)} alt="" className="h-28 rounded-lg" />
                    : <div className="px-2 py-1 rounded bg-black/20 text-xs">📎 {p.split('/').pop()}</div>}
                </a>
              ))}
            </div>
          )}
          <div className={`text-[10px] mt-1 ${isOut ? 'text-white/70' : 'text-slate-500'}`}>
            {new Date(m.ts * 1000).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  )
}

function AllowlistDrawer({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['wxAllow'], queryFn: api.wxAllowlist })
  const [list, setList] = useState<string[]>([])
  const [input, setInput] = useState('')
  useEffect(() => { if (data) setList(data.allowlist) }, [data])
  const isPublic = list.length === 1 && list[0] === '*'

  const save = async () => {
    await api.wxSetAllowlist(list)
    qc.invalidateQueries({ queryKey: ['wxAllow'] })
    qc.invalidateQueries({ queryKey: ['wxStatus'] })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-30 bg-black/50 flex items-end justify-end" onClick={onClose}>
      <div className="w-[28rem] h-full bg-bg-soft border-l border-line p-5 overflow-y-auto"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline justify-between mb-4">
          <div className="text-base font-semibold">微信白名单</div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-slate-500 mb-3">
          ['*'] 表示公开放行所有用户。否则只有列表中的 uid 能与 Bot 对话。
        </p>
        <div className="flex items-center gap-2 mb-3">
          <button
            onClick={() => setList(['*'])}
            className={`px-3 py-1.5 rounded-lg text-sm ${isPublic ? 'bg-accent text-white' : 'border border-line text-slate-300'}`}
          >公开（*）</button>
          <button
            onClick={() => setList(isPublic ? [] : list)}
            className={`px-3 py-1.5 rounded-lg text-sm ${!isPublic ? 'bg-accent text-white' : 'border border-line text-slate-300'}`}
          >仅白名单</button>
        </div>

        {!isPublic && (
          <>
            <div className="flex gap-2 mb-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="粘贴 uid，例如 o9cq80wIze0..."
                className="flex-1 bg-bg-card border border-line rounded-lg px-3 py-1.5 text-sm outline-none focus:border-accent"
              />
              <button
                onClick={() => { if (input.trim()) { setList([...new Set([...list, input.trim()])]); setInput('') } }}
                className="px-3 py-1.5 rounded-lg bg-accent text-white text-sm"
              >添加</button>
            </div>
            <ul className="space-y-1">
              {list.map((u) => (
                <li key={u} className="flex items-center justify-between px-3 py-1.5 rounded-lg bg-bg-card border border-line text-sm font-mono">
                  <span className="truncate">{u}</span>
                  <button onClick={() => setList(list.filter((x) => x !== u))}
                          className="text-rose-400 hover:text-rose-300 ml-2">移除</button>
                </li>
              ))}
              {list.length === 0 && <li className="text-slate-500 text-sm py-2">列表为空 → 任何人都无法与 Bot 对话</li>}
            </ul>
          </>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-line text-slate-300">取消</button>
          <button onClick={save} className="px-3 py-1.5 rounded-lg bg-accent text-white">保存</button>
        </div>
      </div>
    </div>
  )
}
