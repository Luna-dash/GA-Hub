import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '@/api/client'
import type { HubSession, ThemeRun } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { ModalOverlay } from '@/components/ModalOverlay'
import { MessageContent } from '@/components/MessageContent'
import { queryKeys } from '@/queries/queryKeys'
import { readThemeReportExpanded, writeThemeReportExpanded } from '@/config/storageKeys'
import { themeReportConclusion } from '@/utils/themeReport'
import { hubEventClient } from '@/runtime/hubEventClient'
import { formatRelativeTime } from '@/utils/timeFormat'
import { errorMessageFromError, sessionChatHref } from '@/utils/sessionUi'

const button = 'rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-bg-soft disabled:opacity-40'
const field = 'w-full rounded-lg border border-border bg-bg-soft p-2 text-sm'
const activeStatuses = ['starting', 'running', 'aborting', 'recovering']
const outcomes: Record<string, string> = { completed: '执行完成', failed: '执行失败', cancelled: '已取消', interrupted: '运行中断，结果未确认', waiting: '等待回复', waiting_user: '等待回复' }
export function elapsed(run: ThemeRun, now: number) {
  const seconds = Math.max(0, Math.floor((run.finished_at ?? (run.interrupted ? run.started_at : now / 1000)) - run.started_at))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

export function ThemeTaskSettings({ session, onClose, onSaved }: { session: HubSession; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(session.title)
  const [instruction, setInstruction] = useState(session.theme_task?.instruction ?? '')
  const [description, setDescription] = useState(session.theme_task?.description ?? '')
  const [key, setKey] = useState(session.llm_key ?? '')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const llms = useQuery({ queryKey: ['theme-llms'], queryFn: api.llms })
  async function save() {
    setSaving(true); setError('')
    try {
      if (!llms.data?.llms.some(m => m.key === key)) throw new Error('请选择有效的执行模型。')
      if (key !== session.llm_key) await api.updateSessionModel(session.id, key)
      await api.themeConfig(session.id, { instruction: instruction.trim(), description }, title.trim())
      onSaved(); onClose()
    } catch (e) { setError(errorMessageFromError(e)) } finally { setSaving(false) }
  }
  return <ModalOverlay onClose={() => { if (!saving) onClose() }} panelClassName="w-[min(560px,94vw)] rounded-2xl border border-border bg-bg p-6 shadow-xl">
    <h2 className="mb-5 text-lg font-semibold">{session.theme_task ? '任务设置' : '转入主题任务'}</h2>
    <div className="space-y-4">
      <label className="block text-sm">任务名称<input className={`${field} mt-1`} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label>
      <label className="block text-sm">默认执行指令<textarea className={`${field} mt-1 min-h-28`} value={instruction} maxLength={20000} onChange={e => setInstruction(e.target.value)} placeholder="例如：检查今天的签到状态，完成后汇总结果。" /></label>
      <label className="block text-sm">说明（可选）<input className={`${field} mt-1`} value={description} maxLength={1000} onChange={e => setDescription(e.target.value)} /></label>
      <label className="block text-sm">执行模型<select className={`${field} mt-1`} value={key} onChange={e => setKey(e.target.value)}>
        <option value="">请选择模型</option>
        {key && !llms.data?.llms.some(m => m.key === key) && <option value={key}>原绑定已失效：{key}（请重新选择）</option>}
        {llms.data?.llms.map(m => <option key={m.key} value={m.key}>{m.name} · {m.key}</option>)}
      </select></label>
      {!session.theme_task && <p className="text-xs text-slate-500">保留原会话上下文与项目绑定。</p>}
      {key && llms.data && !llms.data.llms.some(m => m.key === key) && <p className="text-xs text-status-warning">原绑定的模型已失效。模型按配置键保存，配置键改名后需重新关联，不会自动换用其他模型。</p>}
      {llms.isError && <p role="alert" className="text-sm text-status-danger">模型列表加载失败，请稍后重试。</p>}
      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
      <div className="flex justify-end gap-2"><button className={button} disabled={saving} onClick={onClose}>取消</button><button className={`${button} bg-accent text-white`} disabled={saving || !instruction.trim() || !title.trim() || !llms.data?.llms.some(m => m.key === key)} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div>
    </div>
  </ModalOverlay>
}

function ThemeCard({ session, onSettings, refresh, autoOpen = false, onAutoOpened }: { session: HubSession; onSettings: () => void; refresh: () => void; autoOpen?: boolean; onAutoOpened?: () => void }) {
  const navigate = useNavigate()
  // Idle cards make no requests: the page invalidates these keys on
  // session:runtime events and after the event socket reconnects. Only a
  // running card polls themeRun, because turn counts are not pushed.
  const runtimeQuery = useQuery({ queryKey: ['theme-runtime', session.id], queryFn: () => api.sessionRuntime(session.id), staleTime: Infinity })
  const running = activeStatuses.includes(runtimeQuery.data?.status ?? '')
  const runQuery = useQuery({ queryKey: ['theme-run', session.id], queryFn: () => api.themeRun(session.id), staleTime: Infinity, refetchInterval: running ? 5000 : false, refetchIntervalInBackground: false })
  const llms = useQuery({ queryKey: ['theme-llms'], queryFn: api.llms })
  const [now, setNow] = useState(Date.now())
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [adjust, setAdjust] = useState(false)
  const [draft, setDraft] = useState(session.theme_task!.instruction)
  const [saveDefault, setSaveDefault] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [openReport, setOpenReport] = useState(() => readThemeReportExpanded(session.id))
  useEffect(() => {
    // Opened from a completion notification: show this task's conclusion.
    if (!autoOpen) return
    setExpanded(true); setOpenReport(true); onAutoOpened?.()
  }, [autoOpen, onAutoOpened])
  const run = runQuery.data?.run
  const runtime = runtimeQuery.data
  const active = activeStatuses.includes(runtime?.status ?? '')
  const model = llms.data?.llms.find(m => m.key === session.llm_key)
  const uncertain = runQuery.isError || runtimeQuery.isError
  const frozen = Boolean(run?.finished_at || run?.interrupted)
  const report = themeReportConclusion(run?.report || '')
  const title = session.title
  const status = uncertain ? '状态未知' : active ? '运行中' : pending ? '提交中' : run ? outcomes[run.outcome ?? ''] ?? '执行结束' : '待执行'
  useEffect(() => { if (!active) return; const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [active])
  async function execute(text: string) {
    if (lock.current) return
    lock.current = true; setPending(true); setError('')
    try {
      if (saveDefault && adjust) { await api.themeConfig(session.id, { ...session.theme_task!, instruction: text }); refresh() }
      await api.startThemeRun(session.id, text)
      setAdjust(false)
      await Promise.all([runtimeQuery.refetch(), runQuery.refetch()])
    } catch (e) { setError(`${errorMessageFromError(e)} 请先核对运行状态，避免重复提交。`); await runtimeQuery.refetch() }
    finally { lock.current = false; setPending(false) }
  }
  async function stop() {
    setPending(true); setError('')
    try { await api.abortSession(session.id); await runtimeQuery.refetch() } catch (e) { setError(errorMessageFromError(e)) } finally { setPending(false) }
  }
  async function moveBack() {
    setPending(true); setError('')
    try { await api.themeConfig(session.id, null); refresh() } catch (e) { setError(errorMessageFromError(e)) } finally { setPending(false) }
  }
  const dotTone = uncertain ? 'bg-status-warning' : !run ? 'bg-border' : run.interrupted || run.outcome === 'failed' ? 'bg-status-danger' : run.outcome === 'completed' ? 'bg-status-success' : run.outcome === 'cancelled' ? 'bg-slate-400' : 'bg-status-warning'
  const disabled = active || pending || uncertain || !model || !runtimeQuery.data
  return <>
    <div className="group relative">
    <button type="button" className="flex min-h-32 w-full flex-col rounded-xl border border-border bg-bg p-4 text-left shadow-sm transition-colors hover:border-accent/50 hover:bg-bg-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" aria-label={`打开主题任务：${title}`} onClick={() => setExpanded(true)}>
      <span className="flex w-full items-start justify-between gap-3"><span className="line-clamp-2 text-sm font-semibold">{title}</span><span aria-hidden className={`mt-1 h-3 w-3 shrink-0 rounded-full ${active ? 'border-2 border-accent border-t-transparent motion-safe:animate-spin' : dotTone}`} /></span>
      <span className="mt-2 truncate text-xs text-slate-500">{model?.name ?? (session.llm_key ? '需重新关联模型' : '未设置模型')}</span>
      <span className="mt-4 flex w-full items-center justify-between gap-2 text-xs"><span className={active ? 'text-accent' : 'text-slate-500'}>{status}</span>{run && <span className="tabular-nums text-slate-500">{active ? elapsed(run, now) : formatRelativeTime(run.finished_at ?? run.started_at)} · {run.turns} turn</span>}</span>
    </button>
    {!active && <button type="button" aria-label={`运行主题任务：${title}`} disabled={disabled} className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-accent px-3 py-1.5 text-xs text-white shadow-sm opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent group-hover:opacity-100 group-focus-within:opacity-100 disabled:hidden [@media(hover:none)]:opacity-100" onClick={() => void execute(session.theme_task!.instruction)}>▶ 运行</button>}
    </div>
    {expanded && <ModalOverlay onClose={() => setExpanded(false)} align="right" panelClassName="fixed inset-0 flex h-[100dvh] w-screen flex-col bg-bg">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4"><h2 className="truncate font-semibold">{title}</h2><button className={button} onClick={() => setExpanded(false)} aria-label="收起任务卡片">收起</button></header>
      <article className="min-h-0 flex-1 overflow-y-auto" aria-label={`主题任务：${title}`}><div className="mx-auto max-w-5xl p-5 sm:p-8">
    <header className="flex items-start justify-between gap-3"><div><p className="text-xs text-slate-500">执行模型：{model?.name ?? (session.llm_key ? `${session.llm_key} · 需重新关联` : '未设置')}</p>{session.project_name && <p className="mt-1 text-xs text-slate-500">项目：{session.project_name}</p>}</div><button className={button} disabled={pending || active} onClick={() => { setExpanded(false); onSettings() }}>设置</button></header>
    <p className="my-4 line-clamp-2 text-sm text-slate-500">{session.theme_task!.description || session.theme_task!.instruction}</p>
    <div className="mb-4 flex items-center gap-3 rounded-xl bg-bg-soft p-3" role="status" aria-live="polite">
      <span aria-hidden className={`h-5 w-5 shrink-0 rounded-full border-2 ${active ? 'border-accent border-t-transparent motion-safe:animate-spin' : 'border-border'}`} />
      <div className="min-w-0 flex-1"><div className="text-sm">{uncertain ? '连接异常，正在重新确认' : pending ? '正在提交…' : active ? runtime?.status === 'aborting' ? '正在停止' : runtime?.status === 'starting' ? '准备执行' : '正在执行' : run ? outcomes[run.outcome ?? ''] ?? '执行结束，请核对报告' : '待执行'}</div>
        {run && <div className="mt-1 text-xs tabular-nums text-slate-500">{run.interrupted ? '计时未确认' : elapsed(run, now)} · {run.turns} turn{frozen && run.model_name ? ` · 本次模型：${run.model_name}` : ''}</div>}
      </div>
    </div>
    {!model && <p className="mb-3 text-xs text-status-warning">执行模型未确认，请打开设置重新选择。</p>}
    <div className="flex flex-wrap gap-2">{active ? <button className={button} disabled={pending || runtime?.status === 'aborting'} onClick={() => void stop()}>停止执行</button> : <button className={`${button} bg-accent text-white`} disabled={disabled} onClick={() => void execute(session.theme_task!.instruction)}>立即运行</button>}
      <button className={button} disabled={active || pending} onClick={() => { setDraft(session.theme_task!.instruction); setSaveDefault(false); setAdjust(!adjust) }}>本次调整</button>
      <button className={button} onClick={() => navigate(sessionChatHref(session.id))}>过程与历史 ↗</button>
      <button className={`${button} ml-auto text-slate-500`} disabled={active || pending} onClick={() => void moveBack()}>移回聊天</button>
    </div>
    {adjust && <div className="mt-4 space-y-2"><textarea aria-label="本次执行指令" className={`${field} min-h-24`} value={draft} onChange={e => setDraft(e.target.value)} /><label className="flex gap-2 text-xs"><input type="checkbox" checked={saveDefault} onChange={e => setSaveDefault(e.target.checked)} />同时保存为默认指令</label><button className={button} disabled={disabled || !draft.trim()} onClick={() => void execute(draft.trim())}>按本次指令运行</button></div>}
    {error && <p role="alert" className="mt-3 text-sm text-status-danger">{error}</p>}
    {run && frozen && <section className="mt-5 border-t border-border pt-3"><button className="flex w-full items-center justify-between text-sm font-medium" aria-expanded={openReport} onClick={() => { const next = !openReport; setOpenReport(next); writeThemeReportExpanded(session.id, next) }}><span>最终结论 <span className="ml-2 text-xs font-normal text-slate-500">{new Date(run.started_at * 1000).toLocaleString()}</span></span><span>{openReport ? '收起 −' : '展开 +'}</span></button>{openReport && <div className="mt-3 rounded-lg bg-bg-soft p-4 text-sm">{report ? <MessageContent content={report} format="markdown" markdownMode="chat" /> : <p className="text-slate-500">暂无最终结论</p>}</div>}</section>}
    </div></article></ModalOverlay>}
  </>
}

export default function ThemeTasks() {
  const client = useQueryClient()
  const sessionsQuery = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions, refetchInterval: 10000 })
  const sessions = sessionsQuery.data?.items ?? []
  const [setting, setSetting] = useState<HubSession | null>(null)
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')
  const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.sessions }) }
  const tasks = sessions.filter(s => s.theme_task)
  const llms = useQuery({ queryKey: ['theme-llms'], queryFn: api.llms })
  const modelName = (key?: string | null) => key ? llms.data?.llms.find(m => m.key === key)?.name ?? key : '未绑定模型'
  const pickable = sessions
    .filter(s => !s.theme_task && `${s.title} ${s.project_name ?? ''}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0))
  const [params, setParams] = useSearchParams()
  const openId = params.get('open')
  const clearOpen = useCallback(() => setParams(p => { const next = new URLSearchParams(p); next.delete('open'); return next }, { replace: true }), [setParams])
  useEffect(() => {
    const isThemeKey = (key: readonly unknown[]) => key[0] === 'theme-run' || key[0] === 'theme-runtime'
    const offRuntime = hubEventClient.subscribe('session:runtime', (event) => {
      if (event.topic !== 'session:runtime') return
      const id = (event.payload as { session_id?: unknown }).session_id
      if (typeof id !== 'string') return
      void client.invalidateQueries({ predicate: q => isThemeKey(q.queryKey) && q.queryKey[1] === id })
    })
    // Events missed while disconnected are recovered by one full refresh.
    let wasOpen: boolean | undefined
    const offState = hubEventClient.subscribeState((state) => {
      const open = state === 'open'
      if (open && wasOpen === false) void client.invalidateQueries({ predicate: q => isThemeKey(q.queryKey) })
      wasOpen = open
    })
    return () => { offRuntime(); offState() }
  }, [client])
  return <PageShell title="主题任务" actions={<button className={`${button} bg-accent text-white`} onClick={() => setPicking(true)}>＋ 从会话转入</button>}>
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      {sessionsQuery.isError && <p role="alert" className="text-status-danger">加载失败。<button className={button} onClick={() => void sessionsQuery.refetch()}>重试</button></p>}
      {sessionsQuery.isLoading ? <p>正在加载…</p> : tasks.length === 0 ? <div className="rounded-xl border border-dashed border-border p-8 text-center"><p className="mb-4 text-sm text-slate-500">暂无主题任务</p><button className={button} onClick={() => setPicking(true)}>选择已有会话</button></div> : <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{tasks.map(s => <ThemeCard key={s.id} session={s} onSettings={() => setSetting(s)} refresh={refresh} autoOpen={openId === s.id} onAutoOpened={clearOpen} />)}</div>}
    </div>
    {picking && <ModalOverlay onClose={() => setPicking(false)} panelClassName="w-[min(560px,94vw)] rounded-2xl border border-border bg-bg p-6"><div className="mb-4 flex justify-between"><h2 className="font-semibold">选择已有会话</h2><button onClick={() => setPicking(false)}>关闭</button></div><input aria-label="搜索会话" className={field} placeholder="搜索名称或项目" value={search} onChange={e => setSearch(e.target.value)} /><div className="mt-3 max-h-96 space-y-2 overflow-auto">{pickable.map(s => <button key={s.id} className="block w-full rounded-lg border border-border p-3 text-left hover:bg-bg-soft" onClick={() => { setPicking(false); setSetting(s) }}><div className="text-sm">{s.title || '未命名会话'}</div><div className="mt-1 text-xs text-slate-500">{s.project_name || '自由会话'} · {modelName(s.llm_key)}</div></button>)}</div></ModalOverlay>}
    {setting && <ThemeTaskSettings key={setting.id} session={setting} onClose={() => setSetting(null)} onSaved={refresh} />}
  </PageShell>
}
