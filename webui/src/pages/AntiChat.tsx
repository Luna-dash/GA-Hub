import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileTransferBox, type TransferredFile } from '@/components/FileTransferBox'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'
import { Brain, FolderOpen, RotateCw } from 'lucide-react'
import { ChatComposerFrame, chatTranscriptClass } from '@/components/ChatLayout'
import { ImagePasteInput } from '@/components/ImagePasteInput'
import { AntiDaemonControl } from '@/components/AntiDaemonControl'
import { AntiIcon } from '@/components/AntiMark'
import { MessageContent } from '@/components/MessageContent'
import { FileLinkContext, FileTransferConclusion } from '@/components/FileCitation'
import { ReplyActions } from '@/components/ReplyActions'
import { MainModelSelect } from '@/components/ModelSelect'
import { PageShell } from '@/components/PageShell'
import { ProjectSelect } from '@/components/ProjectSelect'
import { SessionRail } from '@/components/SessionRail'
import { ModalOverlay } from '@/components/ModalOverlay'
import type { HubSession, SessionRuntime } from '@/api/types'
import { usePageState } from '@/utils/pageState'
import { ThemedSelect } from '@/components/ThemedSelect'
import { api } from '@/api/client'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Session = { id: string; project: string; title: string; workspace: string; updated_at?: string | null; active_run_id?: string | null }
type Run = { id: string; status: string; operation: string; prompt: string; answer: string | null; error: string | null; error_detail?: string | null }
const active = (run: Run) => ['submitting', 'queued', 'running', 'unknown'].includes(run.status)
const base = '/api/anti/sessions'
const sessionsKey = ['anti-sessions'] as const
const DEFAULT_FAMILY = 'gemini-4-hydrogen'
const DEFAULT_MODEL = { id: `${DEFAULT_FAMILY}-high`, display_name: 'Gemini 4 Hydrogen (High)' }
const DEFAULT_EFFORT = 'high'
const efforts = [
  { key: 'low', name: '低' }, { key: 'medium', name: '中' }, { key: 'high', name: '高' },
  { key: 'xhigh', name: '极高' }, { key: 'max', name: '最高' },
]
type Models = { items: { id: string; display_name: string }[] }

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
type Submission = { prompt: string; operation: string; model: string; effort: string; references?: Pick<TransferredFile, 'id' | 'path'>[] }

function Errors({ items }: { items: (Error | null)[] }) {
  return <>{items.filter(Boolean).map((error, index) =>
    <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-sm text-status-danger [overflow-wrap:anywhere]" key={index}>{error?.message}</p>)}</>
}

class AntiRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

async function request<T>(path: string, signal?: AbortSignal, body?: object, method = body ? 'POST' : 'GET'): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    signal, method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const error = await res.json().catch(() => null)
    throw new AntiRequestError(res.status, typeof error?.detail === 'string' ? error.detail : `Anti 请求失败 (${res.status})`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

const EMPTY_ATTACHMENTS: [] = []

export default function AntiChat() {
  const cache = useQueryClient()
  const [project, setProject] = useState<string | null>(null)
  const [sid, setSid] = usePageState('antiChat.currentSession', '')
  const [creating, setCreating] = useState(false)
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null)
  const projects = useQuery({ queryKey: ['anti-projects'], queryFn: api.projects })
  const sessions = useQuery({ queryKey: sessionsKey, queryFn: ({ signal }) => request<Session[]>(base, signal), refetchInterval: 5000 })
  const updateList = async (update: (rows: Session[]) => Session[]) => {
    await cache.cancelQueries({ queryKey: sessionsKey, exact: true })
    cache.setQueryData<Session[]>(sessionsKey, old => update(old ?? []))
    void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
  }
  const create = useMutation({
    mutationFn: (projectName: string) => request<Session>(base, undefined, { project: projectName }),
    onSuccess: async session => {
      await updateList(rows => [session, ...rows.filter(row => row.id !== session.id)])
      setSid(session.id)
      setCreating(false)
    },
  })
  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      request<Session>(`${base}/${id}`, undefined, { title }, 'PATCH'),
    onSuccess: session => updateList(rows => rows.map(row => row.id === session.id ? { ...row, ...session } : row)),
  })
  const remove = useMutation({
    mutationFn: (id: string) => request<void>(`${base}/${id}`, undefined, undefined, 'DELETE'),
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
  const workspace = selected?.workspace
  return <PageShell title="Anti会话" wrapHeader
    titleExtra={<span className="ga-badge"><AntiIcon className="mr-1 inline h-4 w-4" />Plan</span>}
    actions={<><AntiDaemonControl /><div ref={setHeaderActions} className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
      {!selected && <FileTransferBox canInsert={false} onInsert={() => {}} />}
    </div></>}
    middleArea={workspace && <div title={workspace} className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
      <FolderOpen size={15} className="shrink-0" aria-hidden="true" /><span className="truncate">{workspace}</span>
    </div>}>
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
      <SessionRail storageScope="anti" projects={projects.data?.items} sessions={railSessions}
        runtimes={railRuntimes} currentId={selected?.id ?? null} onSelect={setSid} onCreate={openCreate}
        onRename={(id, title) => rename.mutateAsync({ id, title }).then(() => undefined)}
        onDelete={id => remove.mutateAsync(id)}
        deleteDetail="将删除 Hub 中的 Anti 会话及其消息记录，不会删除项目文件或已保存的产物。" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Errors items={[sessions.error, rename.error, remove.error]} />
        {selected ? <Conversation key={selected.id} session={selected} headerActions={headerActions} /> :
          <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-5 text-center text-sm text-ink-muted">
            <AntiIcon className="h-11 w-11 text-accent" />
            <p>{sessions.isPending ? '正在加载 Anti 会话…' : '点击「新建会话」，选择该会话的项目。'}</p>
            <p>以 Plan 模式运行。</p>
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
          <button type="button" className="ga-btn ga-btn--quiet" onClick={closeCreate} disabled={create.isPending}>取消</button>
          <button type="submit" className="ga-btn ga-btn--primary" disabled={!selectedProject || create.isPending}>{create.isPending ? '创建中…' : '创建会话'}</button>
        </div>
      </form>
    </ModalOverlay>}
  </PageShell>
}

function Conversation({ session, headerActions }: { session: Session; headerActions: HTMLDivElement | null }) {
  const { id: sid, project, workspace } = session
  const cache = useQueryClient()
  const [prompt, setPrompt] = useState('')
  const [references, setReferences] = useState<TransferredFile[]>([])
  const [pending, setPending] = useState<Submission>()
  const [familyKey, setFamilyKey] = useState(DEFAULT_FAMILY)
  const [preferredEffort, setEffort] = useState(DEFAULT_EFFORT)
  const transcript = useRef<HTMLDivElement>(null)
  const followTranscript = useRef(true)
  const models = useQuery({ queryKey: ['anti-models'], queryFn: ({ signal }) => request<Models>('/api/anti/models', signal),
    staleTime: 5 * 60 * 1000, retry: false })
  const families = modelFamilies(models.data?.items ?? [DEFAULT_MODEL])
  const family = families.find(item => item.key === familyKey) ?? families[0]
  const effortOptions = efforts.filter(option => family?.plain || family?.variants[option.key])
  const effort = effortOptions.find(option => option.key === preferredEffort)?.key
    ?? effortOptions.find(option => option.key === DEFAULT_EFFORT)?.key ?? effortOptions[0]?.key ?? DEFAULT_EFFORT
  const model = family?.variants[effort] ?? family?.plain ?? DEFAULT_MODEL.id
  const path = `${base}/${sid}/runs`
  const key = ['anti-runs', sid]
  const history = useQuery({ queryKey: key, queryFn: ({ signal }) => request<Run[]>(path, signal),
    refetchInterval: query => query.state.data?.some(active) || pending ? 1500 : false })
  const current = history.data?.find(active)
  const live = useQuery({
    queryKey: ['anti-live', sid, current?.id], enabled: Boolean(current), refetchInterval: 900,
    queryFn: async ({ signal }) => {
      const run = await request<Run>(`${path}/${current!.id}`, signal)
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
      setReferences([])
    }
  }, [history.data, pending])
  const send = useMutation({
    mutationFn: (body: Submission) => request<Run>(path, undefined, body),
    onSuccess: run => {
      cache.setQueryData<Run[]>(key, old => [...(old ?? []).filter(row => row.id !== run.id), run])
      setPrompt(''); setPending(undefined); setReferences([])
    },
    onError: error => {
      if (error instanceof AntiRequestError && error.status === 422) setPending(undefined)
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: sessionsKey })
    },
  })
  const cancel = useMutation({
    mutationFn: (rid: string) => request<Run>(`${path}/${rid}/cancel`, undefined, {}),
    onSuccess: run => {
      cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
    },
  })
  const scrollToLatest = useCallback(() => {
    if (transcript.current && followTranscript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [])
  useEffect(scrollToLatest, [history.data, scrollToLatest])
  const submit = () => {
    if (current || send.isPending || !history.isSuccess || !prompt.trim()) return
    const body = pending ?? { prompt: prompt.trim(), model, effort,
      ...(references.length ? { references: references.map(({ id, path }) => ({ id, path })) } : {}),
      operation: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }
    followTranscript.current = true
    setPending(body)
    send.mutate(body)
  }
  return <>
    {headerActions && createPortal(<>
      <MainModelSelect aria-label="模型" className="min-w-0 max-w-[min(400px,24vw)]" title={models.error ? '暂时无法读取模型列表，可继续使用默认模型' : '模型'}
        llms={families} value={family?.key} onChange={setFamilyKey} disabled={Boolean(current || pending) || models.isPending} />
      <ThemedSelect aria-label="思考等级" options={effortOptions} value={effort} onChange={setEffort}
        displayName={option => `思考：${option.name}`} placeholder="思考：高"
        renderMark={() => <span className="model-select-mark"><Brain size={16} aria-hidden="true" /></span>}
        disabled={Boolean(current || pending)} />
      {models.error && <button type="button" className="ga-btn-icon" title="重试加载模型" aria-label="重试加载模型" onClick={() => void models.refetch()}><RotateCw size={16} aria-hidden="true" /></button>}
      <FileTransferBox canInsert={!current && !pending && !send.isPending && references.length < 8}
        onInsert={file => setReferences(old => old.some(item => item.path === file.path) ? old : [...old, file])} />
    </>, headerActions)}
    <div ref={transcript} onScroll={event => {
      const el = event.currentTarget
      followTranscript.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }} className={chatTranscriptClass} data-anti-chat-scroll>
      {!history.data?.length && !history.error && <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-muted">
        <AntiIcon className="h-11 w-11 text-accent" />
        {history.isPending ? '正在加载会话…' : '想让 Anti 为这个项目做什么？'}
      </div>}
      <div className="space-y-5">
        {history.data?.map(run => <article className="space-y-3" key={run.id}>
          <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-tr-md border border-line/60 bg-bg-card px-4 py-2.5 text-sm text-ink">
            <MessageContent format="text" content={run.prompt} />
          </div>
          <div className="flex min-w-0 items-start gap-2">
            <AntiIcon className="mt-1 h-6 w-6 shrink-0 text-accent" />
            <div className="group/anti-reply min-w-0 space-y-2 rounded-2xl rounded-tl-md border border-line/60 bg-bg-card px-3 py-2.5 text-sm text-ink">
              {run.status !== 'success' && <p role="status" className="text-xs text-ink-muted">
                {run.status}{run.error ? ` · ${run.error}` : ''}
                {run.error_detail && <span className="mt-1 block text-sm text-ink">{run.error_detail}</span>}
              </p>}
              <FileLinkContext.Provider value={{ sessionId: sid, projectPath: workspace, engine: 'anti' }}>
                <FileTransferConclusion.Provider value={run.status === 'success' ? { engine: 'anti', project } : null}>
                  <AntiTaskProgress active={active(run)} loadEvents={signal => request<AntiEvent[]>(`${path}/${run.id}/events`, signal)}
                    runKey={`${sid}/${run.id}`} onEventsChanged={scrollToLatest}>
                    {partial => <MessageContent format="markdown" content={run.answer ?? partial} />}
                  </AntiTaskProgress>
                  {run.status === 'success' && run.answer?.trim() && (
                    <div className="pointer-events-none flex flex-wrap justify-end gap-2 opacity-0 transition-opacity group-hover/anti-reply:pointer-events-auto group-hover/anti-reply:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                      <ReplyActions text={run.answer} engine="anti" project={project} canSave />
                    </div>
                  )}
                </FileTransferConclusion.Provider>
              </FileLinkContext.Provider>
            </div>
          </div>
        </article>)}
        <Errors items={[history.error, live.error, send.error, cancel.error]} />
      </div>
    </div>
    <ChatComposerFrame>
      {references.length > 0 && <ul aria-label="引用文件" className="flex flex-wrap gap-1 px-3 pt-2 text-xs">
        {references.map(file => <li key={file.path} className="flex min-w-0 items-center gap-1 rounded-md bg-bg-soft px-2 py-1" title={file.path}>
          <span className="truncate">{file.name}</span>
          <button type="button" aria-label={`移除引用 ${file.name}`} disabled={Boolean(pending) || Boolean(current)}
            className="text-ink-muted hover:text-accent disabled:opacity-40" onClick={() => setReferences(old => old.filter(item => item.path !== file.path))}>×</button>
        </li>)}
      </ul>}
      <ImagePasteInput
        text={prompt}
        onText={setPrompt}
        attachments={EMPTY_ATTACHMENTS}
        onAttachments={() => {}}
        acceptFiles={false}
        inputLabel="发给 Anti"
        placeholder="发给 Anti…"
        readOnly={Boolean(pending)}
        maxLength={24000}
        onSubmit={submit}
        submitDisabled={Boolean(current) || send.isPending || !history.isSuccess}
        submitLabel={pending && send.isError ? '查询或重试同一请求' : '发送'}
        stopActive={Boolean(current)}
        stopDisabled={cancel.isPending}
        onStop={() => { if (current) cancel.mutate(current.id) }}
      />
    </ChatComposerFrame>
  </>
}
