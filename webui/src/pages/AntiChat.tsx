import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import type { TransferredFile } from '@/components/FileTransferBox'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AntiTaskProgress, type AntiEvent } from './AntiTaskProgress'
import { Check, ChevronDown, ClipboardList, Pencil, RefreshCw, ShieldAlert, X } from 'lucide-react'
import { RotateCw, Square } from '@/components/ActionIcons'
import { ChatComposerFrame, ChatUtilityDock, TranscriptUtilityRail, chatTranscriptClass } from '@/components/ChatLayout'
import { ConversationCollapseControl, ConversationCollapseProvider } from '@/components/ConversationCollapse'
import { ConversationTurnMinimap } from '@/components/ConversationTurnMinimap'
import { TranscriptNavDock } from '@/components/TranscriptNavDock'
import { bubbleTone } from '@/components/bubbleTone'
import { Z_LAYERS } from '@/config/zLayers'
import { ImagePasteInput } from '@/components/ImagePasteInput'
import { DEFAULT_ANTI_COMMANDS, filterAntiSlashCommands } from '@/components/antiSlashCommands'
import { AntiDaemonControl, useAntiDaemonStatus } from '@/components/AntiDaemonControl'
import { AntiAgyProfiles, useAgyProfiles } from '@/components/AntiAgyProfiles'
import { AntiAccountUsageButton } from '@/components/AntiAccountUsageButton'
import { AntiOrchestratorModal } from '@/components/AntiOrchestratorModal'
import { AntiApprovalDock } from '@/components/AntiApprovalDock'
import { AntiQueuedDock } from '@/components/AntiQueuedDock'
import {
  AntiModelSelector,
  buildSelectorFamilies,
  DEFAULT_EFFORT,
  DEFAULT_FAMILY,
  DEFAULT_MODEL,
  EFFORT_OPTIONS,
  normalizeOrchestratorPresets,
  normalizeSelectedFamilyKey,
  resolveUpstreamOrchestratorModelId,
} from '@/components/AntiModelSelector'
import { AntiIcon } from '@/components/AntiMark'
import { MessageContent } from '@/components/MessageContent'
import { FileLinkContext, FileTransferConclusion } from '@/components/FileCitation'
import { UserAttachments } from '@/components/MessageBubble'
import { ReplyActions } from '@/components/ReplyActions'
import { PageShell } from '@/components/PageShell'
import { ProjectSelect } from '@/components/ProjectSelect'
import { SessionRail } from '@/components/SessionRail'
import { ModalOverlay } from '@/components/ModalOverlay'
import type { HubSession, PasteAttachment, SessionRuntime } from '@/api/types'
import { readPageState, usePageState, writePageState } from '@/utils/pageState'
import { routeChatWheel } from '@/utils/chatWheel'
import { createRafScheduler } from '@/utils/rafScheduler'
import { focusChatScrollFromUtilityRail } from '@/utils/utilityRailFocus'
import { CHAT_FONT_SCALE_EVENT, chatFontPercent, getChatFontScale } from '@/utils/chatAppearance'
import { formatRunUsage } from '@/utils/antiUsage'
import { antiSessionToRuntime } from '@/utils/sessionUi'
import { markSessionRead } from '@/stores/sessionUnreadStore'
import { UI_SETTINGS_HYDRATED_EVENT } from '@/stores/uiSettingsStore'
import { useDraftStore } from '@/stores/draftStore'
import { toast } from '@/stores/toastStore'
import { resolveApiUrl } from '@/runtime/runtimeConfig'
import { queryKeys } from '@/queries/queryKeys'
import {
  antiApi, api, HttpError,
  type AgyProfiles, type AntiApprovalPrompt, type AntiAttachmentRef, type AntiMode,
  type AntiPermissionMode, type AntiQueuedPromptItem, type AntiQueueEnqueueSubmission,
  type AntiQueueState, type AntiRun, type AntiSession, type AntiSteerSubmission, type AntiSubmission,
} from '@/api/client'

type Session = AntiSession
type Run = AntiRun
const active = (run: Run) => ['submitting', 'queued', 'running', 'unknown'].includes(run.status)
const sessionsKey = queryKeys.antiSessions
type Submission = AntiSubmission
const EMPTY_QUEUED_ITEMS: AntiQueuedPromptItem[] = []

function AntiRouteSessionSync({ onSession }: { onSession: (id: string) => void }) {
  const { pathname, search } = useLocation()
  const navigate = useNavigate()
  const onSessionRef = useRef(onSession)
  onSessionRef.current = onSession
  useEffect(() => {
    const requested = new URLSearchParams(search).get('session')
    if (!requested) return
    onSessionRef.current(requested)
    navigate(pathname, { replace: true })
  }, [navigate, pathname, search])
  return null
}

const permissionLabels: Record<AntiPermissionMode, string> = {
  'approval-required': '逐次审批',
  'auto-accept-edits': '自动改文件',
  auto: 'Auto',
  'full-access': '全放行',
}

interface ExecutionPolicyOption {
  id: string
  mode: AntiMode
  permissionMode: AntiPermissionMode
  label: string
  triggerLabel: string
  description: string
}

const EXECUTION_POLICIES: readonly ExecutionPolicyOption[] = [
  {
    id: 'plan',
    mode: 'plan',
    permissionMode: 'approval-required',
    label: 'Plan · 只读规划',
    triggerLabel: 'Plan',
    description: '先调研分析并输出结构化方案，不修改工作区文件',
  },
  {
    id: 'accept-edits:approval-required',
    mode: 'accept-edits',
    permissionMode: 'approval-required',
    label: 'Edit · 逐次审批',
    triggerLabel: 'Edit · 逐次审批',
    description: '修改文件或执行命令行前每次弹窗确认',
  },
  {
    id: 'accept-edits:auto-accept-edits',
    mode: 'accept-edits',
    permissionMode: 'auto-accept-edits',
    label: 'Edit · 自动改文件',
    triggerLabel: 'Edit · 自动改文件',
    description: '工作区内改写自动放行，命令行或跨目录仍需确认',
  },
  {
    id: 'accept-edits:auto',
    mode: 'accept-edits',
    permissionMode: 'auto',
    label: 'Edit · Auto',
    triggerLabel: 'Edit · Auto',
    description: '由 Agy 自动评估风险，仅高风险操作需要确认',
  },
  {
    id: 'accept-edits:full-access',
    mode: 'accept-edits',
    permissionMode: 'full-access',
    label: 'Edit · 全放行',
    triggerLabel: 'Edit · 全放行',
    description: '自动允许所有文件与命令操作，无需逐次审批',
  },
]

const EMPTY_ATTACHMENTS: PasteAttachment[] = []
const TRANSFER_PREFIX = 'transfer:'
const SOFT_STOP_ESCALATION_MS = 3500
const SILENT_STUCK_SECONDS = 90

function parseIsoMs(raw?: string | null): number | null {
  if (!raw) return null
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : null
}

function formatRunTime(ms: number | null): string | null {
  if (ms === null) return null
  const date = new Date(ms)
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === now.toDateString()) return time
  const day = date.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' })
  return `${day} ${time}`
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

function formatRunStatusLabel(status: string): string {
  switch (status) {
    case 'submitting': return '提交中'
    case 'queued': return '排队中'
    case 'running': return '运行中'
    case 'unknown': return '状态同步中'
    case 'cancelled':
    case 'canceled': return '任务中止'
    case 'timeout': return '响应超时'
    case 'rate_limited': return '额度受限'
    case 'rejected': return '已拒绝'
    case 'cli_error': return '运行异常'
    default: return status
  }
}

const grantLabels: Record<string, string> = {
  execute: '执行命令',
  edit: '修改文件',
  delete: '删除文件',
  move: '移动文件',
  other: '其他操作',
  '*': '全部权限',
}

function pickBestFallbackProfile(profilesData: AgyProfiles | undefined, currentProfileId: string) {
  if (!profilesData?.profiles?.length) return null
  const candidates = profilesData.profiles
    .filter(p => p.id !== currentProfileId && (p.cooldown_seconds ?? 0) <= 0)
    .filter(p => p.auth_state === 'authenticated' || p.has_credentials === true || p.id === 'default')
  if (!candidates.length) return null
  candidates.sort((a, b) => {
    const pa = a.usage?.min_remaining_pct
    const pb = b.usage?.min_remaining_pct
    if (typeof pa === 'number' && typeof pb === 'number' && pb !== pa) return pb - pa
    if (typeof pa === 'number' && typeof pb !== 'number') return -1
    if (typeof pa !== 'number' && typeof pb === 'number') return 1
    if (a.auth_state === 'authenticated' && b.auth_state !== 'authenticated') return -1
    if (b.auth_state === 'authenticated' && a.auth_state !== 'authenticated') return 1
    return 0
  })
  const chosen = candidates[0]
  return { profile: chosen, pct: chosen.usage?.min_remaining_pct }
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

function queuedItemToAttachments(item: AntiQueuedPromptItem): PasteAttachment[] {
  const attList: PasteAttachment[] = (item.attachments ?? []).map((att, index) => {
    const name = att.name || att.path.split(/[/\\]/).pop() || 'attachment'
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const isImg = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
    const mime = isImg ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : ''
    const url = att.source === 'managed_upload' ? api.fileUrlByPath(att.path) : ''
    return {
      file_id: `${item.id}-att-${index}`,
      name,
      path: att.path,
      url,
      mime,
      size: att.size ?? 0,
      source: att.source ?? 'managed_upload',
      ...(isImg && url ? { preview: url } : {}),
    }
  })
  const refList: PasteAttachment[] = (item.references ?? []).map((ref) => {
    const name = ref.path.split(/[/\\]/).pop() || ref.path
    const ext = name.split('.').pop()?.toLowerCase() ?? ''
    const mime = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)
      ? `image/${ext === 'jpg' ? 'jpeg' : ext}` : 'application/octet-stream'
    return {
      file_id: `${TRANSFER_PREFIX}${ref.id}`,
      name,
      path: ref.path,
      url: '',
      mime,
      size: 0,
      source: 'local_ref',
    }
  })
  return [...attList, ...refList]
}

function buildRunInputs(rawPrompt: string, itemAttachments: PasteAttachment[]): AntiSteerSubmission {
  const trimmed = rawPrompt.trim()
  const transferRefs = itemAttachments
    .filter(item => item.file_id.startsWith(TRANSFER_PREFIX))
    .map(item => ({ id: Number(item.file_id.slice(TRANSFER_PREFIX.length)), path: item.path }))
    .filter(item => Number.isFinite(item.id) && item.id > 0)
  const regularAtts = itemAttachments
    .filter(item => !item.file_id.startsWith(TRANSFER_PREFIX))
    .map(({ path, name, source, size }) => ({
      path,
      name,
      source: source ?? 'managed_upload',
      ...(size != null ? { size } : {}),
    }))
  return {
    prompt: trimmed,
    ...(transferRefs.length ? { references: transferRefs } : {}),
    ...(regularAtts.length ? { attachments: regularAtts } : {}),
  }
}

export default function AntiChat() {
  const cache = useQueryClient()
  const inRouter = useInRouterContext()
  const [project, setProject] = useState<string | null>(null)
  const [sid, setSid] = usePageState('antiChat.currentSession', '')
  const [creating, setCreating] = useState(false)
  const [profilesOpen, setProfilesOpen] = useState(false)
  const [profilesInitialView, setProfilesInitialView] = useState<'list' | 'settings'>('list')
  const [orchestratorOpen, setOrchestratorOpen] = useState(false)
  const [headerActions, setHeaderActions] = useState<HTMLDivElement | null>(null)
  const openProfilesModal = useCallback((view: 'list' | 'settings' = 'list') => {
    setProfilesInitialView(view)
    setProfilesOpen(true)
  }, [])
  const daemon = useAntiDaemonStatus()
  const profiles = useAgyProfiles()
  const projects = useQuery({ queryKey: queryKeys.projects, queryFn: api.projects })
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
      markSessionRead('anti', id)
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
  const railRuntimes: Record<string, SessionRuntime> = Object.fromEntries(
    (sessions.data ?? []).map(row => [row.id, antiSessionToRuntime(row)]),
  )
  const openCreate = () => {
    create.reset()
    setProject(available.some(item => item.name === selected?.project) ? selected?.project ?? null : null)
    setCreating(true)
  }
  const closeCreate = () => { if (!create.isPending) setCreating(false) }
  const selectedProfile = profiles.data?.profiles.find(item => item.id === profiles.data?.active)
  const cachedUsage = selectedProfile?.usage
  return <PageShell title="Agy 会话" wrapHeader
    titleExtra={<>{inRouter && <AntiRouteSessionSync onSession={setSid} />}<AntiDaemonControl {...daemon} /></>}
    actions={<>
      <div ref={setHeaderActions} className="empty:hidden flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2" />
      <AntiAgyProfiles
        profiles={profiles}
        refresh={daemon.refresh}
        daemon={daemon}
        open={profilesOpen}
        onOpenChange={next => {
          if (!next) setProfilesInitialView('list')
          setProfilesOpen(next)
        }}
        initialView={profilesInitialView}
      />
      <AntiOrchestratorModal
        open={orchestratorOpen}
        onClose={() => setOrchestratorOpen(false)}
        profileId={profiles.data?.active || 'default'}
      />
      <AntiAccountUsageButton
        key={profiles.data?.active ?? 'default'}
        running={daemon.running}
        profileName={selectedProfile?.name}
        autoRefreshKey={profiles.data?.active ?? 'default'}
        cachedUsage={cachedUsage}
        onChecked={() => {
          daemon.refresh()
          void cache.invalidateQueries({ queryKey: ['agy-profiles'], exact: true })
        }}
      />
    </>}>
    <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
      <SessionRail storageScope="anti" projects={projects.data?.items} sessions={railSessions}
        runtimes={railRuntimes} currentId={selected?.id ?? null} creating={create.isPending} onSelect={setSid} onCreate={openCreate}
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
                <button type="button" className="ga-btn shrink-0" onClick={() => daemon.restart.mutate(false)}>
                  重置运行时
                </button>
              )}
              <button type="button" className="ga-btn shrink-0" onClick={() => openProfilesModal('settings')}>
                诊断 / 账号设置
              </button>
            </div>
          </div>
        )}
        {daemon.running && daemon.status.data?.agy_available === false && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 border-b border-status-danger-line bg-status-danger-soft px-4 py-2 text-xs text-status-danger">
            <span>未找到官方 agy CLI。请安装 agy 并确保位于 PATH（或 ~/.gemini/bin）后重试。</span>
            <button type="button" className="ga-btn shrink-0" onClick={() => openProfilesModal('settings')}>
              查看运行详情
            </button>
          </div>
        )}
        {daemon.running && daemon.status.data?.agy_available && daemon.status.data?.auth_state === 'login_required' && (
          <div role="status" className="flex flex-wrap items-center justify-between gap-2 border-b border-status-warning-line bg-status-warning-soft px-4 py-2 text-xs text-status-warning">
            <span>当前 Agy 账号尚未登录或凭据已过期，请先完成官方登录后再发起对话。</span>
            <button type="button" className="ga-btn shrink-0" onClick={() => openProfilesModal('list')}>
              去登录账号
            </button>
          </div>
        )}
        <Errors items={[sessions.error, rename.error, remove.error]} />
        {selected ? <Conversation key={selected.id} session={selected} headerActions={headerActions}
          profileId={profiles.data?.active}
          profilesData={profiles.data}
          supportsSteering={daemon.status.data?.supports_steering}
          onOpenProfiles={() => openProfilesModal('list')}
          onOpenOrchestratorSettings={() => setOrchestratorOpen(true)} /> :
          <div className="relative flex flex-1">
            <ChatUtilityDock fileTransfer={{ canInsert: false, onInsert: () => { } }} />
            <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-5 text-center text-sm text-ink-muted">
              <AntiIcon className="h-11 w-11 text-accent" />
              {sessions.isError ? (
                <>
                  <p>会话列表读取失败，请确认服务正常后重试。</p>
                  <button type="button" className="ga-btn-sm" onClick={() => void sessions.refetch()}>
                    <RefreshCw size={13} aria-hidden="true" />
                    <span>重新加载</span>
                  </button>
                </>
              ) : (
                <p>{sessions.isPending ? '正在加载 Agy 会话…' : '点击「新建会话」，选择该会话的项目。'}</p>
              )}
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
        <p className="text-sm text-ink-muted">为这次 Agy 会话选择项目。创建后，会话会归入该项目。</p>
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

function Conversation({ session, headerActions, profileId, profilesData, supportsSteering, onOpenProfiles, onOpenOrchestratorSettings }: {
  session: Session; headerActions: HTMLDivElement | null; profileId?: string; profilesData?: AgyProfiles; supportsSteering?: boolean | null; onOpenProfiles: () => void; onOpenOrchestratorSettings: () => void
}) {
  const { id: sid, project, workspace } = session
  const cache = useQueryClient()
  const draftKey = `antiChat:${sid}`
  const prompt = useDraftStore(state => state.texts[draftKey] ?? '')
  const attachments = useDraftStore(state => state.attachments[draftKey] ?? EMPTY_ATTACHMENTS)
  const setPrompt = useCallback((value: string) => useDraftStore.getState().setText(draftKey, value), [draftKey])
  const setAttachments = useCallback((value: PasteAttachment[]) => useDraftStore.getState().setAttachments(draftKey, value), [draftKey])
  const [pending, setPending] = useState<Submission>()
  const [lastRateLimitedInput, setLastRateLimitedInput] = useState<Submission | null>(null)
  const [queueCollapsed, setQueueCollapsed] = useState(false)
  const [pendingEditItem, setPendingEditItem] = useState<AntiQueuedPromptItem | null>(null)
  const effectiveProfileId = profileId ?? 'default'
  const [clock, setClock] = useState(Date.now)
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null)
  const [forceStopEligible, setForceStopEligible] = useState(false)
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now())
  const lastActivityAtRef = useRef(lastActivityAt)
  const prevActiveRunIdRef = useRef<string | null | undefined>(undefined)
  const [familyKey, setFamilyKey] = usePageState('antiChat.modelFamily', DEFAULT_FAMILY)
  const [preferredEffort, setEffort] = usePageState('antiChat.effort', DEFAULT_EFFORT)
  const [mode, setMode] = usePageState<AntiMode>('antiChat.mode', 'plan')
  const [permissionMode, setPermissionMode] = usePageState<AntiPermissionMode>('antiChat.permissionMode', 'approval-required')
  const [slashActiveIndex, setSlashActiveIndex] = useState(0)
  const [dismissedSlashText, setDismissedSlashText] = useState<string | null>(null)
  const [policyOpen, setPolicyOpen] = useState(false)
  const policyAnchorRef = useRef<HTMLDivElement>(null)
  const composerWrapRef = useRef<HTMLDivElement>(null)
  const activePolicy = mode === 'plan'
    ? EXECUTION_POLICIES[0]
    : (EXECUTION_POLICIES.find(p => p.mode === 'accept-edits' && p.permissionMode === permissionMode) ?? EXECUTION_POLICIES[1])

  useEffect(() => {
    if (!policyOpen) return
    const onPointerDown = (event: PointerEvent) => {
      if (!policyAnchorRef.current?.contains(event.target as Node)) setPolicyOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPolicyOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [policyOpen])
  const [fontScale, setFontScale] = useState(getChatFontScale)
  useEffect(() => {
    const sync = (event: Event) => setFontScale((event as CustomEvent<number>).detail || getChatFontScale())
    const syncHydrated = () => setFontScale(getChatFontScale())
    window.addEventListener(CHAT_FONT_SCALE_EVENT, sync)
    window.addEventListener(UI_SETTINGS_HYDRATED_EVENT, syncHydrated)
    return () => {
      window.removeEventListener(CHAT_FONT_SCALE_EVENT, sync)
      window.removeEventListener(UI_SETTINGS_HYDRATED_EVENT, syncHydrated)
    }
  }, [])
  const messageFontStyle = {
    fontSize: `${chatFontPercent(fontScale)}%`,
    '--chat-scale': chatFontPercent(fontScale) / 100,
  } as CSSProperties
  const transcript = useRef<HTMLDivElement>(null)
  const utilityRailRef = useRef<HTMLElement>(null)
  const followTranscript = useRef(true)
  const [stuckBottom, setStuckBottom] = useState(true)
  const [activeTurn, setActiveTurn] = useState(-1)
  const activeTurnRef = useRef(-1)
  const navTargetRef = useRef<number | null>(null)
  const navLockUntilRef = useRef(0)
  const jumpingToBottomUntilRef = useRef(0)
  const [unreadRuns, setUnreadRuns] = useState(0)
  const seenRunCountRef = useRef(0)
  const scrollPositionsRef = useRef<Record<string, { scrollTop: number; stuck: boolean }>>(
    readPageState('antiChat.scrollPositions', {}),
  )
  const updateActiveTurn = useCallback((next: number) => {
    activeTurnRef.current = next
    setActiveTurn((previous) => previous === next ? previous : next)
  }, [])
  const models = useQuery({
    queryKey: ['anti-models', effectiveProfileId],
    enabled: Boolean(effectiveProfileId),
    queryFn: ({ signal }) => antiApi.models(signal),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })
  const modelsConfig = useQuery({
    queryKey: ['anti-models-config'],
    enabled: Boolean(effectiveProfileId),
    queryFn: ({ signal }) => antiApi.modelsConfig(signal),
    staleTime: 60_000,
    retry: false,
  })
  const allUpstreamItems = models.data?.items ?? [DEFAULT_MODEL]
  const normalizedPresets = normalizeOrchestratorPresets(modelsConfig.data?.orchestrator_presets)
  const hiddenModels = Array.isArray(modelsConfig.data?.hidden_models) ? modelsConfig.data.hidden_models : []
  const families = buildSelectorFamilies(allUpstreamItems, normalizedPresets, hiddenModels)
  const resolvedFamilyKey = normalizeSelectedFamilyKey(familyKey, families, normalizedPresets)
  const family = families.find(item => item.key === resolvedFamilyKey) ?? families[0]
  const isOrchestratorSelected = Boolean(family?.isOrchestrator)
  const selectedOrchPreset = family?.preset
  const effortOptions = isOrchestratorSelected
    ? []
    : family?.efforts?.length
      ? EFFORT_OPTIONS.filter(option => family.efforts!.includes(option.key))
      : EFFORT_OPTIONS.filter(option => family?.plain || family?.variants[option.key])
  const effort = isOrchestratorSelected
    ? (family?.defaultEffort ?? DEFAULT_EFFORT)
    : (effortOptions.find(option => option.key === preferredEffort)?.key
      ?? effortOptions.find(option => option.key === (family?.defaultEffort ?? DEFAULT_EFFORT))?.key
      ?? effortOptions[0]?.key ?? DEFAULT_EFFORT)
  const model = isOrchestratorSelected
    ? resolveUpstreamOrchestratorModelId(allUpstreamItems, selectedOrchPreset?.planner)
    : (family?.variants[effort] ?? family?.plain ?? DEFAULT_MODEL.id)
  const handleSelectFamily = useCallback((nextKey: string) => {
    setFamilyKey(nextKey)
    const nextFamily = families.find(item => item.key === nextKey)
    if (nextFamily?.preset && effectiveProfileId) {
      void antiApi.updateProfileOrchestrator(effectiveProfileId, {
        planner: nextFamily.preset.planner ?? null,
        executor: nextFamily.preset.executor ?? null,
      }).then(updated => {
        cache.setQueryData(['anti-orchestrator', effectiveProfileId], updated)
      }).catch(() => undefined)
    }
  }, [cache, effectiveProfileId, families, setFamilyKey])
  const key = ['anti-runs', sid]
  const queueKey = ['anti-queue', sid]
  const history = useQuery({
    queryKey: key, queryFn: ({ signal }) => antiApi.runs(sid, signal),
    refetchInterval: query => query.state.data?.some(active) || pending ? 1500 : false
  })
  const current = history.data?.find(active)
  const queueQuery = useQuery({
    queryKey: queueKey,
    queryFn: ({ signal }) => antiApi.queue(sid, signal),
    refetchInterval: query => {
      const count = Array.isArray(query.state.data?.items) ? query.state.data.items.length : 0
      return Boolean(current || pending) || count > 0 || (session.queued_count ?? 0) > 0 ? 1500 : false
    },
  })
  const queueItems = Array.isArray(queueQuery.data?.items) ? queueQuery.data.items : EMPTY_QUEUED_ITEMS
  const queuePaused = !current && queueItems.length > 0
  const queuePauseReason = queueQuery.data?.pause_reason ?? null
  useEffect(() => {
    if (pendingEditItem && !queueItems.some(item => item.id === pendingEditItem.id)) {
      setPendingEditItem(null)
    }
  }, [pendingEditItem, queueItems])
  const live = useQuery({
    queryKey: ['anti-live', sid, current?.id], enabled: Boolean(current), refetchInterval: 900,
    queryFn: async ({ signal }) => {
      const run = await antiApi.run(sid, current!.id, signal)
      if (!active(run)) {
        cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
        void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
        void cache.invalidateQueries({ queryKey: queueKey })
      }
      return run
    },
  })
  useEffect(() => {
    if (!current) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [current])
  useEffect(() => {
    if (pending && history.data?.some(run => run.operation === pending.operation)) {
      setPending(undefined)
      useDraftStore.getState().clearDraft(draftKey)
    }
  }, [draftKey, history.data, pending])
  const send = useMutation({
    mutationFn: (body: Submission) => antiApi.submitRun(sid, body),
    onSuccess: run => {
      setLastRateLimitedInput(null)
      cache.setQueryData<Run[]>(key, old => [...(old ?? []).filter(row => row.id !== run.id), run])
      setPending(undefined)
      useDraftStore.getState().clearDraft(draftKey)
    },
    onError: (error, variables) => {
      if (error instanceof HttpError && error.status === 429) {
        setLastRateLimitedInput(variables)
      }
      if (error instanceof HttpError && (error.status === 422 || error.status === 429 || error.status === 409 || error.status === 503)) {
        setPending(undefined)
      }
    },
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: sessionsKey })
    },
  })
  const activeRunId = current?.id ?? null
  useEffect(() => {
    const now = Date.now()
    lastActivityAtRef.current = now
    setLastActivityAt(now)
    if (!activeRunId) {
      setStoppingRunId(null)
      setForceStopEligible(false)
    } else {
      setStoppingRunId(prev => (prev === activeRunId ? prev : null))
      setForceStopEligible(false)
    }
  }, [activeRunId])
  useEffect(() => {
    if (!stoppingRunId || stoppingRunId !== activeRunId) return
    const timer = window.setTimeout(() => setForceStopEligible(true), SOFT_STOP_ESCALATION_MS)
    return () => window.clearTimeout(timer)
  }, [stoppingRunId, activeRunId])
  const cancel = useMutation({
    mutationFn: ({ rid, force = false }: { rid: string; force?: boolean }) => antiApi.cancelRun(sid, rid, force),
    onMutate: ({ rid }) => {
      setStoppingRunId(rid)
    },
    onSuccess: (run, vars) => {
      cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === run.id ? run : row))
      if (!active(run)) {
        setStoppingRunId(null)
        setForceStopEligible(false)
        void cache.invalidateQueries({ queryKey: ['anti-live', sid, run.id] })
        void cache.invalidateQueries({ queryKey: key })
        void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
      } else if (!vars.force) {
        setForceStopEligible(true)
      }
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
    mutationFn: (force: boolean = false) => antiApi.resetSession(sid, force),
    onSuccess: updated => {
      setStoppingRunId(null)
      setForceStopEligible(false)
      cache.setQueryData<Session[]>(sessionsKey, old => old?.map(row => row.id === updated.id ? { ...row, ...updated } : row))
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
    },
  })
  const slashMatch = /^\/(\S*)$/.exec(prompt.trimStart())
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : ''
  const showSlashMenu = !current && !pending && Boolean(slashMatch) && dismissedSlashText !== prompt
  const commands = useQuery({
    queryKey: ['anti-commands', effectiveProfileId],
    enabled: Boolean(effectiveProfileId && (showSlashMenu || session.has_conversation)),
    queryFn: ({ signal }) => antiApi.commands(signal),
    staleTime: showSlashMenu ? 0 : 60_000,
    retry: false,
  })
  const { refetch: refetchCommands } = commands
  useEffect(() => {
    if (showSlashMenu && effectiveProfileId) void refetchCommands()
  }, [showSlashMenu, effectiveProfileId, refetchCommands])
  const rawCommands = commands.data?.items ?? DEFAULT_ANTI_COMMANDS
  const {
    items: filteredCommands,
    hiddenCount: hiddenCommandCount,
    totalAvailable: availableCommandCount,
  } = useMemo(
    () => filterAntiSlashCommands(rawCommands, slashQuery),
    [rawCommands, slashQuery],
  )

  useEffect(() => {
    setSlashActiveIndex(0)
  }, [prompt])

  const applySlashCommand = (cmdName: string) => {
    setPrompt(`/${cmdName} `)
    setDismissedSlashText(null)
    requestAnimationFrame(() => composerWrapRef.current?.querySelector('textarea')?.focus())
  }

  const runs = history.data ?? []

  const syncTranscriptNav = useCallback(() => {
    const el = transcript.current
    if (!el) return
    const now = performance.now()
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    if (jumpingToBottomUntilRef.current > now) {
      if (atBottom) {
        jumpingToBottomUntilRef.current = 0
      } else {
        return
      }
    }
    followTranscript.current = atBottom
    setStuckBottom(atBottom)
    if (atBottom) {
      setUnreadRuns(0)
      seenRunCountRef.current = runs.length
    }
    const nodes = el.querySelectorAll<HTMLElement>('[data-anti-turn]')
    if (nodes.length === 0) {
      updateActiveTurn(-1)
      return
    }
    const navTarget = navTargetRef.current
    if (navTarget !== null && navTarget < nodes.length && now < navLockUntilRef.current) {
      updateActiveTurn(navTarget)
      return
    }
    navTargetRef.current = null
    navLockUntilRef.current = 0
    const elRect = el.getBoundingClientRect?.()
    const hasLiveRects = Boolean(elRect && elRect.height > 0)
    let currentTurn = atBottom ? nodes.length - 1 : 0
    if (!atBottom) {
      const threshold = hasLiveRects ? elRect.top + el.clientTop + 48 : el.scrollTop + 48
      nodes.forEach((node, idx) => {
        const rect = node.getBoundingClientRect?.()
        const top = hasLiveRects && rect && rect.height > 0 ? rect.top : node.offsetTop
        if (top <= threshold) currentTurn = idx
      })
    }
    updateActiveTurn(currentTurn)
    if (initializedRunsRef.current) {
      const next = { ...scrollPositionsRef.current, [sid]: { scrollTop: el.scrollTop, stuck: atBottom } }
      const entries = Object.entries(next)
      scrollPositionsRef.current = entries.length > 40 ? Object.fromEntries(entries.slice(entries.length - 40)) : next
      writePageState('antiChat.scrollPositions', scrollPositionsRef.current)
    }
  }, [runs.length, sid, updateActiveTurn])

  const syncTranscriptNavRef = useRef(syncTranscriptNav)
  syncTranscriptNavRef.current = syncTranscriptNav

  useEffect(() => {
    const el = transcript.current
    if (!el) return
    const scrollScheduler = createRafScheduler(() => syncTranscriptNavRef.current())
    const clearNavLock = () => {
      navTargetRef.current = null
      navLockUntilRef.current = 0
      jumpingToBottomUntilRef.current = 0
    }
    const onScrollEnd = () => {
      const now = performance.now()
      if (now < jumpingToBottomUntilRef.current || now < navLockUntilRef.current) {
        syncTranscriptNavRef.current()
        return
      }
      clearNavLock()
      scrollScheduler.schedule()
    }
    el.addEventListener('scroll', scrollScheduler.schedule, { passive: true })
    el.addEventListener('scrollend', onScrollEnd, { passive: true })
    el.addEventListener('wheel', clearNavLock, { passive: true })
    el.addEventListener('touchstart', clearNavLock, { passive: true })
    el.addEventListener('pointerdown', clearNavLock, { passive: true })
    return () => {
      scrollScheduler.cancel()
      el.removeEventListener('scroll', scrollScheduler.schedule)
      el.removeEventListener('scrollend', onScrollEnd)
      el.removeEventListener('wheel', clearNavLock)
      el.removeEventListener('touchstart', clearNavLock)
      el.removeEventListener('pointerdown', clearNavLock)
    }
  }, [sid])

  const hasRuns = runs.length > 0
  useEffect(() => {
    const el = transcript.current
    const rail = utilityRailRef.current
    if (!el || !rail || !hasRuns) return
    const clearNavLock = () => {
      navTargetRef.current = null
      navLockUntilRef.current = 0
      jumpingToBottomUntilRef.current = 0
    }
    const onWheel = (event: WheelEvent) => routeChatWheel(event, el, clearNavLock)
    rail.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      rail.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [hasRuns, sid])

  const jumpToBottom = useCallback(() => {
    const el = transcript.current
    if (!el) return
    const lastTurn = runs.length - 1
    followTranscript.current = true
    setStuckBottom(true)
    setUnreadRuns(0)
    seenRunCountRef.current = runs.length
    navTargetRef.current = lastTurn >= 0 ? lastTurn : null
    navLockUntilRef.current = performance.now() + 900
    jumpingToBottomUntilRef.current = performance.now() + 900
    updateActiveTurn(Math.max(0, lastTurn))
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      if (jumpingToBottomUntilRef.current > performance.now()) {
        el.scrollTop = el.scrollHeight
      }
    })
  }, [runs.length, updateActiveTurn])

  const collapseToLatest = useCallback(() => {
    navTargetRef.current = null
    navLockUntilRef.current = 0
    jumpingToBottomUntilRef.current = 0
    followTranscript.current = true
    setStuckBottom(true)
    setUnreadRuns(0)
    seenRunCountRef.current = runs.length
    updateActiveTurn(runs.length - 1)
    const el = transcript.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    if (initializedRunsRef.current) {
      const next = { ...scrollPositionsRef.current, [sid]: { scrollTop: el.scrollTop, stuck: true } }
      const entries = Object.entries(next)
      scrollPositionsRef.current = entries.length > 40 ? Object.fromEntries(entries.slice(entries.length - 40)) : next
      writePageState('antiChat.scrollPositions', scrollPositionsRef.current)
    }
    requestAnimationFrame(() => {
      if (followTranscript.current && transcript.current === el) {
        el.scrollTop = el.scrollHeight
      }
    })
  }, [runs.length, sid, updateActiveTurn])

  const jumpToTurnIndex = useCallback((targetIndex: number) => {
    const el = transcript.current
    if (!el || runs.length === 0) return
    const next = Math.max(0, Math.min(runs.length - 1, targetIndex))
    const target = el.querySelector<HTMLElement>(`[data-anti-turn="${next}"]`)
    if (!target) return
    followTranscript.current = false
    setStuckBottom(false)
    navTargetRef.current = next
    navLockUntilRef.current = performance.now() + 700
    jumpingToBottomUntilRef.current = 0
    updateActiveTurn(next)
    const elRect = el.getBoundingClientRect?.()
    const targetRect = target.getBoundingClientRect?.()
    const top = elRect && targetRect && elRect.height > 0 && targetRect.height > 0
      ? Math.max(0, el.scrollTop + (targetRect.top - elRect.top - el.clientTop) - 16)
      : Math.max(0, target.offsetTop - 16)
    const farJump = Math.abs(top - el.scrollTop) > Math.max(el.clientHeight * 2.5, 1600)
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top, behavior: farJump ? 'auto' : 'smooth' })
    } else {
      el.scrollTop = top
    }
  }, [runs.length, updateActiveTurn])

  const jumpToTurn = useCallback((delta: -1 | 1) => {
    const currentIndex = activeTurnRef.current < 0
      ? (followTranscript.current ? runs.length - 1 : 0)
      : activeTurnRef.current
    jumpToTurnIndex(currentIndex + delta)
  }, [jumpToTurnIndex, runs.length])

  const minimapTurns = useMemo(
    () => runs.map((run, idx) => {
      const raw = (run.prompt || '').replace(/\s+/g, ' ').trim()
      const snippet = raw.length > 120 ? `${raw.slice(0, 119)}…` : raw
      return {
        id: run.id,
        index: idx + 1,
        label: snippet || (run.attachments?.length ? '（附件消息）' : `第 ${idx + 1} 轮`),
      }
    }),
    [runs],
  )

  const initializedRunsRef = useRef(false)
  const scrollToLatest = useCallback(() => {
    const el = transcript.current
    if (!el || !history.isSuccess) return
    if (!initializedRunsRef.current) {
      initializedRunsRef.current = true
      seenRunCountRef.current = runs.length
      setUnreadRuns(0)
      const saved = scrollPositionsRef.current[sid]
      if (saved && !saved.stuck && runs.length > 0) {
        el.scrollTop = saved.scrollTop
        followTranscript.current = false
        setStuckBottom(false)
        syncTranscriptNavRef.current()
        return
      }
      el.scrollTop = el.scrollHeight
      followTranscript.current = true
      setStuckBottom(true)
      updateActiveTurn(runs.length - 1)
      return
    }
    if (followTranscript.current) {
      el.scrollTop = el.scrollHeight
      seenRunCountRef.current = runs.length
      setUnreadRuns(0)
      setStuckBottom(true)
      updateActiveTurn(runs.length - 1)
    } else if (runs.length > seenRunCountRef.current) {
      setUnreadRuns(runs.length - seenRunCountRef.current)
    }
  }, [history.isSuccess, runs.length, sid, updateActiveTurn])
  const handleEventsChanged = useCallback(() => {
    const now = Date.now()
    if (now - lastActivityAtRef.current >= 1000) {
      lastActivityAtRef.current = now
      setLastActivityAt(now)
    }
    scrollToLatest()
  }, [scrollToLatest])
  useEffect(scrollToLatest, [history.isSuccess, runs.length, scrollToLatest])
  const activeApproval: AntiApprovalPrompt | null = current
    ? (live.data?.approval ?? current.approval ?? null)
    : null
  const activeApprovalId = activeApproval?.id ?? null
  const [approvalCollapsed, setApprovalCollapsed] = useState(false)
  const approvalDockRef = useRef<HTMLElement>(null)
  useEffect(() => {
    setApprovalCollapsed(false)
  }, [activeApprovalId])
  useLayoutEffect(() => {
    const el = transcript.current
    if (!el || !activeApprovalId || !followTranscript.current) return
    el.scrollTop = el.scrollHeight
  }, [activeApprovalId, approvalCollapsed])
  useLayoutEffect(() => {
    const el = transcript.current
    if (!el || queueItems.length === 0 || !followTranscript.current) return
    el.scrollTop = el.scrollHeight
  }, [queueItems.length, queueCollapsed, Boolean(pendingEditItem)])
  useEffect(() => {
    const dock = approvalDockRef.current
    const el = transcript.current
    if (!dock || !el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followTranscript.current && transcript.current === el) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(dock)
    return () => observer.disconnect()
  }, [activeApprovalId])
  const silentSeconds = current && !activeApprovalId ? Math.max(0, Math.floor((clock - lastActivityAt) / 1000)) : 0
  const isSilentStuck = silentSeconds >= SILENT_STUCK_SECONDS
  const canForceStop = Boolean(current && forceStopEligible && stoppingRunId === current.id)
  const showRecoveryBar = Boolean(current && (canForceStop || isSilentStuck))
  const canNativeSteer = Boolean(current && supportsSteering !== false && !canForceStop && !activeApprovalId)
  const transferCount = attachments.filter(item => item.file_id.startsWith(TRANSFER_PREFIX)).length
  const createSubmission = useCallback((rawPrompt: string, itemAttachments: PasteAttachment[]): Submission => {
    const effectivePermission = mode === 'plan' ? 'approval-required' : permissionMode
    return {
      ...buildRunInputs(rawPrompt, itemAttachments),
      model,
      effort,
      mode,
      permission_mode: effectivePermission,
      ...(isOrchestratorSelected && selectedOrchPreset ? {
        orchestrator_planner: selectedOrchPreset.planner ?? null,
        orchestrator_executor: selectedOrchPreset.executor ?? null,
      } : {}),
      operation: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    }
  }, [effort, isOrchestratorSelected, mode, model, permissionMode, selectedOrchPreset])
  const switchAndRetry = useMutation({
    mutationFn: async (targetProfileId: string) => {
      const updatedProfiles = await antiApi.switchProfile(targetProfileId)
      cache.setQueryData(['agy-profiles'], updatedProfiles)
      const lastRateRun = !lastRateLimitedInput ? [...runs].reverse().find(r => r.status === 'rate_limited') : undefined
      const baseBody = lastRateLimitedInput ?? (lastRateRun
        ? createSubmission(lastRateRun.prompt, toUserAttachments(lastRateRun.id, lastRateRun.attachments))
        : null)
      if (!baseBody) return null
      const retryBody: Submission = {
        ...baseBody,
        operation: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }
      return await antiApi.submitRun(sid, retryBody)
    },
    onSuccess: (run, targetProfileId) => {
      setLastRateLimitedInput(null)
      send.reset()
      if (run) {
        cache.setQueryData<Run[]>(key, old => [...(old ?? []).filter(row => row.id !== run.id), run])
        useDraftStore.getState().clearDraft(draftKey)
      }
      void cache.invalidateQueries({ queryKey: ['agy-profiles'], exact: true })
      void cache.invalidateQueries({ queryKey: ['anti-daemon-status'] })
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: ['anti-models'] })
      void cache.invalidateQueries({ queryKey: ['anti-commands'] })
      void cache.invalidateQueries({ queryKey: ['anti-workers'] })
      const targetName = profilesData?.profiles.find(p => p.id === targetProfileId)?.name ?? targetProfileId
      toast.success(`已切换至「${targetName}」并沿用当前上下文重试`)
    },
  })
  const clearGrants = useMutation({
    mutationFn: (kind?: string) => antiApi.clearSessionGrants(sid, kind),
    onSuccess: (updated, kind) => {
      cache.setQueryData<Session[]>(sessionsKey, old => old?.map(row => row.id === updated.id ? { ...row, ...updated } : row))
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
      toast.success(kind ? `已收回本会话「${grantLabels[kind] ?? kind}」授权` : '已收回本会话全部常驻授权')
    },
  })
  const isRateLimited = (send.error instanceof HttpError && send.error.status === 429)
    || (!current && runs.at(-1)?.status === 'rate_limited')
  const fallbackProfile = isRateLimited ? pickBestFallbackProfile(profilesData, effectiveProfileId) : null
  const grants = session.grants ?? []
  const submit = () => {
    const trimmedPrompt = prompt.trim()
    if (current || send.isPending || !history.isSuccess || (!trimmedPrompt && !attachments.length)) return
    const body = pending ?? createSubmission(prompt, attachments)
    followTranscript.current = true
    setPending(body)
    send.mutate(body)
  }
  const buildQueuePayload = useCallback((rawPrompt: string, itemAttachments: PasteAttachment[]): AntiQueueEnqueueSubmission => {
    const { operation: _ignored, ...rest } = createSubmission(rawPrompt, itemAttachments)
    return rest
  }, [createSubmission])
  const enqueue = useMutation({
    mutationFn: ({ payload }: {
      payload: AntiQueueEnqueueSubmission
      rawPrompt: string
      rawAttachments: PasteAttachment[]
      silent?: boolean
    }) => antiApi.enqueuePrompt(sid, payload),
    onSuccess: (updated, vars) => {
      cache.setQueryData<AntiQueueState>(queueKey, updated)
      useDraftStore.getState().clearDraftIfMatch(draftKey, vars.rawPrompt, vars.rawAttachments)
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
      if (!vars.silent) {
        toast.info('已加入待发队列，本轮完成后自动发送')
      }
    },
  })
  const removeQueued = useMutation({
    mutationFn: (qid: string) => antiApi.removeQueuedPrompt(sid, qid),
    onSuccess: updated => {
      cache.setQueryData<AntiQueueState>(queueKey, updated)
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
    },
  })
  const clearQueue = useMutation({
    mutationFn: () => antiApi.clearQueue(sid),
    onSuccess: updated => {
      setPendingEditItem(null)
      cache.setQueryData<AntiQueueState>(queueKey, updated)
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
    },
  })
  const moveQueued = useMutation({
    mutationFn: ({ qid, direction }: { qid: string; direction: 'up' | 'down' | 'top' }) =>
      antiApi.moveQueuedPrompt(sid, qid, direction),
    onSuccess: updated => {
      cache.setQueryData<AntiQueueState>(queueKey, updated)
    },
  })
  const steerQueued = useMutation({
    mutationFn: (qid: string) => antiApi.steerQueuedPrompt(sid, qid),
    onSuccess: res => {
      if (res.run) {
        cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === res.run.id ? res.run : row))
        void cache.invalidateQueries({ queryKey: ['anti-live', sid, res.run.id] })
      }
      cache.setQueryData<AntiQueueState>(queueKey, res.queue)
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
      toast.success('已将该排队消息作为插话发出')
    },
  })
  const dispatchQueued = useMutation({
    mutationFn: (qid?: string) => antiApi.dispatchQueuedPrompt(sid, qid),
    onSuccess: res => {
      followTranscript.current = true
      if (res.run) {
        cache.setQueryData<Run[]>(key, old => [...(old ?? []).filter(row => row.id !== res.run.id), res.run])
      }
      cache.setQueryData<AntiQueueState>(queueKey, res.queue)
      void cache.invalidateQueries({ queryKey: key })
      void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
    },
  })
  const steer = useMutation({
    mutationFn: ({ rid, body }: {
      rid: string
      body: AntiSteerSubmission
      rawPrompt: string
      rawAttachments: PasteAttachment[]
    }) => antiApi.steerRun(sid, rid, body),
    onSuccess: (updated, { rid, rawPrompt, rawAttachments }) => {
      useDraftStore.getState().clearDraftIfMatch(draftKey, rawPrompt, rawAttachments)
      cache.setQueryData<Run[]>(key, old => old?.map(row => row.id === updated.id ? updated : row))
      void cache.invalidateQueries({ queryKey: ['anti-live', sid, rid] })
      void cache.invalidateQueries({ queryKey: key })
      toast.success('已向当前任务发送插话纠偏')
    },
    onError: (error, vars) => {
      if (error instanceof HttpError && error.status === 409) {
        if (vars.rawPrompt.trim() || vars.rawAttachments.length > 0) {
          enqueue.mutate(
            {
              payload: buildQueuePayload(vars.rawPrompt, vars.rawAttachments),
              rawPrompt: vars.rawPrompt,
              rawAttachments: vars.rawAttachments,
              silent: true,
            },
            {
              onSuccess: () => {
                toast.info('当前任务暂无法实时插话，已加入待发队列')
              },
            },
          )
        } else {
          toast.info('当前任务暂无法实时插话，已加入待发队列')
        }
      }
    },
  })
  const queueCurrentInput = () => {
    if (!current || enqueue.isPending || send.isPending || !history.isSuccess) return
    const trimmed = prompt.trim()
    if (!trimmed && !attachments.length) return
    enqueue.mutate({
      payload: buildQueuePayload(prompt, attachments),
      rawPrompt: prompt,
      rawAttachments: attachments,
    })
  }
  const steerCurrentInput = () => {
    if (!current || !canNativeSteer || steer.isPending || send.isPending || !history.isSuccess) return
    const trimmed = prompt.trim()
    if (!trimmed && !attachments.length) return
    steer.mutate({
      rid: current.id,
      body: buildRunInputs(prompt, attachments),
      rawPrompt: prompt,
      rawAttachments: attachments,
    })
  }
  const applyEditQueuedItem = async (item: AntiQueuedPromptItem, stashCurrentDraft: boolean) => {
    if (enqueue.isPending || removeQueued.isPending) return
    if (stashCurrentDraft && (prompt.trim() || attachments.length > 0)) {
      await enqueue.mutateAsync({
        payload: buildQueuePayload(prompt, attachments),
        rawPrompt: prompt,
        rawAttachments: attachments,
        silent: true,
      })
    }
    try {
      await removeQueued.mutateAsync(item.id)
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        removeQueued.reset()
        setPendingEditItem(null)
        void cache.invalidateQueries({ queryKey: queueKey })
        void cache.invalidateQueries({ queryKey: key })
        toast.info('该排队消息已开始发送，无法再编辑')
        return
      }
      throw error
    }
    setPrompt(item.prompt)
    setAttachments(queuedItemToAttachments(item))
    setPendingEditItem(null)
    requestAnimationFrame(() => composerWrapRef.current?.querySelector('textarea')?.focus())
  }
  const handleEditQueuedItem = (item: AntiQueuedPromptItem) => {
    if (prompt.trim() || attachments.length > 0) {
      setPendingEditItem(item)
    } else {
      void applyEditQueuedItem(item, false).catch(() => undefined)
    }
  }
  useEffect(() => {
    const prevId = prevActiveRunIdRef.current
    prevActiveRunIdRef.current = activeRunId
    if (prevId === undefined || prevId === activeRunId) return
    void cache.invalidateQueries({ queryKey: queueKey })
  }, [activeRunId, cache, sid])
  return <>
    {headerActions && createPortal(<>
      <AntiModelSelector
        families={families}
        selectedFamilyKey={family?.key}
        effort={effort}
        effortOptions={effortOptions}
        isOrchestrator={isOrchestratorSelected}
        disabled={Boolean(current || pending) || models.isPending}
        title={models.error ? '模型列表加载失败' : undefined}
        onSelectFamily={handleSelectFamily}
        onSelectEffort={setEffort}
        onOpenOrchestratorSettings={onOpenOrchestratorSettings}
      />
      {models.error && <button type="button" className="ga-btn-icon h-[35px] w-[35px] rounded-[9px]" title="重试加载模型" aria-label="重试加载模型" onClick={() => void models.refetch()}><RotateCw size={16} aria-hidden="true" /></button>}
    </>, headerActions)}
    <ConversationCollapseProvider key={sid} onAfterCollapse={collapseToLatest}>
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ChatUtilityDock fileTransfer={{
        canInsert: !current && !pending && !send.isPending && transferCount < 8,
        onInsert: (file: TransferredFile) => {
          const currentDraft = useDraftStore.getState().attachments[draftKey] ?? []
          if (currentDraft.some(item => item.path === file.path)) return
          const extension = file.name.split('.').pop()?.toLowerCase()
          const mime = extension && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)
            ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : 'application/octet-stream'
          useDraftStore.getState().setAttachments(draftKey, [...currentDraft, {
            file_id: `${TRANSFER_PREFIX}${file.id}`,
            url: '',
            path: file.path,
            name: file.name,
            size: file.size,
            mime,
            source: 'local_ref',
          }])
        },
      }}>
        {runs.length > 0 && (
          <TranscriptUtilityRail
            railRef={utilityRailRef}
            onPointerDown={(event) => focusChatScrollFromUtilityRail(event, transcript.current)}
            minimap={runs.length > 1 ? (
              <ConversationTurnMinimap
                items={minimapTurns}
                activeIndex={activeTurn >= 0 ? activeTurn : (stuckBottom ? Math.max(0, runs.length - 1) : 0)}
                onSelect={jumpToTurnIndex}
              />
            ) : null}
            navDock={(
              <TranscriptNavDock
                stuckBottom={stuckBottom}
                canPrev={activeTurn > 0}
                canNext={activeTurn >= 0 && activeTurn < runs.length - 1}
                unread={unreadRuns}
                onJumpToBottom={jumpToBottom}
                onPrev={() => jumpToTurn(-1)}
                onNext={() => jumpToTurn(1)}
              />
            )}
          />
        )}
      </ChatUtilityDock>
      <ConversationCollapseControl />
      <div ref={transcript} tabIndex={-1} className={chatTranscriptClass} data-anti-chat-scroll>
        {!history.data?.length && !history.error && <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-sm text-ink-faint">
          <AntiIcon className="h-11 w-11 text-accent" />
          {history.isPending ? '正在加载 Agy 会话…' : '想让 Agy 为这个项目做什么？'}
        </div>}
        <div className="space-y-3">
          {history.data?.map((run, runIndex) => {
            const userAttachments = toUserAttachments(run.id, run.attachments)
            const liveRun = current?.id === run.id ? live.data : undefined
            const displayRun = liveRun ?? run
            const isRunActive = active(displayRun)
            const approval: AntiApprovalPrompt | null | undefined = liveRun?.approval ?? run.approval
            const startedMs = parseIsoMs(displayRun.started_at)
            const finishedMs = parseIsoMs(displayRun.finished_at)
            const userTimeLabel = formatRunTime(startedMs)
            const assistantTimeLabel = formatRunTime(finishedMs ?? startedMs)
            const durationText = startedMs !== null
              ? `${isRunActive ? '已运行' : '用时'} ${formatDuration(Math.max(0, (isRunActive ? clock : (finishedMs ?? clock)) - startedMs))}`
              : null
            const policyLabel = displayRun.mode === 'accept-edits'
              ? `Edit · ${permissionLabels[displayRun.permission_mode] ?? displayRun.permission_mode}`
              : 'Plan'
            const rawRunModel = displayRun.effective_model || displayRun.model
            const runModelLabel = rawRunModel
              ? (models.data?.items.find(item => item.id === rawRunModel)?.display_name ?? rawRunModel)
              : null
            const usageInfo = formatRunUsage(displayRun.usage)
            const metaParts = [
              [assistantTimeLabel, durationText].filter(Boolean).join(' · '),
              runModelLabel,
              policyLabel,
            ].filter(Boolean)
            return <article className="space-y-2" key={run.id} data-anti-turn={runIndex}>
              <div className="flex justify-start">
                <div className="max-w-[80%] flex items-end gap-1.5">
                  <div className="min-w-0 flex flex-col items-start gap-2">
                    {userAttachments.length > 0 && <UserAttachments atts={userAttachments} />}
                    {displayRun.prompt && (
                      <div className={`min-w-0 max-w-full rounded-lg px-3.5 py-2.5 leading-7 shadow-[0_2px_6px_rgba(45,34,22,0.16)] ${bubbleTone('user').surfaceClass}`} style={messageFontStyle}>
                        <MessageContent format="text" content={displayRun.prompt} />
                      </div>
                    )}
                  </div>
                  {userTimeLabel && (
                    <span className="mb-1 shrink-0 whitespace-nowrap text-[10px] leading-none text-ink-faint">
                      {userTimeLabel}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex justify-start">
                <div className={clsx('max-w-full min-w-0 flex flex-col items-start gap-1.5', isRunActive && 'w-full')}>
                  <FileLinkContext.Provider value={{ sessionId: sid, projectPath: workspace, project, engine: 'anti' }}>
                    <div className={clsx(
                      isRunActive && 'w-full',
                      'group/msg min-w-0 max-w-full relative rounded-lg px-3.5 py-3 shadow-[0_2px_6px_rgba(45,34,22,0.13)]',
                      bubbleTone('assistant').surfaceClass,
                    )}>
                      <div className="mb-2 flex min-h-6 items-center justify-between gap-3 text-[11px] font-medium text-ink-muted">
                        <span className="inline-flex shrink-0 items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-[#54735D]" />
                          Agy Agent
                        </span>
                        {displayRun.status === 'success' && displayRun.answer?.trim() && (
                          <div className="pointer-events-none flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
                            <ReplyActions text={displayRun.answer} engine="anti" project={project} canSave />
                          </div>
                        )}
                      </div>
                      {(!isRunActive || Boolean(displayRun.error || displayRun.error_detail)) && displayRun.status !== 'success' && displayRun.status !== 'cancelled' && (
                        <p role="status" className="mb-2 text-xs text-ink-muted">
                          {formatRunStatusLabel(displayRun.status)}{displayRun.error ? ` · ${displayRun.error}` : ''}
                          {displayRun.error_detail && <span className="mt-1 block text-sm text-ink">{displayRun.error_detail}</span>}
                        </p>
                      )}
                      {displayRun.fallback_notice && (
                        <p data-anti-fallback-notice role="status" className="mb-2 rounded-md border border-status-warning-line/60 bg-status-warning-soft/60 px-2.5 py-1.5 text-[11px] text-status-warning">
                          {displayRun.fallback_notice}
                        </p>
                      )}
                      <div style={messageFontStyle}>
                        <AntiTaskProgress
                          active={isRunActive}
                          loadEvents={signal => antiApi.runEvents<AntiEvent[]>(sid, run.id, signal)}
                          streamUrl={isRunActive ? resolveApiUrl(`/api/anti/sessions/${sid}/runs/${run.id}/events/stream`) : undefined}
                          runKey={`${sid}/${run.id}`}
                          onEventsChanged={handleEventsChanged}
                          onApprovalRequested={() => { void cache.invalidateQueries({ queryKey: ['anti-live', sid, run.id] }) }}
                          onStreamEnded={() => {
                            void cache.invalidateQueries({ queryKey: ['anti-live', sid, run.id] })
                            void cache.invalidateQueries({ queryKey: key })
                            void cache.invalidateQueries({ queryKey: queueKey })
                            void cache.invalidateQueries({ queryKey: sessionsKey, exact: true })
                          }}
                        >
                          {(partial, liveProgressMessages) => {
                            const persistedProgress = displayRun.progress_messages ?? []
                            const progressMessages = persistedProgress.length > 0 ? persistedProgress : liveProgressMessages
                            const finalAnswer = displayRun.answer ?? partial
                            const hasProgress = progressMessages.length > 0
                            const showFinal = Boolean(finalAnswer.trim()) || (isRunActive && !approval && !hasProgress)
                            return <>
                              {hasProgress && (
                                <section
                                  data-anti-progress-outputs
                                  aria-label="过程阶段输出"
                                  className="mb-3 rounded-lg border border-line/65 bg-bg-soft/65 px-3 py-2.5 shadow-[inset_0_1px_0_rgba(255,250,232,0.45)]"
                                >
                                  <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium text-ink-faint">
                                    <span>过程输出</span>
                                    <span className="tabular-nums">{progressMessages.length} 条</span>
                                  </div>
                                  <ul className="list-disc space-y-1.5 pl-4 text-ink-muted marker:text-accent/65">
                                    {progressMessages.map((msg, idx) => (
                                      <li key={idx} className="anti-progress-item min-w-0">
                                        <MessageContent format="markdown" content={msg} cache={!isRunActive} />
                                      </li>
                                    ))}
                                  </ul>
                                </section>
                              )}
                              {showFinal && (
                                <FileTransferConclusion.Provider value={displayRun.status === 'success' ? { engine: 'anti', project } : null}>
                                  <div
                                    data-anti-final-answer
                                    className={clsx(
                                      hasProgress && 'pt-0.5',
                                      isRunActive && !approval && 'cursor-blink',
                                    )}
                                  >
                                    {hasProgress && (
                                      <div className="mb-2 flex items-center gap-2">
                                        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft/55 px-2 py-0.5 text-[11px] font-semibold leading-none text-accent">
                                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                                          最终结论
                                        </span>
                                        <span aria-hidden="true" className="h-px flex-1 bg-line/45" />
                                      </div>
                                    )}
                                    <MessageContent format="markdown" content={finalAnswer} cache={!isRunActive} />
                                  </div>
                                </FileTransferConclusion.Provider>
                              )}
                            </>
                          }}
                        </AntiTaskProgress>
                      </div>
                      {isRunActive && approval && (
                        <div
                          data-anti-approval-inline-hint
                          className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-accent/35 bg-bg-soft/75 px-3 py-2 text-xs text-ink-muted"
                        >
                          <span className="inline-flex min-w-0 items-center gap-1.5">
                            <ShieldAlert size={14} className="shrink-0 text-accent" aria-hidden="true" />
                            <span className="truncate">
                              {approval.prompt_type === 'question' ? '等待你的选择：' : '等待审批确认：'}
                              <span className="font-medium text-ink">{approval.title}</span>
                            </span>
                          </span>
                          <button
                            type="button"
                            className="ga-btn-link shrink-0 text-[11px] font-medium text-accent"
                            onClick={() => {
                              setApprovalCollapsed(false)
                              requestAnimationFrame(() => approvalDockRef.current?.focus())
                            }}
                          >
                            查看下方操作栏
                          </button>
                        </div>
                      )}
                      {displayRun.status === 'cancelled' && (
                        <p className="mt-2 flex items-center gap-1.5 text-xs italic leading-5 text-status-warning-muted">
                          <Square size={10} className="shrink-0 fill-current" aria-hidden="true" />
                          <span>任务中止</span>
                        </p>
                      )}
                    </div>
                  </FileLinkContext.Provider>
                  {(metaParts.length > 0 || usageInfo) && (
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-0.5 text-[10px] leading-4 tabular-nums text-ink-faint">
                      {metaParts.length > 0 && <span>{metaParts.join(' · ')}</span>}
                      {metaParts.length > 0 && usageInfo && <span aria-hidden="true">·</span>}
                      {usageInfo && (
                        <span data-anti-run-usage title={usageInfo.title} className="cursor-help">
                          {usageInfo.text}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </article>
          })}
          <Errors items={[
            history.error,
            live.error,
            send.error,
            steer.error instanceof HttpError && steer.error.status === 409 ? null : steer.error,
            enqueue.error,
            removeQueued.error instanceof HttpError && removeQueued.error.status === 404 ? null : removeQueued.error,
            clearQueue.error,
            moveQueued.error,
            steerQueued.error,
            dispatchQueued.error,
            switchAndRetry.error,
            clearGrants.error,
            cancel.error,
            approve.error,
            resetAcp.error,
          ]} />
          {isRateLimited && (
            <div data-anti-rate-limit-switch className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-status-warning-line bg-status-warning-soft px-3 py-2 text-xs text-status-warning">
              <span>当前账号处于风控冷却或配额保护中，可切换至其他有额度的账号继续当前上下文。</span>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {fallbackProfile && (
                  <button
                    type="button"
                    className="ga-btn-sm-primary shrink-0"
                    disabled={switchAndRetry.isPending || Boolean(current)}
                    onClick={() => switchAndRetry.mutate(fallbackProfile.profile.id)}
                  >
                    {switchAndRetry.isPending
                      ? '切换重试中…'
                      : `一键切换到「${fallbackProfile.profile.name}」${typeof fallbackProfile.pct === 'number' ? `（剩余 ${fallbackProfile.pct}%）` : ''}并重试`}
                  </button>
                )}
                <button type="button" className="ga-btn-warning-sm shrink-0" onClick={onOpenProfiles}>
                  切换可用账号
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
    </ConversationCollapseProvider>
    {current && activeApproval && (
      <AntiApprovalDock
        dockRef={approvalDockRef}
        approval={activeApproval}
        pending={approve.isPending}
        collapsed={approvalCollapsed}
        onToggleCollapsed={() => setApprovalCollapsed(prev => !prev)}
        onDecide={(decision, optionId) =>
          approve.mutate({
            rid: current.id,
            approval_id: activeApproval.id,
            decision,
            ...(optionId ? { option_id: optionId } : {}),
          })}
      />
    )}
    {queueItems.length > 0 && (
      <AntiQueuedDock
        items={queueItems}
        paused={queuePaused}
        pauseReason={queuePauseReason}
        hasActiveRun={Boolean(current)}
        canNativeSteer={canNativeSteer}
        collapsed={queueCollapsed}
        busy={enqueue.isPending || removeQueued.isPending || clearQueue.isPending || moveQueued.isPending}
        steerPending={steerQueued.isPending}
        dispatchPending={dispatchQueued.isPending}
        pendingEditItem={pendingEditItem}
        onToggleCollapsed={() => setQueueCollapsed(prev => !prev)}
        onClearAll={() => clearQueue.mutate()}
        onMoveItem={(qid, direction) => moveQueued.mutate({ qid, direction })}
        onSteerItem={(item) => steerQueued.mutate(item.id)}
        onDispatchItem={(item) => dispatchQueued.mutate(item.id)}
        onEditItem={handleEditQueuedItem}
        onRemoveItem={(qid) => removeQueued.mutate(qid)}
        onConfirmEditStashDraft={() => {
          if (pendingEditItem) void applyEditQueuedItem(pendingEditItem, true).catch(() => undefined)
        }}
        onConfirmEditOverwriteDraft={() => {
          if (pendingEditItem) void applyEditQueuedItem(pendingEditItem, false).catch(() => undefined)
        }}
        onCancelPendingEdit={() => setPendingEditItem(null)}
      />
    )}
    <div ref={composerWrapRef}>
      <ChatComposerFrame>
        {grants.length > 0 && (
          <div data-anti-session-grants className="flex flex-wrap items-center justify-end gap-1 px-3.5 pt-2 text-[11px] text-ink-muted">
            <span>已常驻授权：</span>
            {grants.map(kind => (
              <span
                key={kind}
                className="inline-flex items-center gap-1 rounded-md border border-line/70 bg-bg-soft px-1.5 py-0.5 text-[11px] text-ink"
              >
                <span>{grantLabels[kind] ?? kind}</span>
                <button
                  type="button"
                  disabled={clearGrants.isPending}
                  aria-label={`收回 ${grantLabels[kind] ?? kind} 授权`}
                  title="收回此项授权"
                  onClick={() => clearGrants.mutate(kind)}
                  className="text-ink-muted hover:text-status-danger"
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
            <button
              type="button"
              disabled={clearGrants.isPending}
              onClick={() => clearGrants.mutate(undefined)}
              className="ga-btn-link px-1 py-0 text-[11px] text-status-danger"
            >
              全部收回
            </button>
          </div>
        )}
        <ImagePasteInput
          key={draftKey}
          text={prompt}
          onText={(value) => {
            setDismissedSlashText(null)
            setPrompt(value)
          }}
          attachments={attachments}
          onAttachments={setAttachments}
          inputLabel="发给 Agy"
          placeholder={current
            ? (activeApprovalId
              ? '当前任务正在等待上方审批确认；可提前输入下一条消息加入排队…'
              : canNativeSteer
                ? '任务运行中：Enter 加入排队，Ctrl+Enter 插话纠偏…'
                : '任务运行中，输入内容后按 Enter 加入排队，本轮结束后自动发送…')
            : '发给 Agy，输入 / 查看原生命令，可粘贴/拖放图片或文件…'}
          readOnly={Boolean(pending)}
          maxLength={24000}
          onSubmit={submit}
          submitDisabled={Boolean(current) || send.isPending || !history.isSuccess}
          activeSubmit={current && !pending ? {
            label: '加入排队',
            title: canNativeSteer
              ? '加入待发队列（Enter 加入排队 · Ctrl+Enter 插话纠偏）'
              : '加入排队，本轮结束后自动发送',
            description: '不打断当前推理，本轮成功后按顺序自动发送',
            icon: 'queue',
            disabled: enqueue.isPending || send.isPending || !history.isSuccess,
            onSubmit: queueCurrentInput,
            ...(canNativeSteer ? {
              secondary: {
                label: '插话纠偏',
                description: '立即介入当前运行中的任务',
                icon: 'send',
                shortcutHint: 'Ctrl+Enter',
                disabled: steer.isPending || send.isPending || !history.isSuccess,
                onSubmit: steerCurrentInput,
              },
            } : {}),
          } : undefined}
          slashAutocomplete={{
            open: showSlashMenu,
            ariaLabel: 'Agy 原生命令',
            items: filteredCommands.map(cmd => ({
              name: cmd.name,
              displayName: `/${cmd.name}`,
              hint: cmd.hint,
              description: cmd.description,
            })),
            emptyMessage: availableCommandCount === 0
              ? '当前没有可用的原生命令，按 Esc 关闭'
              : `未找到匹配 /${slashQuery} 的原生命令，按 Esc 关闭或继续输入`,
            footerHint: hiddenCommandCount > 0
              ? `已折叠 ${hiddenCommandCount} 个低频命令，继续输入关键词可搜索`
              : undefined,
            itemCount: filteredCommands.length,
            activeIndex: slashActiveIndex,
            onActiveIndexChange: setSlashActiveIndex,
            onSelectIndex: (idx) => {
              const picked = filteredCommands[idx]
              if (picked) applySlashCommand(picked.name)
            },
            onClose: () => {
              setDismissedSlashText(prompt)
            },
          }}
          submitAccessory={
            <div className="mb-0.5 flex shrink-0 items-center gap-1.5">
              <div ref={policyAnchorRef} className="relative shrink-0">
                <button
                  type="button"
                  disabled={Boolean(current || pending)}
                  aria-label="执行与审批模式"
                  aria-haspopup="listbox"
                  aria-expanded={policyOpen}
                  title={`${activePolicy.label}：${activePolicy.description}`}
                  onClick={() => setPolicyOpen(v => !v)}
                  className="ga-btn inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl px-2.5 text-xs font-medium leading-none text-ink"
                >
                  {mode === 'plan'
                    ? <ClipboardList size={14} className="shrink-0" aria-hidden="true" />
                    : <Pencil size={14} className="shrink-0 text-accent" aria-hidden="true" />}
                  <span>{activePolicy.triggerLabel}</span>
                  <ChevronDown size={13} className={`shrink-0 text-ink-muted transition-transform ${policyOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
                </button>
                {policyOpen && (
                  <div
                    role="listbox"
                    aria-label="执行与审批模式选项"
                    style={{ zIndex: Z_LAYERS.contextMenu }}
                    className="ga-paper-popover absolute right-0 bottom-full mb-2 w-72 rounded-xl p-1.5"
                  >
                    {EXECUTION_POLICIES.map(option => {
                      const selected = option.id === activePolicy.id
                      const isPlan = option.mode === 'plan'
                      return (
                        <button
                          key={option.id}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          onClick={() => {
                            setMode(option.mode)
                            if (option.mode === 'accept-edits') setPermissionMode(option.permissionMode)
                            setPolicyOpen(false)
                          }}
                          className={`flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${selected
                            ? 'bg-accent-soft/75 text-ink ring-1 ring-accent/30'
                            : 'hover:bg-bg-card/85 text-ink'
                            }`}
                        >
                          <span className="mt-0.5 shrink-0 text-accent">
                            {isPlan ? <ClipboardList size={14} className="text-ink-muted" aria-hidden="true" /> : <Pencil size={14} aria-hidden="true" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-xs font-semibold leading-tight">{option.label}</span>
                            <span className="mt-0.5 block text-[11px] leading-snug text-ink-muted">{option.description}</span>
                          </span>
                          {selected && <Check size={14} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          }
          submitLabel={pending && send.isError ? '查询或重试同一请求' : '发送'}
          stopActive={Boolean(current)}
          stopDisabled={cancel.isPending && (!canForceStop || Boolean(cancel.variables?.force))}
          stopTitle={canForceStop
            ? '强制终止当前任务并重置 ACP 进程'
            : (cancel.isPending ? '正在停止当前任务…' : '停止当前会话任务')}
          onStop={() => {
            if (!current) return
            cancel.mutate({ rid: current.id, force: canForceStop })
          }}
        />
        {showRecoveryBar && current && (
          <div
            data-anti-force-stop-bar
            role="status"
            className="flex flex-wrap items-center justify-between gap-2 border-t border-status-warning-line/60 bg-status-warning-soft/55 px-3 py-2 text-xs text-ink"
          >
            <span className="min-w-0 text-status-warning">
              {canForceStop
                ? '任务尚未响应停止信号，可能卡在工具执行或上游连接；强制终止会重建进程并保留多轮上下文。'
                : `已超过 ${silentSeconds} 秒未收到新输出，任务可能已卡死；可尝试强制终止或重连（保留上下文）。`}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className="ga-btn-sm-danger"
                disabled={cancel.isPending && Boolean(cancel.variables?.force)}
                onClick={() => cancel.mutate({ rid: current.id, force: true })}
              >
                {cancel.isPending && cancel.variables?.force ? '强制终止中…' : '强制终止'}
              </button>
              <button
                type="button"
                className="ga-btn-sm"
                disabled={resetAcp.isPending}
                onClick={() => resetAcp.mutate(true)}
              >
                {resetAcp.isPending ? '重连中…' : '强制重连 ACP'}
              </button>
            </div>
          </div>
        )}
        {pending && send.isError && !current && (
          <div role="status" className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-ink-muted">
            <span>无法确认请求是否已送达。重试会沿用同一请求；放弃重试不会撤回已送达的请求。</span>
            <button
              type="button"
              className="shrink-0 text-accent hover:underline"
              onClick={() => { setPending(undefined); send.reset() }}
            >
              放弃重试并继续编辑
            </button>
          </div>
        )}
      </ChatComposerFrame>
    </div>
  </>
}
