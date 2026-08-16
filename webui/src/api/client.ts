// Centralized HTTP + WS client. Vite dev proxy forwards /api and /ws to
// the FastAPI backend, so no base URL is needed in dev. In Tauri/prod
// the backend serves the SPA itself, also same-origin.
import type {
  AgentStatus,
  AutonomousReportDetailResponse,
  AutonomousReportListResponse,
  AutonomousRun,
  AutonomousRunListResponse,
  BusEvent,
  BtwResp,
  ChatRetryConfig,
  ChatWSIn,
  ChatWSOut,
  ConductorChatMessage,
  ConductorChatListResponse,
  ConductorLifecycleResponse,
  ConductorLogItem,
  ConductorLogResponse,
  ConductorMutationResponse,
  ConductorStatus,
  ConductorSubagentActionResponse,
  ConductorSubagentInstructionResponse,
  ConductorSubagentListResponse,
  ConductorTextResponse,
  TokenStatsResponse,
  TokenHistoryResponse,
  ServicePanelResponse,
  ConductorSubagent,
  Conversation,
  ConversationDeleteResponse,
  ConversationListResponse,
  ConversationSummary,
  ConversationRestoreResponse,
  ConversationUpdateResponse,
  EmailConfig,
  EmailTestResponse,
  EventRecentResponse,
  FsCheckResult,
  FsKeysResponse,
  FsSendResponse,
  FsStartResponse,
  FsStatus,
  FsStopResponse,
  LLMInfo,
  LogLinesResponse,
  LLMTestResult,
  MemoryTextResponse,
  MemoryWriteResponse,
  MyKeyBackup,
  MyKeyBackupListResponse,
  MyKeyData,
  MyKeyOpenResponse,
  MyKeySession,
  MyKeySessionTestResult,
  MyKeySyncResult,
  MyKeyWriteResult,
  ProjectItem,
  ReportItem,
  RevealFileResponse,
  Schedule,
  ScheduleListResponse,
  ScheduleMutationResponse,
  ScheduleTriggerResponse,
  ScheduleType,
  ScheduledChat,
  ScheduledChatListResponse,
  SessionSnapshot,
  SessionMessagesResponse,
  SessionRuntime,
  TaskRun,
  TaskRunListResponse,
  TaskSchedule,
  TaskScheduleListResponse,
  TaskMutationResponse,
  TaskTriggerResponse,
  TaskScheduleType,
  SetupStatus,
  SOPDetailResponse,
  SOPItem,
  SOPListResponse,
  SkillDetailResponse,
  SkillItem,
  SkillListResponse,
  SkillSearchResult,
  UploadResult,
  WxContact,
  WxContactListResponse,
  WxLogEntry,
  WxLogListResponse,
  WxMutationResponse,
  WxPollStartResponse,
  WxStatus,
  WxAllowlistResponse,
  WxAllowlistWriteResponse,
  WxQRState,
} from './types'
import type { components as GeneratedApiComponents } from './generated/schema'

class HttpError extends Error {
  status: number
  body: any
  code: 'http_error'
  constructor(status: number, body: any) {
    super(typeof body === 'string' ? body : JSON.stringify(body))
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

type HttpOptions = RequestInit & { timeoutMs?: number }
export type ApiComponents = GeneratedApiComponents
type GeneratedHubSession = ApiComponents['schemas']['HubSession']
type AppStatusResponse = ApiComponents['schemas']['AppStatusResp']
type NavigationPreferences = ApiComponents['schemas']['NavPreferencesResp']
type SessionList = ApiComponents['schemas']['SessionListResp']
type AbortSource = 'timeout' | 'external' | null

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

async function http<T>(method: string, path: string, body?: unknown, init?: HttpOptions): Promise<T> {
  const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, signal: externalSignal, ...requestInit } = init ?? {}
  const abortContext = requestAbortContext(externalSignal, timeoutMs)

  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      ...requestInit,
      signal: abortContext.signal,
    })
    if (!res.ok) {
      let msg: any = await res.text()
      try { msg = JSON.parse(msg) } catch {}
      throw new HttpError(res.status, msg)
    }
    if (res.status === 204) return undefined as unknown as T
    const ct = res.headers.get('content-type') || ''
    if (ct.includes('application/json')) return res.json() as Promise<T>
    return res.text() as unknown as T
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (abortContext.source() === 'external') throw error
      if (abortContext.source() === 'timeout') throw new HttpTimeoutError(path, timeoutMs)
    }
    if (error instanceof TypeError) {
      const networkError = new Error(`Network request failed: ${path}`)
      networkError.name = 'NetworkError'
      ;(networkError as Error & { code: string }).code = 'network_error'
      throw networkError
    }
    throw error
  } finally {
    abortContext.cleanup()
  }
}

export const api = {
  // ── status ───────────────────────────────────────────
  status: () => http<AppStatusResponse>('GET', '/api/status'),

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

  // ── agent ────────────────────────────────────────────
  agentStatus: () => http<AgentStatus>('GET', '/api/agent/status'),
  agentAbort: () => http<{ ok: boolean }>('POST', '/api/agent/abort'),
  btw: (text: string) => http<BtwResp>('POST', '/api/agent/btw', { text }),
  agentNew: () => http<{ ok: boolean; message: string }>('POST', '/api/agent/new'),
  agentSetTitle: (title: string) =>
    http<{ ok: boolean; title: string }>('PUT', '/api/agent/title', { title }),
  chatRetryConfig: () => http<ChatRetryConfig>('GET', '/api/agent/chat-retry-config'),
  saveChatRetryConfig: (cfg: ChatRetryConfig) =>
    http<ChatRetryConfig>('PUT', '/api/agent/chat-retry-config', cfg),
  agentSessions: () => http<{ sessions: SessionSnapshot[] }>('GET', '/api/agent/sessions'),
  agentRestoreSession: (idx: number) =>
    http<{ ok: boolean; message: string; full: boolean }>('POST', `/api/agent/sessions/${idx}/restore`),

  // ── llms ─────────────────────────────────────────────
  llms: () => http<{ llms: LLMInfo[] }>('GET', '/api/llms'),
  switchLLM: (index: number) => http<{ llm_no: number; name: string }>('POST', '/api/llms/switch', { index }),
  testLLM: (index: number) => http<LLMTestResult>('POST', `/api/llms/${index}/test`),

  // ── desktop notifications (backend OS notifier) ──────
  notifyInfo: () => http<{ backend: string }>('GET', '/api/notify/info'),
  notify: (title: string, body: string) =>
    http<{ ok: boolean; backend: string; throttled?: boolean; error?: string }>('POST', '/api/notify', { title, body }),

  // ── mykey.py editor ──────────────────────────────────
  mykey: () => http<MyKeyData>('GET', '/api/mykey'),
  putMyKeyRaw: (raw: string) => http<MyKeyWriteResult>('PUT', '/api/mykey/raw', { raw }),
  upsertMyKeySession: (s: MyKeySession) =>
    http<MyKeyWriteResult>('POST', '/api/mykey/sessions', s),
  deleteMyKeySession: (varName: string) =>
    http<MyKeyWriteResult>('DELETE', `/api/mykey/sessions/${encodeURIComponent(varName)}`),
  mykeyBackups: () => http<MyKeyBackupListResponse>('GET', '/api/mykey/backups'),
  restoreMyKeyBackup: (name: string) =>
    http<MyKeyWriteResult>('POST', `/api/mykey/backups/${encodeURIComponent(name)}/restore`),
  testMyKeySession: (varName: string) =>
    http<MyKeySessionTestResult>('POST', `/api/mykey/sessions/${encodeURIComponent(varName)}/test`),
  openMyKeyFile: () => http<MyKeyOpenResponse>('POST', '/api/mykey/open'),
  uploadMyKeySync: () => http<MyKeySyncResult>('POST', '/api/mykey/sync/upload'),
  fetchMyKeySync: () => http<MyKeySyncResult>('POST', '/api/mykey/sync/fetch'),

  // ── feishu ───────────────────────────────────────────
  fsStatus: () => http<FsStatus>('GET', '/api/feishu/status'),
  fsCheck: (initAgent = false) => http<FsCheckResult>('POST', `/api/feishu/check?init_agent=${initAgent ? 'true' : 'false'}`),
  fsStart: () => http<FsStartResponse>('POST', '/api/feishu/start'),
  fsStop: () => http<FsStopResponse>('POST', '/api/feishu/stop'),
  fsLogs: (tail = 300) => http<LogLinesResponse>('GET', `/api/feishu/logs?tail=${tail}`),
  fsRecentEvents: (limit = 100) => http<EventRecentResponse>('GET', `/api/events/recent?prefix=feishu:chat&limit=${limit}`),
  fsSaveKeys: (app_id: string, app_secret: string, allowed_users = '') =>
    http<FsKeysResponse>('PUT', '/api/feishu/keys', { app_id, app_secret, allowed_users }),
  fsSend: (receive_id: string, text: string, receive_id_type = 'open_id', use_card = false) =>
    http<FsSendResponse>('POST', '/api/feishu/send', { receive_id, text, receive_id_type, use_card }),

  // ── wechat (legacy endpoints kept for compatibility) ─
  wxStatus: () => http<WxStatus>('GET', '/api/wechat/status'),
  wxLogin: () => http<WxQRState>('POST', '/api/wechat/login'),
  wxLogout: () => http<WxMutationResponse>('POST', '/api/wechat/logout'),
  wxStartPoll: () => http<WxPollStartResponse>('POST', '/api/wechat/poll/start'),
  wxStopPoll: () => http<WxMutationResponse>('POST', '/api/wechat/poll/stop'),
  wxContacts: () => http<WxContactListResponse>('GET', '/api/wechat/contacts'),
  wxMessages: (uid?: string, limit = 200) => {
    const q = new URLSearchParams()
    if (uid) q.set('uid', uid)
    q.set('limit', String(limit))
    return http<WxLogListResponse>('GET', `/api/wechat/messages?${q}`)
  },
  wxSend: (uid: string, text?: string, file_path?: string, context_token = '') =>
    http<WxMutationResponse>('POST', '/api/wechat/send', { uid, text, file_path, context_token }),
  wxClearMessages: () => http<WxMutationResponse>('DELETE', '/api/wechat/messages'),
  wxAllowlist: () => http<WxAllowlistResponse>('GET', '/api/wechat/allowlist'),
  wxSetAllowlist: (allowlist: string[]) =>
    http<WxAllowlistWriteResponse>('PUT', '/api/wechat/allowlist', { allowlist }),

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
    `/api/conversations/${encodeURIComponent(id)}/export?format=${format}`,
  restoreConversation: (id: string) =>
    http<ConversationRestoreResponse>(
      'POST', `/api/conversations/${encodeURIComponent(id)}/restore`),

  // ── memory ───────────────────────────────────────────
  globalMem: () => http<MemoryTextResponse>('GET', '/api/memory/global'),
  setGlobalMem: (content: string) => http<MemoryWriteResponse>('PUT', '/api/memory/global', { content }),
  insight: () => http<MemoryTextResponse>('GET', '/api/memory/insight'),
  setInsight: (content: string) => http<MemoryWriteResponse>('PUT', '/api/memory/insight', { content }),
  sops: () => http<SOPListResponse>('GET', '/api/memory/sops'),
  sop: (name: string) => http<SOPDetailResponse>('GET', `/api/memory/sops/${encodeURIComponent(name)}`),
  setSop: (name: string, content: string) =>
    http<MemoryWriteResponse>('PUT', `/api/memory/sops/${encodeURIComponent(name)}`, { content }),
  skills: (limit = 200) => http<SkillListResponse>('GET', `/api/memory/skills?limit=${limit}`),
  skill: (path: string) => http<SkillDetailResponse>('GET', `/api/memory/skills/read?path=${encodeURIComponent(path)}`),
  searchSkills: (q: string, limit = 60) =>
    http<SkillSearchResult>('GET', `/api/memory/skills/search?q=${encodeURIComponent(q)}&limit=${limit}`),

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
  taskEmailConfig: () => http<EmailConfig>('GET', '/api/tasks/email-config'),
  saveTaskEmailConfig: (cfg: Partial<EmailConfig> & { password?: string }) =>
    http<EmailConfig>('PUT', '/api/tasks/email-config', cfg),
  testTaskEmail: (to: string, subject: string, body: string) =>
    http<EmailTestResponse>('POST', '/api/tasks/email-test', { to, subject, body }),

  // ── upload ───────────────────────────────────────────
  upload: async (file: File, init?: Pick<HttpOptions, 'signal' | 'timeoutMs'>): Promise<UploadResult> => {
    const fd = new FormData()
    fd.append('file', file)
    const { timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, signal: externalSignal } = init ?? {}
    const abortContext = requestAbortContext(externalSignal, timeoutMs)
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd, signal: abortContext.signal })
      if (!res.ok) throw new HttpError(res.status, await res.text())
      return res.json()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        if (abortContext.source() === 'external') throw error
        if (abortContext.source() === 'timeout') throw new HttpTimeoutError('/api/upload', timeoutMs)
      }
      if (error instanceof TypeError) {
        const networkError = new Error('Network request failed: /api/upload')
        networkError.name = 'NetworkError'
        ;(networkError as Error & { code: string }).code = 'network_error'
        throw networkError
      }
      throw error
    } finally {
      abortContext.cleanup()
    }
  },
  fileUrlByPath: (absPath: string) => `/api/files-by-path?path=${encodeURIComponent(absPath)}`,
  revealFile: (path: string) =>
    http<RevealFileResponse>('POST', '/api/files/reveal', { path }),

  // ── logs ─────────────────────────────────────────────
  wechatLog: (tail = 200) => http<LogLinesResponse>('GET', `/api/logs/wechat?tail=${tail}`),
  agentLog: (tail = 200) => http<LogLinesResponse>('GET', `/api/logs/agent?tail=${tail}`),
  backendLog: (tail = 200) => http<LogLinesResponse>('GET', `/api/logs/backend?tail=${tail}`),

  // ── rewind ───────────────────────────────────────────
  rewindTurns: (req: { sid?: string; n?: number }) =>
    http<{ ok: boolean; removed_sids: string[]; kept: number; history_lines: number; removed_history_entries?: number }>(
      'POST',
      '/api/agent/rewind',
      req,
    ),

  // ── conductor ────────────────────────────────────────
  conductorReadme: (topic = 'api') =>
    topic === 'api'
      ? http<ConductorTextResponse>('GET', '/api/conductor/readme')
      : http<ConductorTextResponse>('GET', `/api/conductor/readme/${topic}`),
  conductorChat: (last = 50) => http<ConductorChatListResponse>('GET', `/api/conductor/chat?last=${last}`),
  conductorSendChat: (msg: string, role: 'user' | 'assistant' = 'user', llm_index?: number | null) =>
    http<ConductorChatMessage>('POST', '/api/conductor/chat', { msg, role, llm_index }),
  conductorSubagents: () => http<ConductorSubagentListResponse>('GET', '/api/conductor/subagent'),
  conductorSubagent: (sid: string, max_len = 5000) => http<ConductorSubagent>('GET', `/api/conductor/subagent/${sid}?max_len=${max_len}`),
  conductorStartSubagent: (prompt: string, llm_index?: number | null) =>
    http<ConductorSubagentInstructionResponse>('POST', '/api/conductor/subagent', { prompt, llm_index }),
  conductorSubagentAction: (sid: string, action: 'keyinfo' | 'done', msg: string) =>
    http<ConductorSubagentActionResponse>('POST', `/api/conductor/subagent/${sid}`, { action, msg }),
  conductorApproval: (prompt: string, source: string) =>
    http<ConductorMutationResponse>('POST', '/api/conductor/approval', { prompt, source }),
  tokenStats: () => http<TokenStatsResponse>('GET', '/api/tokens/stats'),
  tokenHistory: (hours = 24) => http<TokenHistoryResponse>('GET', `/api/tokens/history?hours=${hours}`),
  servicePanel: () => http<ServicePanelResponse>('GET', '/api/services/panel'),
  conductorLog: () => http<ConductorLogResponse>('GET', '/api/conductor/log'),
  conductorStatus: () => http<ConductorStatus>('GET', '/api/conductor/status'),
  conductorStart: (llm_index?: number | null) => http<ConductorLifecycleResponse>('POST', '/api/conductor/start', { llm_index }),
  sessions: () => http<SessionList>('GET', '/api/sessions'),
  createSession: (req: Partial<ApiComponents['schemas']['SessionCreate']> = {}) =>
    http<GeneratedHubSession>('POST', '/api/sessions', req),
  updateSession: (id: string, changes: { title?: string; llm_key?: string | null }) =>
    http<GeneratedHubSession>('PATCH', `/api/sessions/${encodeURIComponent(id)}`, changes),
  deleteSession: (id: string) =>
    http<void>('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  projects: () => http<{ total: number; items: ProjectItem[] }>('GET', '/api/projects'),
  createProject: (path: string) =>
    http<ProjectItem>('POST', '/api/projects', { path }),
  deleteProject: (name: string) =>
    http<void>('DELETE', `/api/projects/${encodeURIComponent(name)}`),
  bindProject: (id: string, name: string, path: string) =>
    http<GeneratedHubSession>('PUT', `/api/sessions/${encodeURIComponent(id)}/project`, { name, path }),
  unbindProject: (id: string) =>
    http<GeneratedHubSession>('DELETE', `/api/sessions/${encodeURIComponent(id)}/project`),
  sessionRun: (id: string, text: string, images: string[] = []) =>
    http<SessionRuntime>('POST', `/api/sessions/${encodeURIComponent(id)}/runs`, { text, images }),
  sessionRuntime: (id: string) =>
    http<SessionRuntime>('GET', `/api/sessions/${encodeURIComponent(id)}/runtime`),
  sessionRuntimes: () =>
    http<Record<string, SessionRuntime>>('GET', '/api/session-runtimes'),
  getSessionMessages: (id: string, signal?: AbortSignal) =>
    http<SessionMessagesResponse>('GET', `/api/sessions/${encodeURIComponent(id)}/messages`, undefined, { signal }),
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
  createScheduledChat: (id: string, text: string, images: string[], scheduled_for: number) =>
    http<ScheduledChat>('POST', `/api/sessions/${encodeURIComponent(id)}/scheduled-chats`, {
      text,
      images,
      scheduled_for,
    }),
  cancelScheduledChat: (id: string, taskId: string) =>
    http<void>('DELETE', `/api/sessions/${encodeURIComponent(id)}/scheduled-chats/${encodeURIComponent(taskId)}`),

  conductorStop: () => http<ConductorLifecycleResponse>('POST', '/api/conductor/stop'),
}

// ── WebSocket helpers ──────────────────────────────────────
function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

export class ChatSocket {
  ws?: WebSocket
  private readonly path: string | (() => string)
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private explicitlyClosed = false
  onMessage: (m: ChatWSOut) => void = () => {}
  onState: (s: 'connecting' | 'open' | 'closed') => void = () => {}

  constructor(path: string | (() => string) = '/ws/chat') {
    this.path = path
  }

  open() {
    this.explicitlyClosed = false
    this.onState('connecting')
    const path = typeof this.path === 'function' ? this.path() : this.path
    const ws = new WebSocket(wsUrl(path))
    this.ws = ws
    ws.onopen = () => {
      this.reconnectAttempts = 0
      this.onState('open')
    }
    ws.onmessage = (ev) => {
      try { this.onMessage(JSON.parse(ev.data) as ChatWSOut) } catch {}
    }
    ws.onclose = () => {
      this.onState('closed')
      if (!this.explicitlyClosed) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        this.reconnectAttempts++
        this.reconnectTimer = window.setTimeout(() => this.open(), delay)
      }
    }
    ws.onerror = () => { try { ws.close() } catch {} }
  }

  send(msg: ChatWSIn) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  close() {
    this.explicitlyClosed = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}

export class EventSocket {
  private ws?: WebSocket
  private readonly url: string
  private reconnectTimer?: number
  private reconnectAttempts = 0
  private explicitlyClosed = false
  onEvent: (e: BusEvent) => void = () => {}

  constructor(prefix = '', replay = 0) {
    this.url = wsUrl(`/ws/events?prefix=${encodeURIComponent(prefix)}&replay=${replay}`)
  }

  open() {
    this.explicitlyClosed = false
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.onopen = () => {
      this.reconnectAttempts = 0
    }
    ws.onmessage = (ev) => {
      try { this.onEvent(JSON.parse(ev.data) as BusEvent) } catch {}
    }
    ws.onclose = () => {
      if (!this.explicitlyClosed) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
        this.reconnectAttempts++
        this.reconnectTimer = window.setTimeout(() => this.open(), delay)
      }
    }
    ws.onerror = () => { try { ws.close() } catch {} }
  }

  close() {
    this.explicitlyClosed = true
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
