// WeChat bot management — QR login, contacts, message log, manual send,
// allowlist, polling control. Subscribes to /ws/events?prefix=wechat: for
// live updates. Replaces the entire UI surface of frontends/wechatapp.py.

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { EventSocket, api } from '@/api/client'
import type { BusEvent, WxContact, WxLogEntry } from '@/api/types'
import { ImagePasteInput, type PasteAttachment } from '@/components/ImagePasteInput'
import { PageShell } from '@/components/PageShell'
import { QRCodeDisplay } from '@/components/QRCodeDisplay'
import { relTime } from '@/utils/foldTurns'
import { dialog } from '@/stores/dialogStore'

export function WechatBot() {
  const qc = useQueryClient()
  const { data: status } = useQuery({
    queryKey: ['wxStatus'],
    queryFn: api.wxStatus,
    refetchInterval: 3000,
  })
  const { data: contactsData } = useQuery({
    queryKey: ['wxContacts'],
    queryFn: api.wxContacts,
    refetchInterval: 5000,
  })
  const contacts = contactsData?.contacts ?? []

  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    if (!selected && contacts.length) setSelected(contacts[0].uid)
  }, [contacts, selected])

  const { data: msgData } = useQuery({
    queryKey: ['wxMessages', selected],
    queryFn: () => api.wxMessages(selected ?? undefined, 500),
    enabled: !!selected,
    refetchInterval: 4000,
  })

  // Live event push: refresh on incoming messages
  useEffect(() => {
    const s = new EventSocket('wechat:', 0)
    s.onEvent = (e: BusEvent) => {
      if (e.topic === 'wechat:message_in' || e.topic === 'wechat:message_out') {
        qc.invalidateQueries({ queryKey: ['wxMessages'] })
        qc.invalidateQueries({ queryKey: ['wxContacts'] })
      }
      if (e.topic === 'wechat:qr_status' || e.topic === 'wechat:logout' || e.topic === 'wechat:polling') {
        qc.invalidateQueries({ queryKey: ['wxStatus'] })
      }
    }
    s.open()
    return () => s.close()
  }, [qc])

  // ── send composer ──
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<PasteAttachment[]>([])
  const [busy, setBusy] = useState(false)

  const send = async () => {
    if (!selected) return
    const t = text.trim()
    if (!t && atts.length === 0) return
    setBusy(true)
    try {
      if (t) await api.wxSend(selected, t)
      for (const a of atts) {
        await api.wxSend(selected, undefined, a.path)
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

  const [showAllow, setShowAllow] = useState(false)

  const messages = msgData?.messages ?? []

  return (
    <PageShell
      title="微信机器人"
      description="管理个人微信 Bot：扫码登录、查看消息、手动发消息（支持图片粘贴）、白名单。"
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
          <button onClick={() => setShowAllow(true)}
                  className="px-3 py-1.5 rounded-lg border border-line text-slate-300 hover:bg-white/5">
            白名单
          </button>
          {status?.logged_in
            ? <button onClick={logout} className="px-3 py-1.5 rounded-lg border border-rose-700/60 text-rose-300 hover:bg-rose-900/20">退出登录</button>
            : <button onClick={startLogin} className="px-3 py-1.5 rounded-lg bg-accent text-white">扫码登录</button>}
        </div>
      }
    >
      {!status?.logged_in ? (
        <LoginPanel status={status} />
      ) : (
        <div className="flex h-full">
          {/* contacts */}
          <div className="w-72 border-r border-line bg-bg-soft overflow-y-auto">
            {contacts.length === 0 && (
              <div className="p-6 text-sm text-slate-500">
                还没有联系人。让用户给 Bot 发一条消息试试。
              </div>
            )}
            {contacts.map((c) => (
              <ContactRow
                key={c.uid}
                contact={c}
                active={selected === c.uid}
                onClick={() => setSelected(c.uid)}
              />
            ))}
          </div>
          {/* message stream + composer */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 overflow-y-auto p-6 space-y-3">
              {!selected && (
                <div className="h-full flex items-center justify-center text-slate-500">
                  选择一个联系人查看对话
                </div>
              )}
              {selected && messages.length === 0 && (
                <div className="text-slate-500 text-sm">尚无消息记录</div>
              )}
              {messages.map((m, i) => (
                <WxMessage key={i} m={m} />
              ))}
            </div>
            {selected && (
              <div className="border-t border-line bg-bg-soft p-4">
                <ImagePasteInput
                  text={text}
                  onText={setText}
                  attachments={atts}
                  onAttachments={setAtts}
                  onSubmit={send}
                  disabled={busy}
                  placeholder={`给 ${selected.slice(0, 24)}… 发消息（粘贴图片直接发图）`}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {showAllow && <AllowlistDrawer onClose={() => setShowAllow(false)} />}
    </PageShell>
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

function ContactRow({ contact, active, onClick }: { contact: WxContact; active: boolean; onClick: () => void }) {
  const initial = (contact.nickname || contact.uid || '?').slice(0, 1).toUpperCase()
  return (
    <div
      onClick={onClick}
      className={`px-3 py-2.5 cursor-pointer flex gap-3 items-center border-b border-line/60 ${active ? 'bg-accent-soft' : 'hover:bg-white/5'}`}
    >
      <div className="w-9 h-9 rounded-full bg-accent/30 text-accent flex items-center justify-center font-semibold shrink-0">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <div className="text-sm text-slate-200 truncate font-medium">
            {contact.nickname || contact.uid.slice(0, 16) + '…'}
          </div>
          <div className="text-xs text-slate-500 shrink-0">{relTime(contact.last_ts)}</div>
        </div>
        <div className="text-xs text-slate-500 truncate">{contact.last_text || '—'}</div>
      </div>
    </div>
  )
}

function WxMessage({ m }: { m: WxLogEntry }) {
  const isOut = m.direction === 'out'
  return (
    <div className={`flex ${isOut ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] rounded-2xl px-3.5 py-2 text-sm ${isOut ? 'bg-emerald-700/80 text-white' : 'bg-bg-card border border-line'}`}>
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
