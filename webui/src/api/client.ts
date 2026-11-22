// Centralized HTTP + WS client. Browser/server and Vite proxy modes keep
// relative same-origin paths; packaged Tauri injects the owned sidecar's
// random loopback origins before this module is evaluated.
import type {
  AgentStatus,
  AutonomousReportDetailResponse,
  AutonomousReportListResponse,
  AutonomousRunListResponse,
  BtwResp,
  ChatRetryConfig,
  ConductorChatMessage,
  ConductorChatListResponse,
  ConductorActivityListResponse,
  ConductorLifecycleResponse,
  ConductorStatus,
  ConductorSubagentActionResponse,
  ConductorSubagentListResponse,
  ConductorWorkflowListResponse,
  TokenStatsResponse,
  ServicePanelResponse,
  ConductorSubagent,
  Conversation,
  ConversationDeleteResponse,
  ConversationImportResponse,
  ConversationListResponse,
  ConversationUpdateResponse,
  LLMInfo,
  MemoryTextResponse,
  MemoryWriteRequest,
  MemoryWriteResponse,
  MyKeyBackupListResponse,
  MyKeyData,
  MyKeyMutation,
  MyKeyOpenResponse,
  MyKeySession,
  MyKeySessionTestResult,
  MyKeySyncResult,
  MyKeyWriteResult,
  ProjectItem,
  RevealFileResponse,
  ResolveFileResponse,
  Schedule,
  ScheduleListResponse,
  ScheduleMutationResponse,
  ScheduleTriggerResponse,
  ScheduleType,
  ScheduledChat,
  ScheduledChatListResponse,
  SessionMessagesResponse,
  SessionRuntime,
  TaskRunListResponse,
  TaskSchedule,
  TaskScheduleListResponse,
  TaskMutationResponse,
  TaskTriggerResponse,
  TaskScheduleType,
  SetupStatus,
  SOPDetailResponse,
  SOPListResponse,
  SkillDetailResponse,
  SkillListResponse,
  UploadResult,
} from './types'
import type { components as GeneratedApiComponents } from './generated/schema'
import { resolveApiUrl } from '@/runtime/runtimeConfig'

export { ChatSocket } from '@/runtime/chatSocket'

export interface SessionMessagePageOptions {
  view?: 'desktop'
  before?: number
  limit?: number
  maxChars?: number
  /** Real human↔assistant turns per page (takes precedence over limit). */
  turns?: number
  signal?: AbortSignal
}

export class HttpError extends Error {
  status: number
  body: any
  code: 'http_error'
  constructor(status: number, body: any, message?: string) {
    super(message ?? (typeof body === 'string' ? body : JSON.stringify(body)))
    this.name = 'HttpError'
    this.code = 'http_error'
    this.status = status
    this.body = body
  }
}

export class HttpTimeoutError extends Error {
  code = 'timeout' as const
  constructor(path: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${path}`)
    this.name = 'HttpTimeoutError'
  }
}

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000
export const MYKEY_SYNC_HTTP_TIMEOUT_MS = 100_000

type HttpOptions = RequestInit & {
  timeoutMs?: number
  query?: URLSearchParams
}
export type ApiComponents = GeneratedApiComponents
type GeneratedHubSession = ApiComponents['schemas']['HubSession'] & { theme_task?: import('./types').ThemeTaskConfig | null }
type NavigationPreferences = ApiComponents['schemas']['NavPreferencesResp']
type UiSettings = ApiComponents['schemas']['UiSettingsResp']
type SessionList = Omit<ApiComponents['schemas']['SessionListResp'], 'items'> & { items: GeneratedHubSession[] }
type AbortSource = 'timeout' | 'external' | null
export type ConductorSubagentModelPolicy = 'follow_main' | 'default' | 'locked'
export interface ConductorModelSettings {
  llmIndex?: number | null
  subagentLlmIndex?: number | null
  subagentModelPolicy?: ConductorSubagentModelPolicy
}
export type ConductorActionVersion = {
  expected_boot_id?: string
  expected_generation?: number
  expected_command_revision?: number
}

function requestAbortContext(externalSignal: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let source: AbortSource = null
  const abort = (nextSource: Exclude<AbortSource, null>) => {
    if (controller.signal.aborted) return
    source = nextSource
    controller.abort()
  }
  const timeout = window.setTimeout(() => abort('timeout'), timeoutMs)
  const abortFromExternal = () => abort('external')
  if (externalSignal?.aborted) abortFromExternal()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })

  return {
    signal: controller.signal,
    source: () => source,
    cleanup: () => {
      window.clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abortFromExternal)
    },
  }
}

/** One id per logical mutating call; the conductor boundary replays it. */
function newOperationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

async function http<T>(method: string, path: string, body?: unknown, init?: HttpOptions): Promise<T> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, signal: externalSignal, query, ...requestInit } = init ?? {}
  const abortContext = requestAbortContext(externalSignal, timeoutMs)
  const queryString = query?.toString()
  const requestPath = queryString
    ? `${path}${path.includes('?') ? '&' : '?'}${queryString}`
    : path

  try {
    const res = await fetch(resolveApiUrl(requestPath), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      ...requestInit,
      signal: abortContext.signal,
    })
    if (!res.ok) {
      let msg: any = null
      if (typeof res.text === 'function') {
        msg = await res.text()
        try { msg = JSON.parse(msg) } catch { }
      } else if (typeof res.json === 'function') {
        msg = await res.json().catch(() => null)
      }
      throw new HttpError(res.status, msg)
    }
    if (res.status === 204) return undefined as unknown as T
    const ct = res.headers?.get?.('content-type') || ''
    // Keep the abort signal and deadline active until the response body is read.
    if (ct.includes('application/json') || (!ct && typeof res.json === 'function' && typeof res.text !== 'function')) {
      return (await res.json()) as T
    }
    return (await res.text()) as unknown as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (abortContext.source() === 'external') throw error
      if (abortContext.source() === 'timeout') throw new HttpTimeoutError(requestPath, timeoutMs)
    }
    if (error instanceof TypeError) {
      const networkError = new Error(`Network request failed: ${requestPath}`)
      networkError.name = 'NetworkError'
        ; (networkError as Error & { code: string }).code = 'network_error'
      throw networkError
    }
    throw error
  } finally {
    abortContext.cleanup()
  }
}

type ConductorOperation = ApiComponents['schemas']['ConductorOperationResp']
type PendingConductorOperation = { id: string; body: Record<string, unknown> }
const pendingConductorOperations = new Map<string, PendingConductorOperation>()
const pendingOperationStorageKey = 'conductor.pendingOperations.v1'

function persistConductorOperations() {
  try {
    sessionStorage.setItem(pendingOperationStorageKey, JSON.stringify([...pendingConductorOperations]))
  } catch { /* In-memory identities still cover retries when storage is unavailable. */ }
}

async function conductorWrite<T>(path: string, body: Record<string, unknown>, init?: HttpOptions): Promise<T> {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(pendingOperationStorageKey) || '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved) {
        if (Array.isArray(entry) && typeof entry[0] === 'string') {
          const value = entry[1]
          if (value && typeof value.id === 'string' && value.body && typeof value.body === 'object') {
            pendingConductorOperations.set(entry[0], value)
          } else if (typeof value === 'string') {
            const [, originalBody] = JSON.parse(entry[0])
            if (originalBody && typeof originalBody === 'object') {
              pendingConductorOperations.set(entry[0], { id: value, body: originalBody })
            }
          }
        }
      }
    }
  } catch { /* Storage is optional; invalid data cannot supply an operation id. */ }
  // Snapshot updates must not change an unconfirmed command's identity or guards.
  const intent = Object.fromEntries(Object.entries(body).filter(([key]) => !key.startsWith('expected_')))
  const key = JSON.stringify([resolveApiUrl(path), intent])
  const pending = pendingConductorOperations.get(key) || { id: newOperationId(), body }
  const operationId = pending.id
  pendingConductorOperations.set(key, pending)
  persistConductorOperations()
  const complete = (result: T) => {
    pendingConductorOperations.delete(key)
    persistConductorOperations()
    return result
  }
  try {
    return complete(await http<T>('POST', path, { ...pending.body, operation_id: operationId }, init))
  } catch (error) {
    const detail = error instanceof HttpError ? error.body?.detail ?? error.body : undefined
    const uncertain = !(error instanceof HttpError) || error.status >= 500
      || ['operation_in_progress', 'operation_unknown', 'recovery_pending'].includes(detail?.error)
      || detail?.operation_state === 'unknown'
    if (uncertain) {
      try {
        const receipt = await http<ConductorOperation>('GET', `/api/conductor/operations/${encodeURIComponent(operationId)}`)
        if (receipt.state === 'succeeded' && receipt.result) return complete(receipt.result as T)
        if (receipt.state === 'rejected') complete(undefined as T)
      } catch { /* Keep the original id and original error for the next retry. */ }
    } else {
      complete(undefined as T)
    }
    throw error
  }
}

export const api = {
  // ── setup (always available, even in setup mode) ────
  setupStatus: () => http<SetupStatus>('GET', '/api/setup/status'),
  setupValidate: (ga_root: string) =>
    http<{ valid: boolean; resolved: string }>('POST', '/api/setup/validate', { ga_root }),
  setupSave: (ga_root: string, python_path?: string) =>
    http<{ ok: boolean; ga_root: string; python_path: string | null; resolved_python: string | null; resolved_python_source: string; restart_required: boolean }>(
      'POST',
      '/api/setup/save',
      { ga_root, python_path },
    ),

  // ── persistent UI preferences ────────────────────────
  navigationPreferences: () =>
    http<NavigationPreferences>('GET', '/api/preferences/navigation'),
  saveNavigationPreferences: (preferences: Array<{ id: string; visible: boolean }>) =>
    http<NavigationPreferences>(
      'PUT',
      '/api/preferences/navigation',
      { preferences },
    ),
  uiPreferences: () =>
    http<UiSettings>('GET', '/api/preferences/ui'),
  saveUiPreferences: (settings: Record<string, string | null>) =>
    http<UiSettings>('PUT', '/api/preferences/ui', { settings }),

  // ── agent ────────────────────────────────────────────
  agentStatus: (init?: Pick<RequestInit, 'signal'>) =>
    http<AgentStatus>('GET', '/api/agent/status', undefined, init),
  chatRetryConfig: () => http<ChatRetryConfig>('GET', '/api/agent/chat-retry-config'),
  saveChatRetryConfig: (cfg: ChatRetryConfig) =>
    http<ChatRetryConfig>('PUT', '/api/agent/chat-retry-config', cfg),

  // ── llms ─────────────────────────────────────────────
  llms: () => http<{ llms: LLMInfo[] }>('GET', '/api/llms'),
  switchLLM: (index: number) => http<{ llm_no: number; name: string }>('POST', '/api/llms/switch', { index }),

  // ── mykey.py editor ──────────────────────────────────
  mykey: () => http<MyKeyData>('GET', '/api/mykey'),
  putMyKeyRaw: (raw: string) => http<MyKeyWriteResult>('PUT', '/api/mykey/raw', { raw }),
  mutateMyKey: (mutation: MyKeyMutation) =>
    http<MyKeyWriteResult>('POST', '/api/mykey/mutation', mutation),
  mykeyBackups: () => http<MyKeyBackupListResponse>('GET', '/api/mykey/backups'),
  restoreMyKeyBackup: (name: string) =>
    http<MyKeyWriteResult>('POST', `/api/mykey/backups/${encodeURIComponent(name)}/restore`),
  testMyKeySession: (varName: string) =>
    http<MyKeySessionTestResult>('POST', `/api/mykey/sessions/${encodeURIComponent(varName)}/test`),
  myKeyAutoSync: () => http<import('./types').MyKeyAutoSyncStatus>('GET', '/api/mykey/sync/auto'),
  setMyKeyAutoSync: (enabled: boolean) => http<import('./types').MyKeyAutoSyncStatus>('PUT', '/api/mykey/sync/auto', { enabled }),
  openMyKeyFile: () => http<MyKeyOpenResponse>('POST', '/api/mykey/open'),
  uploadMyKeySync: () => http<MyKeySyncResult>(
    'POST', '/api/mykey/sync/upload', undefined, { timeoutMs: MYKEY_SYNC_HTTP_TIMEOUT_MS },
  ),
  fetchMyKeySync: () => http<MyKeySyncResult>(
    'POST', '/api/mykey/sync/fetch', undefined, { timeoutMs: MYKEY_SYNC_HTTP_TIMEOUT_MS },
  ),

  // ── conversations ────────────────────────────────────
  conversations: (q?: string, offset = 0, limit = 50) => {
    const sp = new URLSearchParams()
    if (q) sp.set('q', q)
    sp.set('offset', String(offset))
    sp.set('limit', String(limit))
    return http<ConversationListResponse>(
      'GET', `/api/conversations?${sp}`)
  },
  conversation: (id: string) => http<Conversation>('GET', `/api/conversations/${encodeURIComponent(id)}`),
  updateConversation: (id: string, title: string) =>
    http<ConversationUpdateResponse>('PATCH', `/api/conversations/${encodeURIComponent(id)}`, { title }),
  deleteConversation: (id: string) =>
    http<ConversationDeleteResponse>('DELETE', `/api/conversations/${encodeURIComponent(id)}`),
  exportConversation: (id: string, format: 'md' | 'json') =>
    resolveApiUrl(`/api/conversations/${encodeURIComponent(id)}/export?format=${format}`),
  // Mint a session that owns a cleaned copy of the archive (source read-only).
  // Conflicts carry a `code` (archive_already_bound / archive_not_importable)
  // the history page maps to its own message.
  importConversation: (id: string) =>
    http<ConversationImportResponse>('POST', `/api/conversations/${encodeURIComponent(id)}/import`),

  // ── memory ───────────────────────────────────────────
  globalMem: () => http<MemoryTextResponse>('GET', '/api/memory/global'),
  setGlobalMem: (body: MemoryWriteRequest) => http<MemoryWriteResponse>('PUT', '/api/memory/global', body),
  insight: () => http<MemoryTextResponse>('GET', '/api/memory/insight'),
  setInsight: (body: MemoryWriteRequest) => http<MemoryWriteResponse>('PUT', '/api/memory/insight', body),
  sops: () => http<SOPListResponse>('GET', '/api/memory/sops'),
  sop: (name: string) => http<SOPDetailResponse>('GET', `/api/memory/sops/${encodeURIComponent(name)}`),
  setSop: (name: string, body: MemoryWriteRequest) =>
    http<MemoryWriteResponse>('PUT', `/api/memory/sops/${encodeURIComponent(name)}`, body),

  skills: (limit = 200) => http<SkillListResponse>('GET', `/api/memory/skills?limit=${limit}`),
  skill: (path: string) => http<SkillDetailResponse>('GET', `/api/memory/skills/read?path=${encodeURIComponent(path)}`),

  // ── autonomous ───────────────────────────────────────
  schedules: () => http<ScheduleListResponse>('GET', '/api/autonomous/schedules'),
  upsertSchedule: (s: Partial<Schedule> & { type: ScheduleType }) =>
    http<Schedule>('POST', '/api/autonomous/schedules', s),
  deleteSchedule: (id: string) => http<ScheduleMutationResponse>('DELETE', `/api/autonomous/schedules/${id}`),
  triggerSchedule: (id: string) => http<ScheduleTriggerResponse>('POST', `/api/autonomous/schedules/${id}/trigger`),
  runs: (limit = 100) => http<AutonomousRunListResponse>('GET', `/api/autonomous/runs?limit=${limit}`),
  reports: () => http<AutonomousReportListResponse>('GET', '/api/autonomous/reports'),
  report: (name: string) => http<AutonomousReportDetailResponse>('GET', `/api/autonomous/reports/${encodeURIComponent(name)}`),

  // ── scheduled tasks ──────────────────────────────────
  taskSchedules: () => http<TaskScheduleListResponse>('GET', '/api/tasks/schedules'),
  upsertTaskSchedule: (s: Partial<TaskSchedule> & { type: TaskScheduleType }) =>
    http<TaskSchedule>('POST', '/api/tasks/schedules', s),
  deleteTaskSchedule: (id: string) => http<TaskMutationResponse>('DELETE', `/api/tasks/schedules/${id}`),
  triggerTaskSchedule: (id: string) => http<TaskTriggerResponse>('POST', `/api/tasks/schedules/${id}/trigger`),
  taskRuns: (limit = 100) => http<TaskRunListResponse>('GET', `/api/tasks/runs?limit=${limit}`),

  // ── upload ───────────────────────────────────────────
  upload: async (file: File, init?: Pick<HttpOptions, 'signal' | 'timeoutMs'>): Promise<UploadResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, signal: externalSignal } = init ?? {}
    const abortContext = requestAbortContext(externalSignal, timeoutMs)
    try {
      const res = await fetch(resolveApiUrl('/api/upload'), { method: 'POST', body: fd, signal: abortContext.signal })
      if (!res.ok) throw new HttpError(res.status, await res.text())
      const result = await res.json() as UploadResult
      return { ...result, url: resolveApiUrl(result.url) }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (abortContext.source() === 'external') throw error
        if (abortContext.source() === 'timeout') throw new HttpTimeoutError('/api/upload', timeoutMs)
      }
      if (error instanceof TypeError) {
        const networkError = new Error('Network request failed: /api/upload')
        networkError.name = 'NetworkError'
          ; (networkError as Error & { code: string }).code = 'network_error'
        throw networkError
      }
      throw error
    } finally {
      abortContext.cleanup()
    }
  },
  fileUrlByPath: (absPath: string) =>
    resolveApiUrl(`/api/files-by-path?path=${encodeURIComponent(absPath)}`),
  revealFile: (path: string, mode: 'open' | 'folder' | 'parent' = 'open', sessionId?: string) =>
    http<RevealFileResponse>('POST', '/api/files/reveal', { path, mode, session_id: sessionId }),
  resolveFile: (path: string, sessionId?: string, engine?: 'chat' | 'anti') =>
    http<ResolveFileResponse>('POST', '/api/files/resolve', { path, session_id: sessionId, engine }),


  // ── conductor ────────────────────────────────────────
  conductorChat: (last = 50) => http<ConductorChatListResponse>('GET', `/api/conductor/chat?last=${last}`),
  conductorSendChat: (
    msg: string,
    role: 'user' | 'assistant' = 'user',
    models: ConductorModelSettings = {},
    // Continuity: when set to the request id of an open workflow, the hub
    // appends to that workflow instead of admitting a new task. Undefined or
    // unknown ids keep the legacy fresh-admission behavior.
    requestId?: string,
    antiProject?: string,
  ) =>
    // Cold-starting gahub_app can legitimately take longer than the generic
    // 30s request budget. The server cannot cancel admission after a client
    // timeout, so avoid presenting a still-running request as a clean failure.
    conductorWrite<ConductorChatMessage>('/api/conductor/chat', {
      msg,
      role,
      ...(requestId ? { request_id: requestId } : {}),
      ...(antiProject ? { anti_project: antiProject } : {}),
      llm_index: models.llmIndex,
      subagent_llm_index: models.subagentLlmIndex,
      subagent_model_policy: models.subagentModelPolicy,
    }, { timeoutMs: 120_000 }),
  conductorSubagents: () => http<ConductorSubagentListResponse>('GET', '/api/conductor/subagent'),
  // Durable 动态 timeline for one task. The tab used to be a live-only SSE
  // projection, so a task reopened from history showed nothing; this is the
  // read that survives a reload. `beforeMs` pages backwards for scroll-up.
  conductorActivity: (requestId: string, opts: { limit?: number; beforeMs?: number } = {}) => {
    const limit = opts.limit ?? 200
    const before = typeof opts.beforeMs === 'number' ? `&before_ms=${opts.beforeMs}` : ''
    return http<ConductorActivityListResponse>(
      'GET',
      `/api/conductor/activity?request_id=${encodeURIComponent(requestId)}&limit=${limit}${before}`,
    )
  },
  // The history bar lists every retained task, so pull the route's full
  // window instead of the server's 20-item default.
  conductorWorkflows: () => http<ConductorWorkflowListResponse>('GET', '/api/conductor/workflow?last=100'),
  conductorDeleteWorkflow: (requestId: string) =>
    http<{ ok: boolean; request_id: string }>('DELETE', `/api/conductor/workflow/${requestId}`),
  conductorSubagent: (sid: string, max_len = 5000) => http<ConductorSubagent>('GET', `/api/conductor/subagent/${sid}?max_len=${max_len}`),
  conductorSubagentAction: (
    sid: string,
    action: 'keyinfo' | 'input' | 'reply' | 'append' | 'message' | 'msg' | 'accept' | 'rework' | 'abort' | 'stop',
    msg: string,
    llm_index?: number | null,
    models: ConductorModelSettings = {},
    force = false,
    expected: ConductorActionVersion = {},
  ) =>
    conductorWrite<ConductorSubagentActionResponse>(`/api/conductor/subagent/${sid}`, {
      action,
      msg,
      llm_index,
      conductor_llm_index: models.llmIndex,
      subagent_llm_index: models.subagentLlmIndex,
      subagent_model_policy: models.subagentModelPolicy,
      force,
      ...expected,
    }),
  conductorOperation: (operationId: string) =>
    http<ConductorOperation>('GET', `/api/conductor/operations/${encodeURIComponent(operationId)}`),
  tokenStats: () => http<TokenStatsResponse>('GET', '/api/tokens/stats'),
  servicePanel: () => http<ServicePanelResponse>('GET', '/api/services/panel'),
  conductorStatus: () => http<ConductorStatus>('GET', '/api/conductor/status'),
  conductorSettings: (autoAccept: boolean) =>
    http<ConductorStatus>('POST', '/api/conductor/settings', { auto_accept: autoAccept }),
  conductorStart: (models: ConductorModelSettings = {}) =>
    http<ConductorLifecycleResponse>('POST', '/api/conductor/start', {
      llm_index: models.llmIndex,
      subagent_llm_index: models.subagentLlmIndex,
      subagent_model_policy: models.subagentModelPolicy,
    }),
  conductorResumeWorkflow: (requestId: string) =>
    http<ConductorLifecycleResponse>('POST', `/api/conductor/workflow/${encodeURIComponent(requestId)}/resume`),
  sessions: () => http<SessionList>('GET', '/api/sessions'),
  themeConfig: (id: string, theme_task: import('./types').ThemeTaskConfig | null, title?: string) => http<GeneratedHubSession>('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { theme_task, ...(title === undefined ? {} : { title }) }),
  themeRun: (id: string) => http<{ run: import('./types').ThemeRun | null }>('GET', `/api/sessions/${encodeURIComponent(id)}/theme-run`),
  startThemeRun: (id: string, text: string) => http<SessionRuntime>('POST', `/api/sessions/${encodeURIComponent(id)}/theme-run`, { text }),
  createSession: (req: Partial<ApiComponents['schemas']['SessionCreate']> = {}) =>
    http<GeneratedHubSession>('POST', '/api/sessions', req),
  updateSession: (id: string, changes: { title?: string; llm_key?: string | null }) =>
    http<GeneratedHubSession>('PATCH', `/api/sessions/${encodeURIComponent(id)}`, changes),
  deleteSession: (id: string) =>
    http<void>('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  projects: () => http<{ total: number; items: ProjectItem[] }>('GET', '/api/projects'),
  createProject: (path: string, display_name?: string) =>
    http<ProjectItem>('POST', '/api/projects', { path, display_name }),
  deleteProject: (name: string) =>
    http<void>('DELETE', `/api/projects/${encodeURIComponent(name)}`),
  bindProject: (id: string, name: string, path: string) =>
    http<GeneratedHubSession>('PUT', `/api/sessions/${encodeURIComponent(id)}/project`, { name, path }),
  unbindProject: (id: string) =>
    http<GeneratedHubSession>('DELETE', `/api/sessions/${encodeURIComponent(id)}/project`),
  sessionRun: (id: string, text: string, images: string[] = [], attachments: { path: string; name: string; source?: 'local_ref' | 'managed_upload'; size: number }[] = []) =>
    http<SessionRuntime>('POST', `/api/sessions/${encodeURIComponent(id)}/runs`, { text, images, attachments }),
  sessionRuntime: (id: string) =>
    http<SessionRuntime>('GET', `/api/sessions/${encodeURIComponent(id)}/runtime`),
  sessionRuntimes: () =>
    http<Record<string, SessionRuntime>>('GET', '/api/session-runtimes'),
  getSessionMessages: (id: string, options: SessionMessagePageOptions = {}) => {
    const query = new URLSearchParams()
    if (options.view !== undefined) query.set('view', options.view)
    if (options.before !== undefined) query.set('before', String(options.before))
    if (options.limit !== undefined) query.set('limit', String(options.limit))
    if (options.maxChars !== undefined) query.set('max_chars', String(options.maxChars))
    if (options.turns !== undefined) query.set('turns', String(options.turns))
    return http<SessionMessagesResponse>(
      'GET',
      `/api/sessions/${encodeURIComponent(id)}/messages`,
      undefined,
      { signal: options.signal, query },
    )
  },
  sessionBtw: (id: string, text: string) =>
    http<BtwResp>('POST', `/api/sessions/${encodeURIComponent(id)}/btw`, { text }),
  rewindSession: (id: string, req: { sid?: string; n?: number }) =>
    http<{ removed_sids: string[]; kept: number; history_lines: number }>(
      'POST',
      `/api/sessions/${encodeURIComponent(id)}/rewind`,
      req,
    ),
  updateSessionModel: (id: string, llm_key: string | null) =>
    http<GeneratedHubSession>(
      'PUT',
      `/api/sessions/${encodeURIComponent(id)}/model`,
      { llm_key },
    ),
  abortSession: (id: string) =>
    http<SessionRuntime>('POST', `/api/sessions/${encodeURIComponent(id)}/abort`),
  scheduledChats: (id: string) =>
    http<ScheduledChatListResponse>('GET', `/api/sessions/${encodeURIComponent(id)}/scheduled-chats`),
  createScheduledChat: (id: string, text: string, images: string[], scheduled_for: number, attachments: { path: string; name: string; source?: 'local_ref' | 'managed_upload'; size: number }[] = []) =>
    http<ScheduledChat>('POST', `/api/sessions/${encodeURIComponent(id)}/scheduled-chats`, {
      text,
      images,
      scheduled_for,
      attachments,
    }),
  cancelScheduledChat: (id: string, taskId: string) =>
    http<void>('DELETE', `/api/sessions/${encodeURIComponent(id)}/scheduled-chats/${encodeURIComponent(taskId)}`),

  conductorStop: () => http<ConductorLifecycleResponse>('POST', '/api/conductor/stop'),
}

// Local-only Nova settings. Never persist account passwords or cloud cookies.
export type NovaStatus = ApiComponents['schemas']['NovaStatusResp']
export interface NovaAccountInput {
  username: string
  password: string
  name: string
  invite?: string
  confirm: boolean
}
export const novaApi = {
  status: () => http<NovaStatus>('GET', '/nova/settings', undefined, { cache: 'no-store' }),
  action: async (action: 'associate' | 'revoke' | 'reconnect', body?: NovaAccountInput) => {
    const state = await novaApi.status()
    if (!state.local_token) throw new Error('本机授权令牌不可用')
    const options = {
      timeoutMs: 120000,
      headers: { 'Content-Type': 'application/json', 'X-Nova-Local': state.local_token },
    }
    if (action === 'associate') return http<NovaStatus>('POST', '/nova/associate', body ?? {}, options)
    if (action === 'revoke') return http<NovaStatus>('POST', '/nova/revoke', body ?? {}, options)
    return http<NovaStatus>('POST', '/nova/reconnect', {}, options)
  },
}

export type UpdatePlan = ApiComponents['schemas']['UpdatePlanResp']
export type UpdateDownload = ApiComponents['schemas']['UpdateDownloadResp']
export type UpdateStatus = ApiComponents['schemas']['UpdateStatusResp']
export type UpdateRelease = ApiComponents['schemas']['UpdateReleaseResp']
export const updateApi = {
  release: () => http<UpdateRelease>('GET', '/api/updates/release', undefined, { timeoutMs: 90000 }),
  download: () => http<UpdateDownload>('POST', '/api/updates/release/download', {}, { timeoutMs: 15000 }),
  status: () => http<UpdateStatus>('GET', '/api/updates'),
  prepare: (archive: string, sha256: string, trusted: boolean) =>
    http<UpdatePlan>('POST', '/api/updates/prepare', {
      archive, sha256, trusted_source_confirmed: trusted,
    }, { timeoutMs: 180000 }),
  preflight: (id: string) => http('POST', '/api/updates/preflight', { id }, { timeoutMs: 240000 }),
  cancel: (id: string) => http<UpdatePlan>('POST', '/api/updates/cancel', { id }),
  request: (id: string) => http('POST', '/api/updates/request', { id }),
  approve: (id: string) => http('POST', '/api/updates/approve', { id }),
}

export type FontSettings = ApiComponents['schemas']['FontSettingsResp']
export type FontPackInfo = ApiComponents['schemas']['FontPackInfoResp']
export type FontPackManifest = ApiComponents['schemas']['FontPackManifestResp']

export const fontApi = {
  settings: () => http<FontSettings>('GET', '/api/appearance/fonts'),
  download: (packId: string) => http<FontSettings>('POST', '/api/appearance/fonts/download', { pack_id: packId }),
  activate: (packId: string) => http<FontSettings>('POST', '/api/appearance/fonts/activate', { pack_id: packId }),
  updatePreferences: (boldStyle: 'restrained' | 'standard') =>
    http<FontSettings>('PUT', '/api/appearance/fonts/preferences', { bold_style: boldStyle }),
  deletePack: (packId: string) => http<FontSettings>('DELETE', `/api/appearance/fonts/${encodeURIComponent(packId)}`),
  manifest: (packId: string) => http<FontPackManifest>('GET', `/api/appearance/fonts/packs/${encodeURIComponent(packId)}/manifest`),
  importFile: async (file: File): Promise<FontSettings> => {
    const fd = new FormData()
    fd.append('file', file)
    const abortContext = requestAbortContext(undefined, 60_000)
    try {
      const res = await fetch(resolveApiUrl('/api/appearance/fonts/import'), {
        method: 'POST',
        body: fd,
        signal: abortContext.signal,
      })
      if (!res.ok) throw new HttpError(res.status, await res.text())
      return await res.json() as FontSettings
    } finally {
      abortContext.cleanup()
    }
  },
}

export type AntiDaemonStatus = ApiComponents['schemas']['AntiDaemonStatus']
export type AntiSession = ApiComponents['schemas']['AntiSessionResp']
export type AntiRun = ApiComponents['schemas']['AntiRunResp']
export type AntiApprovalPrompt = ApiComponents['schemas']['AntiApprovalPrompt']
export type AntiStep = ApiComponents['schemas']['AntiStep']
export type AntiModels = ApiComponents['schemas']['AntiModelList']
export type AntiCommandItem = ApiComponents['schemas']['AntiCommandItem']
export type AntiCommandList = ApiComponents['schemas']['AntiCommandList']
export type AntiRunUsage = ApiComponents['schemas']['AntiRunUsage']
export type AntiAccountUsage = ApiComponents['schemas']['AntiAccountUsage']
export type AntiQuotaPool = ApiComponents['schemas']['AntiQuotaPool']
export type AntiUsageStats = ApiComponents['schemas']['AntiUsageStats']
export type AntiDaemonLogs = ApiComponents['schemas']['AntiDaemonLogsResp']
export type AgyProfile = ApiComponents['schemas']['AgyProfile']
export type AgyProfileUsageSnapshot = ApiComponents['schemas']['AgyProfileUsageSnapshot']
export type AgyProfiles = ApiComponents['schemas']['AgyProfiles']
export type AgyCodeLoginState = ApiComponents['schemas']['AgyCodeLoginState']
export type AntiAttachmentRef = ApiComponents['schemas']['AttachmentRef']
export type AntiMode = 'plan' | 'accept-edits'
export type AntiPermissionMode = 'approval-required' | 'auto-accept-edits' | 'auto' | 'full-access'
export type AntiSubmission = {
  prompt: string
  operation: string
  model: string
  effort: string
  mode?: AntiMode
  permission_mode?: AntiPermissionMode
  references?: { id: number; path: string }[]
  attachments?: AntiAttachmentRef[]
}

async function antiHttp<T>(method: string, path: string, body?: unknown, init?: HttpOptions): Promise<T> {
  try {
    return await http<T>(method, path, body, init)
  } catch (error) {
    if (error instanceof HttpError) {
      const detail = typeof error.body?.detail === 'string'
        ? error.body.detail
        : `Anti 请求失败 (${error.status})`
      throw new HttpError(error.status, error.body, detail)
    }
    throw error
  }
}

export const antiApi = {
  daemonStatus: (signal?: AbortSignal) =>
    antiHttp<AntiDaemonStatus>('GET', '/api/anti/status', undefined, {
      signal,
      headers: { 'X-GA-Hub-Action': 'verify-anti-auth' },
    }),
  daemonStart: () =>
    antiHttp<AntiDaemonStatus>('POST', '/api/anti/start', undefined, {
      headers: { 'X-GA-Hub-Action': 'start-anti' },
    }),
  daemonStop: () =>
    antiHttp<AntiDaemonStatus>('POST', '/api/anti/stop', undefined, {
      headers: { 'X-GA-Hub-Action': 'stop-anti' },
    }),
  daemonRestart: () =>
    antiHttp<AntiDaemonStatus>('POST', '/api/anti/restart', undefined, {
      headers: { 'X-GA-Hub-Action': 'restart-anti' },
    }),
  daemonLogs: (lines = 80, signal?: AbortSignal) =>
    antiHttp<AntiDaemonLogs>('GET', `/api/anti/logs?lines=${lines}`, undefined, { signal }),
  profiles: (signal?: AbortSignal) =>
    antiHttp<AgyProfiles>('GET', '/api/anti/profiles', undefined, { signal }),
  captureProfile: (name: string) =>
    antiHttp<AgyProfile>('POST', '/api/anti/profiles/capture', { name }, {
      headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' },
    }),
  deleteProfile: (id: string) =>
    antiHttp<void>('DELETE', `/api/anti/profiles/${encodeURIComponent(id)}`, undefined, {
      headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' },
    }),
  clearProfileCredentials: (id: string) =>
    antiHttp<AgyProfile>('POST', `/api/anti/profiles/${encodeURIComponent(id)}/logout`, undefined, {
      headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' },
    }),
  accountUsage: () =>
    antiHttp<AntiAccountUsage>('POST', '/api/anti/account-usage', undefined, {
      headers: { 'X-GA-Hub-Action': 'check-anti-usage' },
    }),
  quota: (signal?: AbortSignal) =>
    antiHttp<AntiQuotaPool[]>('GET', '/api/anti/quota', undefined, { signal }),
  resetBreaker: (modelGroup?: string) =>
    antiHttp<void>('POST', '/api/anti/breaker/reset', { model_group: modelGroup ?? null }, {
      headers: { 'X-GA-Hub-Action': 'manage-anti-gateway' },
    }),
  calibrateQuota: (modelGroup: string, remainingPct: number, note?: string) =>
    antiHttp<AntiQuotaPool>('POST', '/api/anti/quota/calibrate', {
      model_group: modelGroup,
      remaining_pct: remainingPct,
      note: note ?? null,
    }, {
      headers: { 'X-GA-Hub-Action': 'manage-anti-gateway' },
    }),
  stats: (windowHours = 24, signal?: AbortSignal) =>
    antiHttp<AntiUsageStats>('GET', `/api/anti/stats?window_hours=${windowHours}`, undefined, { signal }),
  models: (signal?: AbortSignal) =>
    // Allow the gateway attempt (2s connect + 23s read) and the 24s CLI fallback.
    antiHttp<AntiModels>('GET', '/api/anti/models', undefined, { signal, timeoutMs: 60_000 }),
  commands: (signal?: AbortSignal) =>
    antiHttp<AntiCommandList>('GET', '/api/anti/commands', undefined, { signal }),
  sessions: (signal?: AbortSignal) =>
    antiHttp<AntiSession[]>('GET', '/api/anti/sessions', undefined, { signal }),
  createSession: (project: string) =>
    antiHttp<AntiSession>('POST', '/api/anti/sessions', { project }),
  renameSession: (id: string, title: string) =>
    antiHttp<AntiSession>('PATCH', `/api/anti/sessions/${id}`, { title }),
  resetSession: (id: string) =>
    antiHttp<AntiSession>('POST', `/api/anti/sessions/${id}/reset`, {}),
  deleteSession: (id: string) =>
    antiHttp<void>('DELETE', `/api/anti/sessions/${id}`),
  runs: (sessionId: string, signal?: AbortSignal) =>
    antiHttp<AntiRun[]>('GET', `/api/anti/sessions/${sessionId}/runs`, undefined, { signal }),
  run: (sessionId: string, runId: string, signal?: AbortSignal) =>
    antiHttp<AntiRun>('GET', `/api/anti/sessions/${sessionId}/runs/${runId}`, undefined, { signal }),
  runEvents: <T = unknown[]>(sessionId: string, runId: string, signal?: AbortSignal) =>
    antiHttp<T>('GET', `/api/anti/sessions/${sessionId}/runs/${runId}/events`, undefined, { signal }),
  submitRun: (sessionId: string, body: AntiSubmission) =>
    antiHttp<AntiRun>('POST', `/api/anti/sessions/${sessionId}/runs`, body),
  cancelRun: (sessionId: string, runId: string) =>
    antiHttp<AntiRun>('POST', `/api/anti/sessions/${sessionId}/runs/${runId}/cancel`, {}),
  approveRun: (
    sessionId: string,
    runId: string,
    body: { approval_id: string; decision: 'allow' | 'allow_always' | 'reject'; option_id?: string },
  ) =>
    antiHttp<AntiRun>('POST', `/api/anti/sessions/${sessionId}/runs/${runId}/approval`, body, {
      headers: { 'X-GA-Hub-Action': 'approve-agy' },
    }),
  startCodeLogin: (profileId: string) =>
    antiHttp<AgyCodeLoginState>('POST', `/api/anti/profiles/${encodeURIComponent(profileId)}/login/start`, undefined, {
      headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' },
    }),
  codeLoginStatus: (flowId: string, signal?: AbortSignal) =>
    antiHttp<AgyCodeLoginState>('GET', `/api/anti/profiles/login/status/${encodeURIComponent(flowId)}`, undefined, { signal }),
  submitCodeLogin: (flowId: string, code: string) =>
    antiHttp<AgyCodeLoginState>('POST', `/api/anti/profiles/login/submit/${encodeURIComponent(flowId)}`, { code }, {
      headers: { 'X-GA-Hub-Action': 'manage-agy-profiles' },
    }),
}
