import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TransferredFile } from '@/components/FileTransferBox'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'
import { Brain, ClipboardList, Pencil, ShieldAlert, Slash } from 'lucide-react'
import { CloseIconButton, RotateCw } from '@/components/ActionIcons'
import { ChatComposerFrame, ChatUtilityDock, chatTranscriptClass } from '@/components/ChatLayout'
import { bubbleTone } from '@/components/bubbleTone'
import { ImagePasteInput } from '@/components/ImagePasteInput'
import { AntiDaemonControl, useAntiDaemonStatus } from '@/components/AntiDaemonControl'
import { AntiAgyProfiles, useAgyProfiles } from '@/components/AntiAgyProfiles'
import { AntiAccountUsageButton } from '@/components/AntiAccountUsageButton'
import { AntiIcon } from '@/components/AntiMark'
import { MessageContent } from '@/components/MessageContent'
import { FileLinkContext, FileTransferConclusion } from '@/components/FileCitation'
import { UserAttachments } from '@/components/MessageBubble'
import { ReplyActions } from '@/components/ReplyActions'
import { MainModelSelect } from '@/components/ModelSelect'
import { PageShell } from '@/components/PageShell'
import { ProjectSelect } from '@/components/ProjectSelect'
import { SessionRail } from '@/components/SessionRail'
import { ModalOverlay } from '@/components/ModalOverlay'
import type { HubSession, PasteAttachment, SessionRuntime } from '@/api/types'
import { usePageState } from '@/utils/pageState'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import { ThemedSelect } from '@/components/ThemedSelect'
import {
  antiApi, api, HttpError,
  type AntiApprovalPrompt, type AntiAttachmentRef, type AntiMode,
  type AntiModels, type AntiPermissionMode, type AntiRun,
  type AntiSession, type AntiSubmission,
} from '@/api/client'

type Session = AntiSession
type Run = AntiRun
const active = (run: Run) => ['submitting', 'queued', 'running', 'unknown'].includes(run.status)
const sessionsKey = ['anti-sessions'] as const
const DEFAULT_FAMILY = 'gemini-4-hydrogen'
const DEFAULT_MODEL = { id: `${DEFAULT_FAMILY}-high`, display_name: 'Gemini 4 Hydrogen (High)' }
const DEFAULT_EFFORT = 'high'
const efforts = [
  { key: 'low', name: 'low' }, { key: 'medium', name: 'medium' }, { key: 'high', name: 'high' },
  { key: 'xhigh', name: 'xhigh' }, { key: 'max', name: 'max' },
]
type Models = AntiModels

function modelFamilies(items: Models['items']) {
  const families = new Map<string, { key: string; name: string; variants: Partial<Record<string, string>>; plain?: string }>()
  for (const { id, display_name } of items) {
    const variant = id.match(/^(.+)-(low|medium|high|xhigh|max)$/i)
    const key = variant?.[1] ?? id
    const level = variant?.[2].toLowerCase()
    const label = level ? display_name.replace(/\s*\((low|medium|high|xhigh|max)\)\s*$/i, '') : display_name
    const family = families.get(key) ?? { key, name: label && label !== id ? label : key, variants: {} }
    if (level) family.variants[level] = id
    else family.plain = id
    families.set(key, family)
  }
  return [...families.values()]
}
type Submission = AntiSubmission

const permissionLabels: Record<AntiPermissionMode, string> = {
  'approval-required': '逐次审批',
  'auto-accept-edits': '自动改文件',
  auto: 'Auto',
  'full-access': '全放行',
}

function formatRunUsage(usage?: Run['usage']): string | null {
  if (!usage) return null
  const totalIn = usage.input_tokens ?? 0
  const totalOut = usage.output_tokens ?? 0
  const cached = usage.cache_read_tokens ?? 0
  const thinking = usage.thinking_tokens ?? 0
  if (!totalIn && !totalOut && !thinking) return null
  const parts = [`${totalIn.toLocaleString('en-US')} in`, `${totalOut.toLocaleString('en-US')} out`]
  if (thinking > 0) parts.push(`${thinking.toLocaleString('en-US')} think`)
  if (totalIn > 0 && cached > 0) parts.push(`缓存 ${Math.round((cached / totalIn) * 100)}%`)
  return parts.join(' · ')
}

function Errors({ items }: { items: (Error | null)[] }) {
  return <>{items.filter(Boolean).map((error, index) =>
    <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-sm text-status-danger [overflow-wrap:anywhere]" key={index}>{error?.message}</p>)}</>
}

function toUserAttachments(runId: string, list?: AntiAttachmentRef[]): PasteAttachment[] {
  if (!list?.length) return []
  return list.map((item, index) => ({
    file_id: `${runId}-att-${index}`,
    name: item.name || item.path.split(/[/\\]/).pop() || 'attachment',
    path: item.path,
    url: item.source === 'managed_upload' ? api.fileUrlByPath(item.path) : '',
    mime: '',
    size: item.size ?? 0,
    source: item.source,
  }))
}

export default function AntiChat() {
  const cache = useQueryClient()
  const [project, setProject] = useState<string | null>(null)
  const [sid, setSid] = usePageState('antiChat.currentSession', '')
  const [creating, setCreating] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null)
  const daemon = useAntiDaemonStatus()
  const profiles = useAgyProfiles()
  const projects = useQuery({ queryKey: ['anti-projects'], queryFn: api.projects })
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: ({ signal }) => antiApi.sessions(signal), refetchInterval: 5000 })
  const updateList = async (update: (rows: Session[]) => Session[]) => {
    await cache.cancelQueries({ queryKey: sessionsKey, exact: true })
    cache.setQueryData<Session[]>(sessionsKey, old => update(old ?? []))
    void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
  }
  const create = useMutation({
    mutationFn: (projectName: string) => antiApi.createSession(projectName),
    onSuccess: async session => {
      await updateList(rows => [session, ...rows.filter(row => row.id !== session.id)])
      setSid(session.id)
      setCreating(false)
    },
  })
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      antiApi.renameSession(id, title),
    onSuccess: session => updateList(rows => rows.map(row => row.id === session.id ? { ...row, ...session } : row)),
  })
  const remove = useMutation({
    mutationFn: (id: string) => antiApi.deleteSession(id),
    onSuccess: async (_, id) => {
      await updateList(rows => rows.filter(row => row.id !== id))
      setSid(current => current === id ? '' : current)
      cache.removeQueries({ queryKey: ['anti-runs', id] })
    },
  })
  const selected = sessions.data?.find(row => row.id === sid) ?? sessions.data?.[0]
  const available = projects.data?.items.filter(item => !item.dangling) ?? []
  const selectedProject = available.find(item => item.name === project)
  const railSessions: HubSession[] = (sessions.data ?? []).map(row => ({
    id: row.id, title: row.title, project_name: row.project, project_path: row.workspace,
    created_at: '', updated_at: row.updated_at ?? '', llm_index: null, archive_path: null,
  }))
  const railRuntimes: Record<string, SessionRuntime> = Object.fromEntries((sessions.data ?? []).map(row => [row.id, {
    session_id: row.id, status: row.active_run_id ? 'running' : 'idle', run_id: row.active_run_id ?? null, stream_id: null,
  }]))
  const openCreate = () => {
    create.reset()
    setProject(available.some(item => item.name === selected?.project) ? selected?.project ?? null : null)
    setCreating(true)
  }
  const closeCreate = () => { if (!create.isPending) setCreating(false) }
  const selectedProfile = profiles.data?.profiles.find(item => item.id === profiles.data?.active)
  const cachedUsage = selectedProfile?.usage
  return <PageShell title="Agy 会话" wrapHeader
    titleExtra={<AntiDaemonControl {...daemon} />}
    actions={<>
      <div ref={setHeaderActions} className="empty:hidden flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2" />
      <AntiAgyProfiles
        profiles={profiles}
        refresh={daemon.refresh}
        daemon={daemon}
        open={profilesOpen}
        onOpenChange={setProfilesOpen}
      />
      <AntiAccountUsageButton
        key={profiles.data?.active}
        running={daemon.running}
        cachedUsage={cachedUsage}
        onChecked={() => {
          daemon.refresh()
          void cache.invalidateQueries({ queryKey: ['agy-profiles'], exact: true })
        }}
      />
    </>}>
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
      <SessionRail storageScope="anti" projects={projects.data?.items} sessions={railSessions}
        runtimes={railRuntimes} currentId={selected?.id ?? null} onSelect={setSid} onCreate={openCreate}
        onRename={(id, title) => rename.mutateAsync({ id, title }).then(() => undefined)}
        onDelete={id => remove.mutateAsync(id)}
        deleteDetail="将删除此会话及消息记录，不删除本地项目文件。" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {daemon.state === 'stopped' && !daemon.busy && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-bg-soft px-4 py-2 text-xs text-ink-muted">
            <span>Agy ACP 运行时当前已停止，需要启用后才能发送消息或检测额度。</span>
            <button type="button" className="ga-btn-primary shrink-0" onClick={() => daemon.start.mutate()}>
              启用 Agy
            </button>
          </div>
        )}
        {daemon.state === 'unavailable' && !daemon.busy && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-status-danger-line bg-status-danger-soft px-4 py-2 text-xs text-status-danger">
            <span>{daemon.status.data?.detail || daemon.status.error?.message || 'Agy ACP 运行时当前不可用，请检查官方 agy CLI 安装。'}</span>
            <div className="flex shrink-0 items-center gap-1.5">
              {daemon.managed && (
                <button type="button" className="ga-btn shrink-0" onClick={() => daemon.restart.mutate()}>
                  重置运行时
                </button>
              )}
              <button type="button" className="ga-btn shrink-0" onClick={() => setProfilesOpen(true)}>
                诊断 / 账号设置
              </button>
            </div>
          </div>
        )}
        {daemon.running && daemon.status.data?.agy_available === false && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-status-danger-line bg-status-danger-soft px-4 py-2 text-xs text-status-danger">
            <span>未找到官方 agy CLI。请安装 agy 并确保位于 PATH（或 ~/.gemini/bin）后重试。</span>
            <button type="button" className="ga-btn shrink-0" onClick={() => setProfilesOpen(true)}>
              查看运行详情
            </button>
          </div>
        )}
        {daemon.running && daemon.status.data?.agy_available && daemon.status.data?.auth_state === 'login_required' && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning-line bg-status-warning-soft px-4 py-2 text-xs text-status-warning">
            <span>当前 Agy 账号尚未登录或凭据已过期，请先完成官方登录后再发起对话。</span>
            <button type="button" className="ga-btn shrink-0" onClick={() => setProfilesOpen(true)}>
              去登录账号
            </button>
          </div>
        )}
        <Errors items={[sessions.error, rename.error, remove.error]} />
        {selected ? <Conversation key={selected.id} session={selected} headerActions={headerActions}
          profileId={profiles.data?.active} profileName={selectedProfile?.name} /> :
          <div className="relative flex flex-1">
            <ChatUtilityDock fileTransfer={{ canInsert: false, onInsert: () => { } }} />
            <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-5 text-center text-sm text-ink-muted">
              <AntiIcon className="h-11 w-11 text-accent" />
              <p>{sessions.isPending ? '正在加载 Anti 会话…' : '点击「新建会话」，选择该会话的项目。'}</p>
            </div>
          </div>}
      </div>
    </div>
    {creating && <ModalOverlay onClose={closeCreate} labelledBy="anti-create-session-title" panelClassName="w-[28rem] max-w-[92vw] p-5">
      <form className="space-y-4" onSubmit={event => {
        event.preventDefault()
        if (selectedProject && !create.isPending) create.mutate(selectedProject.name)
      }}>
        <h2 id="anti-create-session-title" className="text-base font-semibold text-ink">新建会话</h2>
        <p className="text-sm text-ink-muted">为这次 Anti 会话选择项目。创建后，会话会归入该项目。</p>
        <ProjectSelect standalone aria-label="项目目录" placeholder="选择项目目录" value={project ?? ''} onChange={setProject}
          options={available.map(item => ({ key: item.name, name: item.display_name ?? item.name }))} />
        {selectedProject && <p className="break-all text-xs text-ink-muted">{selectedProject.path}</p>}
        {!projects.isPending && !projects.error && !available.length && <p className="text-sm text-ink-muted">暂无可用项目，请先在项目页添加一个项目。</p>}
        <Errors items={[projects.error, create.error]} />
        <div className="flex justify-end gap-2">
          <button type="button" className="ga-btn" onClick={closeCreate} disabled={create.isPending}>取消</button>
          <button type="submit" className="ga-btn-primary" disabled={!selectedProject || create.isPending}>{create.isPending ? '创建中…' : '创建会话'}</button>
        </div>
      </form>
    </ModalOverlay>}
  </PageShell>
}

function Conversation({ session, headerActions, profileId, profileName }: {
  session: Session; headerActions: HTMLDivElement | null; profileId?: string; profileName?: string
}) {
  const { id: sid, project, workspace } = session
  const cache = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<PasteAttachment[]>([])
  const [references, setReferences] = useState<TransferredFile[]>([])
  const [pending, setPending] = useState<Submission>()
  const [familyKey, setFamilyKey] = usePageState('antiChat.modelFamily', DEFAULT_FAMILY)
  const [preferredEffort, setEffort] = usePageState('antiChat.effort', DEFAULT_EFFORT)
  const [mode, setMode] = usePageState<AntiMode>('antiChat.mode', 'plan')
  const [permissionMode, setPermissionMode] = usePageState<AntiPermissionMode>('antiChat.permissionMode', 'approval-required')
  const [commandsOpen, setCommandsOpen] = useState(false)
  const transcript = useRef<HTMLDivElement>(null)
  const followTranscript = useRef(true)
  const models = useQuery({
    queryKey: ['anti-models', profileId],
    enabled: Boolean(profileId),
    queryFn: ({ signal }) => antiApi.models(signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const families = modelFamilies(models.data?.items ?? [DEFAULT_MODEL])
  const family = families.find(item => item.key === familyKey) ?? families[0]
  const effortOptions = efforts.filter(option => family?.plain || family?.variants[option.key])
  const effort = effortOptions.find(option => option.key === preferredEffort)?.key
    ?? effortOptions.find(option => option.key === DEFAULT_EFFORT)?.key ?? effortOptions[0]?.key ?? DEFAULT_EFFORT
  const model = family?.variants[effort] ?? family?.plain ?? DEFAULT_MODEL.id
  const key = ['anti-runs', sid]
  const history = useQuery({
    queryKey: key, queryFn: ({ signal }) => antiApi.runs(sid, signal),
    refetchInterval: query => query.state.data?.some(active) || pending ? 1500 : false
  })
  const current = history.data?.find(active)
  const live = useQuery({
    queryKey: ['anti-live', sid, current?.id], enabled: Boolean(current), refetchInterval: 900,
    queryFn: async ({ signal }) => {
      const run = await antiApi.run(sid, current!.id, signal)
      if (!active(run)) {
        cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
        void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
      }
      return run
    },
  })
  useEffect(() => {
    if (pending && history.data?.some(run => run.operation === pending.operation)) {
      setPending(undefined)
      setPrompt('')
      setAttachments([])
      setReferences([])
    }
  }, [history.data, pending])
  const send = useMutation({
    mutationFn: (body: Submission) => antiApi.submitRun(sid, body),
    onSuccess: run => {
      cache.setQueryData<Run[]>(key, old => [...(old ?? []).filter(row => row.id !== run.id), run])
      setPrompt(''); setPending(undefined); setAttachments([]); setReferences([])
    },
    onError: error => {
      if (error instanceof HttpError && (error.status === 422 || error.status === 429 || error.status === 409 || error.status === 503)) {
        setPending(undefined)
      }
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: sessionsKey })
    },
  })
  const cancel = useMutation({
    mutationFn: (rid: string) => antiApi.cancelRun(sid, rid),
    onSuccess: run => {
      cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
    },
  })
  const approve = useMutation({
    mutationFn: ({ rid, approval_id, decision, option_id }: {
      rid: string; approval_id: string; decision: 'allow' | 'allow_always' | 'reject'; option_id?: string
    }) => antiApi.approveRun(sid, rid, { approval_id, decision, ...(option_id ? { option_id } : {}) }),
    onSuccess: run => {
      cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
      void cache.invalidateQueries({ queryKey: ['anti-live', sid, run.id] })
    },
  })
  const resetAcp = useMutation({
    mutationFn: () => antiApi.resetSession(sid),
    onSuccess: updated => {
      cache.setQueryData<Session[]>(sessionsKey, old => old?.map(row => row.id === updated.id ? { ...row, ...updated } : row))
    },
  })
  const showSlashMenu = commandsOpen || /^\/\S*$/.test(prompt.trim())
  const commands = useQuery({
    queryKey: ['anti-commands', profileId],
    enabled: showSlashMenu,
    queryFn: ({ signal }) => antiApi.commands(signal),
    staleTime: 60_000,
    retry: false,
  })
  const scrollToLatest = useCallback(() => {
    if (transcript.current && followTranscript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [])
  useEffect(scrollToLatest, [history.data, scrollToLatest])
  const submit = () => {
    const trimmedPrompt = prompt.trim()
    if (current || send.isPending || !history.isSuccess || (!trimmedPrompt && !attachments.length && !references.length)) return
    const body = pending ?? {
      prompt: trimmedPrompt, model, effort, mode, permission_mode: permissionMode,
      ...(references.length ? { references: references.map(({ id, path }) => ({ id, path })) } : {}),
      ...(attachments.length ? {
        attachments: attachments.map(({ path, name, source, size }) => ({
          path,
          name,
          source: source ?? 'managed_upload',
          ...(size != null ? { size } : {}),
        })),
      } : {}),
      operation: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    followTranscript.current = true
    setPending(body)
    send.mutate(body)
  }
  return <>
    {headerActions && createPortal(<>
      <MainModelSelect aria-label="模型" className="min-w-0 max-w-[min(400px,24vw)]" title={models.error ? '模型列表加载失败' : '模型'}
        llms={families} value={family?.key} onChange={setFamilyKey} disabled={Boolean(current || pending) || models.isPending} />
      <ThemedSelect aria-label="思考等级" title="思考等级" options={effortOptions} value={effort} onChange={setEffort}
        displayName={option => option.name} placeholder={DEFAULT_EFFORT}
        renderMark={() => <span className="model-select-mark"><Brain size={16} aria-hidden="true" /></span>}
        disabled={Boolean(current || pending)} />
      {(session.acp_connected || session.has_conversation) && (
        <button
          type="button"
          className="ga-btn-sm shrink-0"
          disabled={Boolean(current || pending) || resetAcp.isPending}
          aria-label="重连 ACP 会话"
          title="重启本会话 ACP 进程并保留多轮上下文"
          onClick={() => resetAcp.mutate()}
        >
          {resetAcp.isPending ? '重连中…' : '重连 ACP'}
        </button>
      )}
      {models.error && <button type="button" className="ga-btn-icon" title="重试加载模型" aria-label="重试加载模型" onClick={() => void models.refetch()}><RotateCw size={16} aria-hidden="true" /></button>}
    </>, headerActions)}
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatUtilityDock fileTransfer={{
        canInsert: !current && !pending && !send.isPending && references.length < 8,
        onInsert: file => setReferences(old => old.some(item => item.path === file.path) ? old : [...old, file]),
      }} />
      <div ref={transcript} onScroll={event => {
        const el = event.currentTarget
        followTranscript.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }} className={chatTranscriptClass} data-anti-chat-scroll>
        {!history.data?.length && !history.error && <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
          <AntiIcon className="h-11 w-11 text-accent" />
          {history.isPending ? '正在加载会话…' : '想让 Anti 为这个项目做什么？'}
        </div>}
        <div className="space-y-5">
          {history.data?.map(run => {
            const userAttachments = toUserAttachments(run.id, run.attachments)
            const liveRun = current?.id === run.id ? live.data : undefined
            const approval: AntiApprovalPrompt | null | undefined = liveRun?.approval ?? run.approval
            return <article className="space-y-3" key={run.id}>
              <div className="flex flex-col items-start gap-2">
                {userAttachments.length > 0 && <UserAttachments atts={userAttachments} />}
                {run.prompt && (
                  <div className={`w-fit max-w-full rounded-lg px-3.5 py-3 text-sm ${bubbleTone('user').surfaceClass}`}>
                    <MessageContent format="text" content={run.prompt} />
                  </div>
                )}
              </div>
              <div className={`group/anti-reply w-fit min-w-0 max-w-full space-y-2 rounded-lg px-3.5 py-3 text-sm ${bubbleTone('assistant').surfaceClass}`}>
                {run.status !== 'success' && <p role="status" className="text-xs text-ink-muted">
                  {run.status}{run.error ? ` · ${run.error}` : ''}
                  {run.error_detail && <span className="mt-1 block text-sm text-ink">{run.error_detail}</span>}
                </p>}
                <FileLinkContext.Provider value={{ sessionId: sid, projectPath: workspace, project, engine: 'anti' }}>
                  <FileTransferConclusion.Provider value={run.status === 'success' ? { engine: 'anti', project } : null}>
                    <AntiTaskProgress active={active(run)} loadEvents={signal => antiApi.runEvents<AntiEvent[]>(sid, run.id, signal)}
                      streamUrl={active(run) ? resolveApiUrl(`/api/anti/sessions/${sid}/runs/${run.id}/events/stream`) : undefined}
                      runKey={`${sid}/${run.id}`} onEventsChanged={scrollToLatest}
                      onApprovalRequested={() => { void cache.invalidateQueries({ queryKey: ['anti-live', sid, run.id] }) }}>
                      {partial => <MessageContent format="markdown" content={run.answer ?? partial} />}
                    </AntiTaskProgress>
                    {active(run) && approval && (
                      <section aria-label="交互审批" className="mt-2 space-y-2 rounded-lg border border-accent/40 bg-bg-soft p-3 text-xs">
                        <div className="flex items-start gap-2">
                          <ShieldAlert size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="font-semibold text-ink">{approval.title}</div>
                            {approval.details && <div className="break-all font-mono text-[11px] text-ink-muted">{approval.details}</div>}
                            {approval.diff && (
                              <pre className="max-h-40 overflow-auto rounded bg-bg-card p-2 font-mono text-[11px] text-ink whitespace-pre-wrap break-all">
                                {approval.diff}
                              </pre>
                            )}
                            {approval.security_warning && (
                              <p className="text-[11px] text-status-warning">{approval.security_warning}</p>
                            )}
                          </div>
                        </div>
                        {approval.prompt_type === 'question' && approval.question?.options?.length ? (
                          <div className="flex flex-wrap gap-1.5">
                            {approval.question.options.map(opt => (
                              <button
                                key={opt.id}
                                type="button"
                                className="ga-btn-sm-primary"
                                disabled={approve.isPending}
                                onClick={() => approve.mutate({ rid: run.id, approval_id: approval.id, decision: 'allow', option_id: opt.id })}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            <button
                              type="button"
                              className="ga-btn-sm-primary"
                              disabled={approve.isPending}
                              onClick={() => approve.mutate({ rid: run.id, approval_id: approval.id, decision: 'allow' })}
                            >
                              允许一次
                            </button>
                            {approval.allow_always && (
                              <button
                                type="button"
                                className="ga-btn-sm"
                                disabled={approve.isPending}
                                onClick={() => approve.mutate({ rid: run.id, approval_id: approval.id, decision: 'allow_always' })}
                              >
                                本会话始终允许
                              </button>
                            )}
                            <button
                              type="button"
                              className="ga-btn-sm-danger"
                              disabled={approve.isPending}
                              onClick={() => approve.mutate({ rid: run.id, approval_id: approval.id, decision: 'reject' })}
                            >
                              拒绝
                            </button>
                          </div>
                        )}
                      </section>
                    )}
                    {run.status === 'success' && (
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px] text-ink-muted">
                        <div className="flex flex-wrap items-center gap-2 tabular-nums">
                          <span>{run.mode === 'accept-edits' ? `Edit · ${permissionLabels[run.permission_mode] ?? run.permission_mode}` : 'Plan'}</span>
                          {formatRunUsage(run.usage) && <span>· {formatRunUsage(run.usage)}</span>}
                        </div>
                        {run.answer?.trim() && (
                          <div className="pointer-events-none flex flex-wrap justify-end gap-2 opacity-0 transition-opacity group-hover/anti-reply:pointer-events-auto group-hover/anti-reply:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                            <ReplyActions text={run.answer} engine="anti" project={project} canSave />
                          </div>
                        )}
                      </div>
                    )}
                  </FileTransferConclusion.Provider>
                </FileLinkContext.Provider>
              </div>
            </article>
          })}
          <Errors items={[history.error, live.error, send.error, cancel.error, approve.error, resetAcp.error]} />
        </div>
      </div>
    </div>
    <ChatComposerFrame>
      {profileId && profileId !== 'default' && (
        <div className="border-b border-line/50 px-3 py-1 text-[11px] text-ink-muted">
          当前隔离账号：{profileName ?? profileId}（多轮上下文按账号独立续接）
        </div>
      )}
      {references.length > 0 && <ul aria-label="引用文件" className="flex flex-wrap gap-1 pl-[3.25rem] pr-3 pt-2 text-xs">
        {references.map(file => <li key={file.path} className="flex min-w-0 items-center gap-1 rounded-md bg-bg-soft px-2 py-1" title={file.path}>
          <span className="truncate">{file.name}</span>
          <CloseIconButton
            label={`移除引用 ${file.name}`}
            variant="compact"
            iconSize={12}
            disabled={Boolean(pending) || Boolean(current)}
            className="text-ink-muted hover:text-accent disabled:opacity-40"
            onClick={() => setReferences(old => old.filter(item => item.path !== file.path))}
          />
        </li>)}
      </ul>}
      {showSlashMenu && commands.data?.items?.length ? (
        <div role="listbox" aria-label="Agy 原生命令" className="flex flex-wrap gap-1.5 border-b border-line/60 bg-bg-soft/70 px-3 py-2 text-xs">
          {commands.data.items.map(cmd => (
            <button
              key={cmd.name}
              type="button"
              role="option"
              aria-selected={false}
              className="inline-flex items-center gap-1 rounded-lg border border-line bg-bg-card px-2 py-1 text-left hover:border-accent/60"
              onClick={() => {
                setPrompt(`/${cmd.name} `)
                setCommandsOpen(false)
              }}
            >
              <span className="font-mono font-semibold text-accent">/{cmd.name}</span>
              {cmd.description && <span className="text-ink-muted">{cmd.description}</span>}
            </button>
          ))}
        </div>
      ) : null}
      <ImagePasteInput
        text={prompt}
        onText={setPrompt}
        attachments={attachments}
        onAttachments={setAttachments}
        inputLabel="发给 Anti"
        placeholder="发给 Anti，输入 / 查看原生命令，可粘贴/拖放图片或文件…"
        readOnly={Boolean(pending)}
        maxLength={24000}
        onSubmit={submit}
        submitDisabled={Boolean(current) || send.isPending || !history.isSuccess}
        submitAccessory={
          <div className="mb-0.5 flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={Boolean(current || pending)}
              aria-label="插入原生命令"
              title="查看并插入 Agy ACP 原生命令"
              onClick={() => setCommandsOpen(v => !v)}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-line/80 bg-bg-soft text-ink-muted hover:border-accent/50 hover:text-ink disabled:opacity-50"
            >
              <Slash size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={Boolean(current || pending)}
              aria-label={mode === 'plan' ? '当前为规划模式，点击切换到编辑模式' : '当前为编辑模式，点击切换到规划模式'}
              title={mode === 'plan' ? 'Plan 规划模式（只读分析，点击切到 Edit）' : 'Edit 编辑模式（可执行修改，点击切到 Plan）'}
              onClick={() => setMode(mode === 'plan' ? 'accept-edits' : 'plan')}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-line/80 bg-bg-soft px-2.5 text-xs font-medium leading-none text-ink hover:border-accent/50 disabled:opacity-50"
            >
              {mode === 'plan'
                ? <><ClipboardList size={14} className="shrink-0" aria-hidden="true" /><span>Plan</span></>
                : <><Pencil size={14} className="shrink-0 text-accent" aria-hidden="true" /><span>Edit</span></>}
            </button>
            {mode === 'accept-edits' && (
              <select
                aria-label="权限策略"
                title="工具审批策略（下轮立即生效）"
                value={permissionMode}
                disabled={Boolean(current || pending)}
                onChange={e => setPermissionMode(e.target.value as AntiPermissionMode)}
                className="h-10 rounded-xl border border-line/80 bg-bg-soft px-2 text-xs text-ink focus:border-accent focus:outline-none disabled:opacity-50"
              >
                <option value="approval-required">逐次审批</option>
                <option value="auto-accept-edits">自动改文件</option>
                <option value="auto">Auto</option>
                <option value="full-access">全放行</option>
              </select>
            )}
          </div>
        }
        submitLabel={pending && send.isError ? '查询或重试同一请求' : '发送'}
        stopActive={Boolean(current)}
        stopDisabled={cancel.isPending}
        onStop={() => { if (current) cancel.mutate(current.id) }}
      />
    </ChatComposerFrame>
  </>
}
