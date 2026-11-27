import { readThemeCompletion, recordThemeCompletion, useUnreadThemeSessionIds } from '@/stores/themeCompletionStore'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '@/api/client'
import type { HubSession, ThemeRun } from '@/api/types'
import { PageShell } from '@/components/PageShell'
import { ModalOverlay } from '@/components/ModalOverlay'
import { MessageContent } from '@/components/MessageContent'
import { QueryLoadState } from '@/components/QueryLoadState'
import { ThemeTaskHistory, ThemeTaskTabs, type ThemeTaskTab } from '@/components/ThemeTaskHistory'
import { queryKeys } from '@/queries/queryKeys'
import { themeReportConclusion } from '@/utils/themeReport'
import { hubEventClient } from '@/runtime/hubEventClient'
import { formatRelativeTime } from '@/utils/timeFormat'
import { writeClipboard } from '@/utils/clipboard'
import { readRecentInstructions, writeRecentInstructions, readRunInstruction, themeFailureReason } from '@/utils/themeTaskActions'
import { extractErrorMessage } from '@/utils/errors'
import { errorMessageFromError, sessionChatHref } from '@/utils/sessionUi'
import { useDirtyClose } from '@/hooks/useDirtyClose'
import { toast } from '@/stores/toastStore'
import {
  CloseIconButton,
  CopyIcon,
  Maximize2,
  Minimize2,
  MoveOutIcon,
  Pencil,
  Play,
  Plus,
  RefreshIcon,
  Settings2,
  Square,
} from '@/components/ActionIcons'

const button = 'ga-btn-sm'
const field = 'w-full rounded-lg border border-line bg-bg-soft p-2 text-sm'
const activeStatuses = ['starting', 'running', 'aborting', 'recovering']
const outcomes: Record<string, string> = { completed: '执行完成', failed: '执行失败', cancelled: '已取消', interrupted: '运行中断，结果未确认', waiting: '等待回复', waiting_user: '等待回复' }
export function elapsed(run: ThemeRun, now: number) {
  const seconds = Math.max(0, Math.floor((run.finished_at ?? (run.interrupted ? run.started_at : now / 1000)) - run.started_at))
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function LiveThemeElapsed({ run, active }: { run: ThemeRun; active: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      setNow(Date.now())
    }
    const timer = window.setInterval(tick, 1000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active])
  return <>{elapsed(run, now)}</>
}

export function ThemeTaskSettings({ session, onClose, onSaved }: { session: HubSession; onClose: () => void; onSaved: () => void }) {
  const config = session.theme_task ?? session.previous_theme_task
  const initialTitle = session.title
  const initialInstruction = config?.instruction ?? ''
  const initialDescription = config?.description ?? ''
  const initialKey = session.llm_key ?? ''
  const [title, setTitle] = useState(initialTitle)
  const [instruction, setInstruction] = useState(initialInstruction)
  const [description, setDescription] = useState(initialDescription)
  const [key, setKey] = useState(initialKey)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const isDirty = title !== initialTitle
    || instruction !== initialInstruction
    || description !== initialDescription
    || key !== initialKey
  const { requestClose } = useDirtyClose({ dirty: isDirty, busy: saving, onClose })
  const llms = useQuery({ queryKey: queryKeys.llms, queryFn: api.llms })
  async function save() {
    setSaving(true); setError('')
    try {
      if (!llms.data?.llms.some(m => m.key === key)) throw new Error('请选择有效的执行模型。')
      if (key !== session.llm_key) await api.updateSessionModel(session.id, key)
      await api.themeConfig(session.id, { instruction: instruction.trim(), description }, title.trim())
      onSaved(); onClose()
    } catch (e) { setError(errorMessageFromError(e)) } finally { setSaving(false) }
  }
  const settingsField = `mt-2 w-full rounded-xl border border-line bg-bg p-2 text-sm focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-50`
  return <ModalOverlay onClose={requestClose} labelledBy={`theme-settings-title-${session.id}`} closeOnBackdrop={false} panelClassName="flex max-h-[90dvh] w-[min(600px,94vw)] flex-col overflow-hidden !rounded-2xl border border-line bg-bg shadow-2xl">
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-line px-5 py-3">
      <div><h2 id={`theme-settings-title-${session.id}`} className="text-base font-semibold">{session.theme_task ? '任务设置' : '转入主题任务'}</h2></div>
      <CloseIconButton label="关闭任务设置" variant="ghost" iconSize={15} disabled={saving} className="h-7 w-7 shrink-0 rounded-full text-ink-faint hover:bg-bg-soft hover:text-accent disabled:opacity-40" onClick={requestClose} />
    </header>
    <div className="min-h-0 overflow-y-auto px-5 pb-4">
      <fieldset disabled={saving} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 text-xs font-medium">任务名称<input className={settingsField} value={title} maxLength={200} onChange={e => setTitle(e.target.value)} /></label>
          <label className="block min-w-0 text-xs font-medium">执行模型<select className={settingsField} value={key} onChange={e => setKey(e.target.value)}>
            <option value="">请选择模型</option>
            {key && !llms.data?.llms.some(m => m.key === key) && <option value={key}>模型已失效，请重新选择</option>}
            {llms.data?.llms.map(m => <option key={m.key} value={m.key}>{m.name}{llms.data.llms.filter(other => other.name === m.name).length > 1 ? ` · ${m.key}` : ''}</option>)}
          </select></label>
        </div>
        {key && llms.data && !llms.data.llms.some(m => m.key === key) && <p className="text-xs text-status-warning">模型已失效，请重新选择。</p>}
        <label className="block text-xs font-medium">默认指令<textarea aria-label="默认执行指令" className={`${settingsField} min-h-48 max-h-[40dvh] resize-y leading-relaxed`} value={instruction} onChange={e => setInstruction(e.target.value)} /></label>
        <details className="text-xs text-ink-faint"><summary className="cursor-pointer hover:text-accent">任务描述{description ? ` · ${description.slice(0, 35)}${description.length > 35 ? '…' : ''}` : '（可选）'}</summary><textarea aria-label="任务描述" className={`${settingsField} min-h-20 resize-y`} value={description} onChange={e => setDescription(e.target.value)} /></details>
      </fieldset>
      <div className="mt-3">
        <QueryLoadState query={llms} label="模型列表" compact showDetail />
      </div>
      {error && <p role="alert" className="mt-4 rounded-xl bg-status-danger/10 p-3 text-sm text-status-danger">{error}</p>}
    </div>
    <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line bg-bg-soft/50 px-5 py-3"><button type="button" className="ga-btn px-4" disabled={saving} onClick={requestClose}>取消</button><button type="button" className="ga-btn-primary px-5" disabled={saving || !instruction.trim() || !title.trim() || !llms.data?.llms.some(m => m.key === key)} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></footer>
  </ModalOverlay>
}

function ThemeCard({ session, onSettings, refresh, expanded, onExpandedChange, autoOpen = false, onAutoOpened, unread = false }: { session: HubSession; onSettings: () => void; refresh: () => void; expanded: boolean; onExpandedChange: (id: string | null) => void; autoOpen?: boolean; onAutoOpened?: () => void; unread?: boolean }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  // Idle cards do not poll. Runtime events/reconnect refresh the snapshots;
  // active cards also reconcile periodically in case a terminal event is lost.
  const runtimeQuery = useQuery({
    queryKey: ['theme-runtime', session.id], queryFn: () => api.sessionRuntime(session.id),
    staleTime: 30000,
    refetchInterval: query => activeStatuses.includes(query.state.data?.status ?? '') ? 5000 : false,
    refetchIntervalInBackground: false,
  })
  const running = activeStatuses.includes(runtimeQuery.data?.status ?? '')
  const runQuery = useQuery({ queryKey: ['theme-run', session.id], queryFn: () => api.themeRun(session.id), staleTime: Infinity, refetchInterval: running ? 5000 : false, refetchIntervalInBackground: false })
  const llms = useQuery({ queryKey: queryKeys.llms, queryFn: api.llms })
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const [error, setError] = useState('')
  const [adjust, setAdjust] = useState(false)
  const [tab, setTab] = useState<ThemeTaskTab>('report')
  const [draft, setDraft] = useState(session.theme_task!.instruction)
  const [editDraft, setEditDraft] = useState<string | null>(null)
  const defaultInstruction = session.theme_task!.instruction
  const previousDefault = useRef(defaultInstruction)
  useEffect(() => {
    const previous = previousDefault.current
    if (previous === defaultInstruction) return
    // Follow settings changes only while the draft still uses the old default.
    setDraft(current => current === previous ? defaultInstruction : current)
    previousDefault.current = defaultInstruction
  }, [defaultInstruction])
  const [saveDefault, setSaveDefault] = useState(false)
  const [recent, setRecent] = useState(() => readRecentInstructions(session.id))
  const [notice, setNotice] = useState('')
  const [retryRunId, setRetryRunId] = useState<string | null>(null)
  const promptModalInitialRef = useRef<{ text: string; saveDefault: boolean }>({ text: '', saveDefault: false })
  const promptModalOpen = editDraft !== null || adjust
  const promptModalDirty = promptModalOpen && (
    (editDraft ?? draft) !== promptModalInitialRef.current.text
    || (adjust && saveDefault !== promptModalInitialRef.current.saveDefault)
  )
  const closePromptModal = () => {
    setEditDraft(null)
    setAdjust(false)
    setRetryRunId(null)
    setSaveDefault(false)
  }
  const { requestClose: requestClosePrompt } = useDirtyClose({
    dirty: promptModalDirty,
    busy: pending,
    onClose: closePromptModal,
  })
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (expanded) cardRef.current?.scrollIntoView?.({ block: 'start', behavior: 'instant' })
  }, [expanded])
  useEffect(() => {
    // Opened from a completion notification: show this task's conclusion.
    if (!autoOpen) return
    onExpandedChange(session.id); setTab('report'); onAutoOpened?.()
  }, [autoOpen, onAutoOpened, onExpandedChange, session.id])
  const runtime = runtimeQuery.data
  const active = activeStatuses.includes(runtime?.status ?? '')
  const expectedRunId = active ? runtime?.run_id : runtime?.completed_run_id
  const snapshot = runQuery.data?.run
  // Never present the previous run's report as the result of a newer run.
  const run = expectedRunId && snapshot?.run_id !== expectedRunId ? undefined : snapshot
  const currentRunId = expectedRunId ?? run?.run_id
  useEffect(() => {
    if (runtime?.status) void client.invalidateQueries({ queryKey: ['theme-run', session.id] })
  }, [client, session.id, runtime?.status, runtime?.run_id, runtime?.completed_run_id])
  const model = llms.data?.llms.find(m => m.key === session.llm_key)
  const uncertain = runQuery.isError || runtimeQuery.isError
  const frozen = Boolean(run?.finished_at || run?.interrupted)
  useEffect(() => {
    recordThemeCompletion(session.id, run)
    const markVisible = () => {
      if (expanded && tab === 'report' && !active && document.visibilityState !== 'hidden') readThemeCompletion(session.id, run)
    }
    markVisible()
    document.addEventListener('visibilitychange', markVisible)
    return () => document.removeEventListener('visibilitychange', markVisible)
  }, [session.id, run, expanded, tab, active])
  const report = themeReportConclusion(run?.report || '')
  const title = session.title
  const status = uncertain ? '状态未知' : active ? '运行中' : pending ? '提交中' : run ? outcomes[run.outcome ?? ''] ?? '执行结束' : '待执行'
  async function execute(text: string, customized = false, persistDefault = false) {
    if (lock.current) return
    lock.current = true; setPending(true); setError(''); setNotice('')
    try {
      if (customized && retryRunId && (run?.run_id !== retryRunId || (runtime?.completed_run_id && runtime.completed_run_id !== retryRunId))) throw new Error('运行状态已变化，请重新取回原指令。')
      if (persistDefault && saveDefault && adjust) { await api.themeConfig(session.id, { ...session.theme_task!, instruction: text }); refresh() }
      await api.startThemeRun(session.id, text)
      if (customized) changeRecent([text, ...readRecentInstructions(session.id)])
      setRetryRunId(null); setAdjust(false); setEditDraft(null); setDraft(text)
      await Promise.all([runtimeQuery.refetch(), runQuery.refetch()])
    } catch (e) { setError(`${errorMessageFromError(e)} 请先核对运行状态，避免重复提交。`); await runtimeQuery.refetch() }
    finally { lock.current = false; setPending(false) }
  }
  async function stop() {
    if (lock.current || runtime?.status === 'aborting') return
    lock.current = true; setPending(true); setError('')
    try { await api.abortSession(session.id); await runtimeQuery.refetch() } catch (e) { setError(errorMessageFromError(e)) } finally { lock.current = false; setPending(false) }
  }
  async function moveBack() {
    if (lock.current) return
    lock.current = true; setPending(true); setError('')
    try { await api.themeConfig(session.id, null); toast.success('已移回实时聊天'); refresh() } catch (e) { setError(errorMessageFromError(e)) } finally { lock.current = false; setPending(false) }
  }
  const dotTone = uncertain ? 'bg-status-warning' : !run ? 'bg-line' : run.interrupted || run.outcome === 'failed' ? 'bg-status-danger' : run.outcome === 'completed' ? 'bg-status-success' : run.outcome === 'cancelled' ? 'bg-ink-faint' : 'bg-status-warning'
  const disabled = active || pending || uncertain || !model || !runtimeQuery.data
  const failed = frozen && run?.outcome === 'failed'
  const failureReason = failed ? (runtime?.completed_run_id === run?.run_id ? runtime?.error : '') || themeFailureReason(run?.report ?? '') : ''
  async function copyReport() {
    try { setError(''); if (!await writeClipboard(report)) throw new Error('请检查剪贴板权限。'); setNotice('结论已复制。') }
    catch (e) { setNotice(''); setError(`复制失败：${errorMessageFromError(e)}`) }
  }
  function changeRecent(values: string[]) {
    try { setRecent(writeRecentInstructions(session.id, values)) }
    catch { setNotice('无法保存本机指令记录，请检查浏览器存储权限。') }
  }
  async function prepareRetry() {
    if (!run || disabled || lock.current) return
    lock.current = true; setPending(true); setError(''); setNotice('')
    try {
      const instruction = await readRunInstruction(session.id, run.run_id)
      promptModalInitialRef.current = { text: instruction, saveDefault: false }
      setEditDraft(instruction); setSaveDefault(false); setRetryRunId(run.run_id); setAdjust(true)
    } catch (e) { setError(errorMessageFromError(e)) }
    finally { lock.current = false; setPending(false) }
  }
  const showUnread = unread && !active
  return <article ref={cardRef} data-unread={showUnread ? 'true' : undefined} className={`ga-paper-card scroll-mt-4 min-w-0 ${expanded ? 'col-span-full overflow-hidden rounded-2xl ring-1 ring-accent/15' : showUnread ? 'border-accent/85 ring-2 ring-accent/55 shadow-[0_6px_18px_rgba(166,91,42,0.16)]' : ''}`} aria-label={`主题任务卡片：${title}`}>
    <div className={expanded ? 'border-b border-line/45' : 'p-4'}>
      <header className={expanded ? 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 px-4 py-2 lg:grid-cols-[188px_minmax(0,1fr)_auto] lg:gap-x-4' : 'flex items-start justify-between gap-3'}>
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-sm font-semibold" title={title}>{title}</h2>
          {showUnread && !expanded && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-status-danger-line bg-status-danger-soft px-2 py-0.5 text-[11px] font-semibold text-status-danger">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-danger animate-pulse" />
              <span>新完成</span>
            </span>
          )}
        </div>
        {expanded && <div className="order-3 col-span-2 min-w-0 pt-1 lg:order-none lg:col-span-1 lg:pt-0"><ThemeTaskTabs tab={tab} onChange={setTab} /></div>}
        <div className="flex shrink-0 items-center gap-2">{!expanded && <button type="button" aria-label={`${active ? '停止' : '运行'}主题任务：${title}`} title={active ? runtime?.status === 'aborting' ? '正在停止' : '停止任务' : retryRunId ? '请展开并确认重试' : '按本次提示词运行'} disabled={active ? pending || uncertain || runtime?.status === 'aborting' : disabled || !draft.trim() || Boolean(retryRunId)} className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${active ? 'bg-status-danger/10 text-status-danger hover:bg-status-danger/20 disabled:cursor-not-allowed disabled:opacity-45' : 'ga-solid-primary'}`} onClick={() => void (active ? stop() : execute(draft.trim(), true))}>
          {active ? <Square className="h-3 w-3 fill-current" aria-hidden="true" /> : <Play className="h-3 w-3 fill-current" aria-hidden="true" />}
        </button>}{expanded && tab === 'report' && <button type="button" aria-label="复制结论" title="复制结论" disabled={!frozen || !report} className="ga-btn-icon-sm h-7 w-7 shrink-0 rounded-full border-line/65" onClick={() => void copyReport()}><CopyIcon size={14} /></button>}<button type="button" className="ga-btn-icon-sm h-7 w-7 shrink-0 rounded-full border-line/65" aria-label={expanded ? '收起任务卡片' : `打开主题任务：${title}`} title={expanded ? '收起详情' : '展开详情'} aria-expanded={expanded} aria-controls={`theme-detail-${session.id}`} onClick={() => onExpandedChange(expanded ? null : session.id)}>
            {expanded ? <Minimize2 className="h-3.5 w-3.5" aria-hidden="true" /> : <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />}
          </button></div>
      </header>
      {!expanded && <div className="mt-2 truncate text-xs text-ink-faint">执行模型：{model?.name ?? (session.llm_key ? '需重新关联模型' : '未设置模型')}</div>}
      {!expanded && <>
        <div className="ga-paper-subcard relative mt-3 flex min-h-16 items-center p-2.5 pr-10">
          <p aria-label={`本次启动提示词：${title}`} className={`min-w-0 flex-1 whitespace-pre-wrap break-words text-sm line-clamp-3 ${draft.trim() ? '' : 'text-ink-faint'}`} title={draft}>{draft || '尚未填写提示词'}</p>
          <button type="button" aria-label={`编辑本次提示词：${title}`} title="编辑提示词" disabled={pending || active} className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-6 w-6 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { promptModalInitialRef.current = { text: draft, saveDefault: false }; setEditDraft(draft) }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2 text-xs"><span role="status" aria-label={active && !uncertain ? runtime?.status === 'aborting' ? '正在停止' : '运行中' : status} className="flex items-center gap-1.5 text-ink-faint">{active && !uncertain ? <span aria-hidden="true" className="h-3.5 w-3.5 rounded-full border-2 border-accent border-t-transparent motion-safe:animate-spin" /> : <><span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotTone}`} />{status}</>}</span>{run && <span className="tabular-nums text-ink-faint">{active ? <LiveThemeElapsed run={run} active={active} /> : formatRelativeTime(run.finished_at ?? run.started_at)} · {run.turns} turn</span>}</div>
      </>}
      {!expanded && notice && <p role="status" className="mt-3 text-xs text-ink-faint">{notice}</p>}
      {!expanded && error && <p role="alert" className="mt-3 text-sm text-status-danger">{error}</p>}
    </div>
    {promptModalOpen && <ModalOverlay onClose={requestClosePrompt} labelledBy={`theme-prompt-title-${session.id}`} closeOnBackdrop={false} panelClassName="w-[min(520px,94vw)] max-h-[90dvh] overflow-y-auto border border-line bg-bg p-5 shadow-2xl">
      <h3 id={`theme-prompt-title-${session.id}`} className="mb-3 text-sm font-semibold">本次提示词</h3>
      <textarea aria-label={adjust ? "本次执行指令" : "编辑本次启动提示词"} autoFocus disabled={pending} className={`${field} min-h-36 max-h-[45dvh] resize-y`} value={editDraft ?? draft} onChange={e => setEditDraft(e.target.value)} />
      {retryRunId && <p className="mt-2 text-xs text-status-warning">已恢复原指令，确认后将重新执行。</p>}
      <section aria-label="最近指令" className="mt-3 text-xs">
        <div className="flex items-center justify-between gap-2 text-ink-faint"><h4 className="font-medium">最近指令</h4>{!!recent.length && <button type="button" disabled={pending} className="transition-colors hover:text-accent disabled:opacity-40" onClick={() => changeRecent([])}>清空记录</button>}</div>
        {recent.length ? <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">{recent.map((text, index) => <div key={text} className="flex items-center gap-1 rounded-lg bg-bg-soft"><button type="button" className="min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent/10 disabled:opacity-40" title={text} disabled={pending} onClick={() => { setEditDraft(text); setRetryRunId(null) }}><span className="line-clamp-2 whitespace-pre-wrap break-words">{text}</span></button><CloseIconButton label={`删除最近指令${index + 1}`} title={null} variant="compact" iconSize={12} disabled={pending} className="mr-1 h-6 w-6 shrink-0 rounded-full text-ink-faint hover:bg-accent/10 hover:text-accent disabled:opacity-40" onClick={() => changeRecent(recent.filter((_, i) => i !== index))} /></div>)}</div> : <p className="mt-2 text-ink-faint">暂无最近指令</p>}
      </section>
      {adjust && <label className="mt-3 flex items-center gap-2 text-xs text-ink-faint"><input type="checkbox" checked={saveDefault} disabled={pending} onChange={e => setSaveDefault(e.target.checked)} />保存为默认指令</label>}
      {error && <p role="alert" className="mt-2 text-xs text-status-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><button type="button" className="ga-btn" disabled={pending} onClick={requestClosePrompt}>取消</button>
        {!retryRunId && <button type="button" className="ga-btn" disabled={pending} onClick={() => { setDraft((editDraft ?? draft).trim()); setEditDraft(null); setAdjust(false) }}>保存</button>}
        {adjust && <button type="button" className="ga-btn-primary" disabled={disabled || !(editDraft ?? draft).trim()} onClick={() => void execute((editDraft ?? draft).trim(), true, true)}>{retryRunId ? '确认重试' : '确认执行'}</button>}
      </div>
    </ModalOverlay>}

    {expanded && <section id={`theme-detail-${session.id}`} className="grid min-w-0 lg:grid-cols-[220px_minmax(0,1fr)]" aria-label={`主题任务详情：${title}`}>
      <aside className="min-w-0 border-b border-line/45 bg-bg-soft/35 px-4 py-5 lg:border-b-0 lg:border-r">
        <div role="group" aria-label="任务操作" className="flex items-center gap-2"><button type="button" aria-label={`${active ? '停止' : '运行'}主题任务：${title}`} title={active ? runtime?.status === 'aborting' ? '正在停止' : '停止任务' : retryRunId ? '请展开并确认重试' : '按本次提示词运行'} disabled={active ? pending || uncertain || runtime?.status === 'aborting' : disabled || !draft.trim() || Boolean(retryRunId)} className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${active ? 'bg-status-danger/10 text-status-danger hover:bg-status-danger/20 disabled:cursor-not-allowed disabled:opacity-45' : 'ga-solid-primary'}`} onClick={() => void (active ? stop() : execute(draft.trim(), true))}>
          {active ? <Square className="h-3 w-3 fill-current" aria-hidden="true" /> : <Play className="h-3 w-3 fill-current" aria-hidden="true" />}
        </button><button type="button" aria-label={`任务设置：${title}`} title="任务设置" disabled={pending || active} className="ga-btn-icon-sm h-7 w-7 rounded-full border-line/65" onClick={onSettings}><Settings2 className="h-3.5 w-3.5" aria-hidden="true" /></button><button type="button" aria-label={`移回聊天：${title}`} title="移回聊天" disabled={active || pending} className="ga-btn-icon-sm h-7 w-7 shrink-0 rounded-full border-line/65" onClick={() => void moveBack()}><MoveOutIcon size={14} /></button></div>
        <div className="mt-5 space-y-3.5" aria-label="执行概况">
          <p className="flex items-start gap-2 text-sm font-medium leading-6">{active ? <span aria-hidden="true" className="mt-1.5 h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent/20 border-t-accent motion-reduce:animate-none" /> : <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${dotTone}`} />}<span>{status}</span></p>
          <dl className="grid grid-cols-2 gap-2.5">
            <div className="ga-paper-subcard px-2.5 py-2"><dt className="text-[11px] text-ink-faint">{active ? '已运行' : '运行用时'}</dt><dd aria-label="已运行" className="mt-1 text-base font-semibold tabular-nums tracking-tight text-ink">{run ? <LiveThemeElapsed run={run} active={active} /> : '—'}</dd></div>
            <div className="ga-paper-subcard px-2.5 py-2"><dt className="text-[11px] text-ink-faint">执行轮次</dt><dd aria-label="执行轮次" className="mt-1 text-base font-semibold tabular-nums tracking-tight text-ink">{run?.turns ?? '—'}<span className="ml-1 text-xs font-normal text-ink-faint">turn</span></dd></div>
          </dl>
          {run && <p title="最近运行时间" className="text-xs leading-5 text-ink-faint">{new Date(run.started_at * 1000).toLocaleString()}</p>}
        </div>
        <hr className="ga-hairline my-4" />
        <dl className="mb-4 space-y-3">
          <div><dt className="text-xs text-ink-faint">执行模型</dt><dd className="mt-1 break-words text-sm leading-6 [overflow-wrap:anywhere]" title={frozen && run?.model_name && run.model_name !== model?.name ? `本次：${run.model_name}；下次：${model?.name ?? '未设置'}` : model?.name}>{(frozen && run?.model_name) || model?.name || '未设置模型'}</dd></div>
          {session.project_name && <div><dt className="text-xs text-ink-faint">所属项目</dt><dd className="mt-1 break-words text-sm leading-6 [overflow-wrap:anywhere]">{session.project_name}</dd></div>}
        </dl>
        <div className="ga-paper-subcard p-3">
          <p aria-label={`本次启动提示词：${title}`} className={`line-clamp-6 whitespace-pre-wrap break-words text-sm leading-6 ${draft.trim() ? '' : 'text-ink-faint'}`} title={draft}>{draft || '尚未填写提示词'}</p>
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-line/35 pt-2">
            <button type="button" className="ga-btn-link" disabled={pending || active} title="调整提示词并立即运行" onClick={() => { promptModalInitialRef.current = { text: draft, saveDefault: false }; setSaveDefault(false); setAdjust(true) }}>本次调整</button>
            <button type="button" aria-label={`编辑本次提示词：${title}`} title="编辑提示词" disabled={pending || active} className="flex h-6 w-6 items-center justify-center rounded-full text-ink-faint transition-colors hover:bg-accent/10 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent" onClick={() => { promptModalInitialRef.current = { text: draft, saveDefault: false }; setEditDraft(draft) }}><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
          </div>
        </div>
        {!model && <p className="mt-3 text-xs leading-5 text-status-warning">请点击上方「任务设置」重新选择模型，或在「LLM管理」中检查配置。</p>}
      </aside>
      <div className="min-w-0 p-4 sm:px-5">
        {(failed || (frozen && run?.interrupted)) && <section className="rounded-2xl border border-status-danger/25 bg-status-danger/5 p-4 text-sm"><p className="font-medium text-status-danger">{failed ? '本次执行失败' : '上次执行中断，结果未确认'}</p><p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs text-ink-faint">{failureReason || '未记录具体失败原因，请在本次过程或会话历史中核对。'}</p>{failureReason && <details className="mt-2 text-xs"><summary>完整错误</summary><pre className="whitespace-pre-wrap break-words">{failureReason}</pre></details>}<button type="button" className={`${button} mt-2`} disabled={disabled} onClick={() => void prepareRetry()}>取回原指令重试</button></section>}

        {notice && <p role="status" className="mb-3 text-xs text-ink-faint">{notice}</p>}
        {error && <p role="alert" className="mb-3 text-sm text-status-danger">{error}</p>}
        <ThemeTaskHistory sessionId={session.id} runId={currentRunId} active={active} selectedTab={tab} onTabChange={setTab}>
          {run && frozen ? <section>
            <div className="max-h-[min(68dvh,800px)] overflow-y-auto overscroll-contain pr-2 text-sm leading-relaxed">{report ? <MessageContent content={report} format="markdown" markdownMode="chat" /> : <p className="py-8 text-center text-ink-faint">暂无最终结论</p>}</div>
          </section> : <p className="py-16 text-center text-sm text-ink-faint">{active ? '任务执行中，完成后显示结论' : '运行任务后在这里查看结论'}</p>}

        </ThemeTaskHistory>
      </div>
    </section>}
  </article>
}

export default function ThemeTasks() {
  const client = useQueryClient()
  const sessionsQuery = useQuery({ queryKey: queryKeys.sessions, queryFn: api.sessions, refetchInterval: 10000 })
  const sessions = sessionsQuery.data?.items ?? []
  const [setting, setSetting] = useState<HubSession | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [search, setSearch] = useState('')
  const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.sessions }) }
  const tasks = sessions.filter(s => s.theme_task)
  const unreadSessionIds = useUnreadThemeSessionIds()
  const unreadCount = tasks.filter(s => unreadSessionIds.has(s.id)).length
  // Keep keys/instances stable so promoting a card never resets its draft.
  const orderedTasks = [
    ...tasks.filter(s => s.id === expandedId),
    ...tasks.filter(s => s.id !== expandedId && unreadSessionIds.has(s.id)),
    ...tasks.filter(s => s.id !== expandedId && !unreadSessionIds.has(s.id)),
  ]
  const llms = useQuery({ queryKey: queryKeys.llms, queryFn: api.llms })
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
  return <PageShell
    title="主题任务"
    titleExtra={
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium" aria-label="主题任务概览">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-line/65 bg-bg-soft/90 px-2.5 py-0.5 tabular-nums text-ink-muted">
          <span>主题 {tasks.length} 项</span>
        </span>
        {unreadCount > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-status-danger-line bg-status-danger-soft px-2.5 py-0.5 tabular-nums text-status-danger">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-status-danger animate-pulse" />
            <span>待查看 {unreadCount} 项</span>
          </span>
        )}
      </div>
    }
    actions={<button type="button" className="ga-btn-sm-primary" onClick={() => setPicking(true)}><Plus className="h-3.5 w-3.5" aria-hidden="true" /><span>从会话转入</span></button>}
  >
    <div className="ga-page-board">
      {!sessionsQuery.data && (sessionsQuery.isLoading || sessionsQuery.isError) ? (
        <QueryLoadState query={sessionsQuery} label="主题任务" showDetail />
      ) : (
        <>
          {sessionsQuery.isError && (
            <div role="alert" className="flex items-center justify-between gap-2 rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-xs text-status-danger">
              <span>主题任务刷新失败：{extractErrorMessage(sessionsQuery.error)}</span>
              <button
                type="button"
                className="ga-btn-xs shrink-0"
                disabled={sessionsQuery.isFetching}
                onClick={() => void sessionsQuery.refetch()}
              >
                {sessionsQuery.isFetching ? '重试中…' : '重试'}
              </button>
            </div>
          )}
          {!sessionsQuery.isError && tasks.length === 0 ? (
            <div className="ga-paper-card border-dashed bg-bg-card/55 p-8 text-center">
              <p className="mb-4 text-sm text-ink-faint">暂无主题任务</p>
              <button type="button" className={button} onClick={() => setPicking(true)}>选择已有会话</button>
            </div>
          ) : tasks.length > 0 ? (
            <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
              {orderedTasks.map(s => <ThemeCard key={s.id} expanded={expandedId === s.id} onExpandedChange={setExpandedId} session={s} unread={unreadSessionIds.has(s.id)} onSettings={() => setSetting(s)} refresh={refresh} autoOpen={openId === s.id} onAutoOpened={clearOpen} />)}
            </div>
          ) : null}
        </>
      )}
    </div>
    {picking && (
      <ModalOverlay onClose={() => { setPicking(false); setSearch('') }} labelledBy="theme-pick-title" panelClassName="w-[min(560px,94vw)] rounded-2xl border border-line bg-bg p-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="theme-pick-title" className="font-semibold">选择已有会话</h2>
          <CloseIconButton label="关闭选择会话" variant="ghost" iconSize={15} onClick={() => { setPicking(false); setSearch('') }} className="h-7 w-7 text-ink-muted hover:bg-bg-soft hover:text-ink" />
        </div>
        <input aria-label="搜索会话" className={field} placeholder="搜索名称或项目" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="mt-3 max-h-96 space-y-2 overflow-auto">
          {pickable.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">
              {search.trim() ? '没有匹配的会话' : '暂无可转入的普通会话'}
            </p>
          ) : (
            pickable.map(s => (
              <button key={s.id} type="button" className="block w-full rounded-lg border border-line p-3 text-left hover:bg-bg-soft" onClick={() => { setPicking(false); setSearch(''); setSetting(s) }}>
                <div className="text-sm">{s.title || '未命名会话'}</div>
                <div className="mt-1 text-xs text-ink-faint">{s.project_name || '自由会话'} · {modelName(s.llm_key)}</div>
              </button>
            ))
          )}
        </div>
      </ModalOverlay>
    )}
    {setting && <ThemeTaskSettings key={setting.id} session={setting} onClose={() => setSetting(null)} onSaved={refresh} />}
  </PageShell>
}
