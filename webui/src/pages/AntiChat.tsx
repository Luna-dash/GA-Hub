import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUp, Brain, FolderOpen, Plus, Square } from 'lucide-react'
import { AntiDaemonControl } from '@/components/AntiDaemonControl'
import { AntiIcon } from '@/components/AntiMark'
import { MessageContent } from '@/components/MessageContent'
import { MainModelSelect } from '@/components/ModelSelect'
import { PageShell } from '@/components/PageShell'
import { ProjectSelect } from '@/components/ProjectSelect'
import { ThemedSelect } from '@/components/ThemedSelect'
import { api } from '@/api/client'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

type Session = { id: string; project: string; title: string; workspace?: string }
type Run = { id: string; status: string; operation: string; prompt: string; answer: string | null; artifact: string | null; error: string | null }
type Delta = { seq: number; text: string }
const active = (run: Run) => ['submitting', 'queued', 'running', 'unknown'].includes(run.status)
const base = '/api/anti/sessions'
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
type Submission = { prompt: string; operation: string; model: string; effort: string }

function Errors({ items }: { items: (Error | null)[] }) {
  return <>{items.filter(Boolean).map((error, index) =>
    <p role="alert" className="rounded-lg border border-status-danger-line bg-status-danger-soft px-3 py-2 text-sm text-status-danger [overflow-wrap:anywhere]" key={index}>{error?.message}</p>)}</>
}

async function request<T>(path: string, signal?: AbortSignal, body?: object): Promise<T> {
  const res = await fetch(resolveApiUrl(path), {
    signal, method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const error = await res.json().catch(() => null)
    throw new Error(typeof error?.detail === 'string' ? error.detail : `Anti 请求失败 (${res.status})`)
  }
  return res.json()
}

export default function AntiChat() {
  const cache = useQueryClient()
  const [project, setProject] = useState('')
  const [sid, setSid] = useState('')
  const projects = useQuery({ queryKey: ['anti-projects'], queryFn: api.projects })
  const sessions = useQuery({ queryKey: ['anti-sessions'], queryFn: ({ signal }) => request<Session[]>(base, signal) })
  const create = useMutation({
    mutationFn: () => request<Session>(base, undefined, { project }),
    onSuccess: session => {
      cache.setQueryData<Session[]>(['anti-sessions'], old => [session, ...(old ?? [])])
      setSid(session.id)
      void cache.invalidateQueries({ queryKey: ['anti-sessions'] })
    },
  })
  const selected = sessions.data?.find(row => row.id === sid) ?? sessions.data?.[0]
  const available = projects.data?.items.filter(item => !item.dangling) ?? []
  const names = new Map(projects.data?.items.map(item => [item.name, item.display_name ?? item.name]) ?? [])
  const workspace = selected?.workspace
  return <PageShell title="Anti 聊天" layout="workspace"
    titleExtra={<span className="ga-badge"><AntiIcon className="mr-1 inline h-4 w-4" />Plan</span>}
    actions={<AntiDaemonControl />}
    middleArea={workspace && <div title={workspace} className="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
      <FolderOpen size={15} className="shrink-0" aria-hidden="true" /><span className="truncate">{workspace}</span>
    </div>}>
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
      <aside aria-label="Anti 会话" className="flex max-h-44 w-full shrink-0 flex-col gap-2 border-b border-line/60 bg-bg-card/60 p-2 md:max-h-none md:w-[200px] md:border-b-0 md:border-r">
        <ProjectSelect standalone aria-label="项目目录" placeholder="选择项目目录" value={project} onChange={setProject}
          options={available.map(item => ({ key: item.name, name: item.display_name ?? item.name }))} />
        {project && <p className="truncate px-1 text-xs text-ink-muted" title={available.find(item => item.name === project)?.path}>
          {available.find(item => item.name === project)?.path}
        </p>}
        <button type="button" className="flex min-h-8 items-center justify-center gap-2 rounded-lg border border-line bg-bg-card px-2 text-sm text-ink hover:border-accent disabled:opacity-40"
          disabled={!project || create.isPending || !available.some(item => item.name === project)} onClick={() => create.mutate()}>
          <Plus size={15} aria-hidden="true" /> 新建 Anti 会话
        </button>
        <div className="flex min-h-0 flex-1 gap-1 overflow-auto md:flex-col">
          {sessions.data?.map(row => <button type="button" key={row.id} aria-pressed={selected?.id === row.id}
            onClick={() => { setSid(row.id); setProject(row.project) }}
            title={`${names.get(row.project) ?? row.project} · ${row.title}`}
            className={`min-w-28 shrink-0 truncate rounded-md px-2 py-1.5 text-left text-sm hover:bg-bg-soft md:min-w-0 ${selected?.id === row.id ? 'bg-bg-soft font-semibold text-accent' : 'text-ink'}`}>
            {row.title} <span className="block truncate text-xs font-normal text-ink-muted">{names.get(row.project) ?? row.project}</span>
          </button>)}
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {(projects.error || sessions.error || create.error) && <div className="space-y-1 px-3 pt-2"><Errors items={[projects.error, sessions.error, create.error]} /></div>}
        {selected ? <Conversation key={selected.id} sid={selected.id} /> :
          <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-5 text-center text-sm text-ink-muted">
            <AntiIcon className="h-11 w-11 text-accent" />
            <p>{sessions.isPending ? '正在加载 Anti 会话…' : '选择一个项目目录，再新建 Anti 会话。'}</p>
            <p>以 Plan 模式运行，成功结果保存到项目共享产物目录。</p>
          </div>}
      </div>
    </div>
  </PageShell>
}

function Conversation({ sid }: { sid: string }) {
  const cache = useQueryClient()
  const [prompt, setPrompt] = useState('')
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
      const livePath = `${path}/${current!.id}`
      const run = await request<Run>(livePath, signal)
      if (!active(run)) {
        cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
        return []
      }
      return request<Delta[]>(`${livePath}/events`, signal)
    },
  })
  useEffect(() => {
    if (pending && history.data?.some(run => run.operation === pending.operation)) {
      setPending(undefined)
      setPrompt('')
    }
  }, [history.data, pending])
  const send = useMutation({
    mutationFn: (body: Submission) => request<Run>(path, undefined, body),
    onSuccess: run => {
      cache.setQueryData<Run[]>(key, old => [...(old ?? []).filter(row => row.id !== run.id), run])
      setPrompt(''); setPending(undefined)
    },
    onSettled: () => { void cache.invalidateQueries({ queryKey: key }) },
  })
  const cancel = useMutation({
    mutationFn: (rid: string) => request<Run>(`${path}/${rid}/cancel`, undefined, {}),
    onSuccess: run => cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row)),
  })
  useEffect(() => {
    if (transcript.current && followTranscript.current) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [history.data, live.data])
  return <>
    <div ref={transcript} onScroll={event => {
      const el = event.currentTarget
      followTranscript.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    }} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-6">
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
            <div className="min-w-0 space-y-2 rounded-2xl rounded-tl-md border border-line/60 bg-bg-card px-3 py-2.5 text-sm text-ink">
              {run.status !== 'success' && <p role="status" className="text-xs text-ink-muted">{run.status}{run.error ? ` · ${run.error}` : ''}</p>}
              <MessageContent format="markdown" content={run.answer ?? (run.id === current?.id ? (live.data?.map(row => row.text).join('') ?? '') : '')} />
              {run.artifact && <p className="border-t border-line/60 pt-2 text-xs text-ink-muted [overflow-wrap:anywhere]">共享产物：<code>{run.artifact}</code></p>}
            </div>
          </div>
        </article>)}
        <Errors items={[history.error, live.error, send.error, cancel.error]} />
      </div>
    </div>
    <div className="shrink-0 border-t border-line/40 px-3 py-2.5">
      <form className="w-full rounded-xl border border-line/60 bg-bg-card shadow-sm" onSubmit={event => {
        event.preventDefault()
        if (current || send.isPending || !history.isSuccess || !prompt.trim()) return
        const body = pending ?? { prompt: prompt.trim(), model, effort, operation: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}` }
        followTranscript.current = true
        setPending(body)
        send.mutate(body)
      }}>
        <textarea aria-label="发给 Anti" placeholder="发给 Anti…" rows={3} value={prompt}
          className="block w-full resize-y rounded-t-xl bg-transparent px-3 pt-3 text-sm text-ink outline-none placeholder:text-ink-muted"
          readOnly={Boolean(pending)} onChange={event => setPrompt(event.target.value)} maxLength={24000} />
        <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
          <MainModelSelect aria-label="模型" className="max-w-full" title={models.error ? '暂时无法读取模型列表，可继续使用默认模型' : '模型'}
            llms={families} value={family?.key} onChange={setFamilyKey} disabled={Boolean(pending) || models.isPending} />
          <ThemedSelect aria-label="思考等级" options={effortOptions} value={effort} onChange={setEffort}
            displayName={option => `思考：${option.name}`} placeholder="思考：高"
            renderMark={() => <span className="model-select-mark"><Brain size={16} aria-hidden="true" /></span>}
            disabled={Boolean(pending)} />
          {models.error && <button type="button" className="text-xs text-ink-muted hover:text-accent" onClick={() => void models.refetch()}>重试加载模型</button>}
          <div className="ml-auto flex items-center gap-2">
            {current ? <button type="button" aria-label="停止" title="停止" className="rounded-lg border border-line p-2 text-ink hover:text-accent disabled:opacity-40"
              disabled={cancel.isPending} onClick={() => cancel.mutate(current.id)}><Square size={16} aria-hidden="true" /></button> :
              <button type="submit" aria-label={pending && send.isError ? '查询或重试同一请求' : '发送'} title={pending && send.isError ? '查询或重试同一请求' : '发送'}
                className="rounded-lg bg-accent p-2 text-white disabled:opacity-40" disabled={send.isPending || !history.isSuccess || !prompt.trim()}>
                <ArrowUp size={16} aria-hidden="true" />
              </button>}
          </div>
        </div>
      </form>
    </div>
  </>
}
