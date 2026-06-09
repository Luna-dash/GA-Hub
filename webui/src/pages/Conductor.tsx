import { FormEvent, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { api, EventSocket } from '@/api/client'
import { useConductorStore } from '@/stores/conductorStore'
import type { ConductorApprovalItem, ConductorSubagent } from '@/api/types'

function relTime(ts: number): string {
  const sec = Math.floor((Date.now() - ts) / 1000)
  if (sec < 60) return `${sec}秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  return `${day}天前`
}

export default function Conductor() {
  const qc = useQueryClient()
  const [userMsg, setUserMsg] = useState('')
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const logEndRef = useRef<HTMLDivElement>(null)

  const store = useConductorStore()

  // Poll status
  const { data: status } = useQuery({
    queryKey: ['conductor', 'status'],
    queryFn: () => api.conductorStatus(),
    refetchInterval: 3000,
  })

  // Poll subagents
  useQuery({
    queryKey: ['conductor', 'subagents'],
    queryFn: async () => {
      const res = await api.conductorSubagents()
      store.setSubagents(res.items)
      return res.items
    },
    refetchInterval: 2000,
  })

  // Poll chat
  useQuery({
    queryKey: ['conductor', 'chat'],
    queryFn: async () => {
      const res = await api.conductorChat(50)
      store.setChatMessages(res.items)
      return res.items
    },
    refetchInterval: 2000,
  })

  // Poll log
  useQuery({
    queryKey: ['conductor', 'log'],
    queryFn: async () => {
      const res = await api.conductorLog()
      store.setLog(res.log)
      return res.log
    },
    refetchInterval: 2000,
  })

  // EventSocket for real-time updates
  useEffect(() => {
    const sock = new EventSocket('conductor:', 0)
    sock.onEvent = (evt) => {
      if (evt.topic === 'conductor:chat_msg' && evt.payload.item) {
        store.addChatMessage(evt.payload.item)
        qc.invalidateQueries({ queryKey: ['conductor', 'chat'] })
      }
      if (evt.topic === 'conductor:subagent_cards' && evt.payload.items) {
        store.setSubagents(evt.payload.items)
        qc.invalidateQueries({ queryKey: ['conductor', 'subagents'] })
      }
      if (evt.topic === 'conductor:log' && evt.payload.item) {
        store.addLogItem(evt.payload.item)
      }
      if (evt.topic === 'conductor:approval' && evt.payload.item) {
        store.addApproval(evt.payload.item)
      }
    }
    sock.open()
    return () => sock.close()
  }, [qc, store])

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [store.chatMessages])

  // Auto-scroll log
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [store.log])

  const sendChat = async (e: FormEvent) => {
    e.preventDefault()
    if (!userMsg.trim()) return
    const msg = userMsg.trim()
    setUserMsg('')
    await api.conductorSendChat(msg, 'user')
    qc.invalidateQueries({ queryKey: ['conductor', 'chat'] })
  }

  const startConductor = async () => {
    await api.conductorStart()
    qc.invalidateQueries({ queryKey: ['conductor', 'status'] })
  }

  const stopConductor = async () => {
    await api.conductorStop()
    qc.invalidateQueries({ queryKey: ['conductor', 'status'] })
  }

  const approveTask = async (item: ConductorApprovalItem) => {
    await api.conductorStartSubagent(item.prompt)
    store.removeApproval(item.id)
    qc.invalidateQueries({ queryKey: ['conductor', 'subagents'] })
  }

  const rejectTask = (item: ConductorApprovalItem) => {
    store.removeApproval(item.id)
  }

  const selectedDetail = selectedSubagent
    ? store.subagents.find((s) => s.id === selectedSubagent)
    : null

  return (
    <div className="flex flex-col h-screen bg-bg text-fg">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-line bg-bg-soft">
        <div>
          <h1 className="text-2xl font-semibold text-slate-100">Conductor</h1>
          <p className="text-sm text-slate-400 mt-1">
            多 Agent 编排 · Supervisor + Subagent 池
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm text-slate-400">
            {status?.started ? (
              <span className="text-green-400">● 运行中</span>
            ) : (
              <span className="text-slate-500">○ 未启动</span>
            )}
            {status && (
              <span className="ml-3">
                {status.subagents.running} running / {status.subagents.stopped} stopped
              </span>
            )}
          </div>
          {status?.started ? (
            <button
              onClick={stopConductor}
              className="px-3 py-1.5 text-sm rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30"
            >
              停止
            </button>
          ) : (
            <button
              onClick={startConductor}
              className="px-3 py-1.5 text-sm rounded-lg bg-accent text-white hover:brightness-110"
            >
              启动
            </button>
          )}
        </div>
      </header>

      {/* Main 3-col */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Subagents */}
        <div className="w-80 border-r border-line flex flex-col bg-bg-soft">
          <div className="px-4 py-3 border-b border-line">
            <h2 className="text-sm font-semibold text-slate-300">Subagents</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {store.subagents.length === 0 && (
              <p className="text-xs text-slate-500 text-center mt-4">暂无 subagent</p>
            )}
            {store.subagents.map((sub) => (
              <SubagentCard
                key={sub.id}
                sub={sub}
                selected={selectedSubagent === sub.id}
                onClick={() => setSelectedSubagent(sub.id)}
              />
            ))}
          </div>
        </div>

        {/* Middle: Chat */}
        <div className="flex-1 flex flex-col">
          <div className="px-4 py-3 border-b border-line bg-bg-soft">
            <h2 className="text-sm font-semibold text-slate-300">Chat with Conductor</h2>
          </div>
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {store.chatMessages.map((msg) => (
              <div
                key={msg.id}
                className={clsx(
                  'p-3 rounded-lg text-sm',
                  msg.role === 'user'
                    ? 'bg-accent/10 text-slate-100 ml-8'
                    : 'bg-bg-soft text-slate-200 mr-8'
                )}
              >
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-xs font-medium text-slate-400">
                    {msg.role === 'user' ? 'You' : 'Conductor'}
                  </span>
                  <span className="text-xs text-slate-500">{relTime(msg.ts)}</span>
                </div>
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form onSubmit={sendChat} className="border-t border-line p-4 bg-bg-soft">
            <div className="flex gap-2">
              <input
                value={userMsg}
                onChange={(e) => setUserMsg(e.target.value)}
                placeholder="给 Conductor 发消息..."
                className="flex-1 px-3 py-2 rounded-lg border border-line bg-bg text-slate-100 text-sm placeholder:text-slate-500 outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
              <button
                type="submit"
                disabled={!userMsg.trim()}
                className="px-4 py-2 rounded-lg bg-accent text-white text-sm hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                发送
              </button>
            </div>
          </form>
        </div>

        {/* Right: Log or Detail */}
        <div className="w-96 border-l border-line flex flex-col bg-bg-soft">
          {selectedDetail ? (
            <>
              <div className="px-4 py-3 border-b border-line flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-300">Subagent Detail</h2>
                <button
                  onClick={() => setSelectedSubagent(null)}
                  className="text-xs text-slate-500 hover:text-slate-300"
                >
                  关闭
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                <div>
                  <div className="text-xs text-slate-500 mb-1">ID</div>
                  <div className="text-sm text-slate-300 font-mono">{selectedDetail.id}</div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Prompt</div>
                  <pre className="text-sm text-slate-300 whitespace-pre-wrap bg-bg rounded p-2">
                    {selectedDetail.prompt}
                  </pre>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Status</div>
                  <div
                    className={clsx(
                      'text-sm',
                      selectedDetail.status === 'running' ? 'text-green-400' : 'text-slate-500'
                    )}
                  >
                    {selectedDetail.status}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-500 mb-1">Reply ({selectedDetail.reply.length} chars)</div>
                  <pre className="text-xs text-slate-300 whitespace-pre-wrap bg-bg rounded p-2 max-h-96 overflow-y-auto">
                    {selectedDetail.reply || '(无输出)'}
                  </pre>
                </div>
              </div>
            </>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-line">
                <h2 className="text-sm font-semibold text-slate-300">Log Stream</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
                {store.log.map((item) => (
                  <div key={item.id} className="text-xs text-slate-400 font-mono">
                    <span className="text-slate-600">[T{item.turn}]</span>{' '}
                    <span className="text-accent/70">{item.event}</span> {item.text}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </>
          )}
        </div>
      </div>

      {/* Approval floating cards */}
      {store.approvals.length > 0 && (
        <div className="fixed bottom-6 right-6 w-96 space-y-2">
          {store.approvals.map((item) => (
            <div key={item.id} className="bg-bg-soft border border-accent/50 rounded-lg p-4 shadow-xl">
              <div className="text-sm font-semibold text-slate-200 mb-2">待批准任务</div>
              <div className="text-xs text-slate-400 mb-1">来源: {item.source}</div>
              <pre className="text-xs text-slate-300 whitespace-pre-wrap bg-bg rounded p-2 mb-3 max-h-32 overflow-y-auto">
                {item.prompt}
              </pre>
              <div className="flex gap-2">
                <button
                  onClick={() => approveTask(item)}
                  className="flex-1 px-3 py-1.5 text-sm rounded bg-green-600/20 text-green-400 hover:bg-green-600/30"
                >
                  批准
                </button>
                <button
                  onClick={() => rejectTask(item)}
                  className="flex-1 px-3 py-1.5 text-sm rounded bg-red-600/20 text-red-400 hover:bg-red-600/30"
                >
                  拒绝
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SubagentCard({
  sub,
  selected,
  onClick,
}: {
  sub: ConductorSubagent
  selected: boolean
  onClick: () => void
}) {
  return (
    <div
      onClick={onClick}
      className={clsx(
        'p-3 rounded-lg border cursor-pointer transition',
        selected
          ? 'border-accent bg-accent/10'
          : 'border-line bg-bg hover:bg-bg-soft hover:border-accent/50'
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <span className="text-xs font-mono text-slate-400">{sub.id}</span>
        <span
          className={clsx(
            'text-xs px-1.5 py-0.5 rounded',
            sub.status === 'running'
              ? 'bg-green-600/20 text-green-400'
              : 'bg-slate-600/20 text-slate-500'
          )}
        >
          {sub.status}
        </span>
      </div>
      <div className="text-xs text-slate-300 line-clamp-2">{sub.prompt}</div>
      <div className="text-xs text-slate-500 mt-2">{relTime(sub.updated_at)}</div>
    </div>
  )
}
