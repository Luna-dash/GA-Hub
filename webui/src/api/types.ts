// Types mirror server/schemas.py and service dataclasses.

// ── Setup ─────────────────────────────────────────────────
export interface SetupCandidate {
  path: string
  valid: boolean
}

export interface SetupStatus {
  configured: boolean
  ga_root: string | null
  python_path: string | null
  resolved_python: string | null
  resolved_python_source: string
  admin_data: string
  candidates: SetupCandidate[]
}

export interface AgentStatus {
  is_running: boolean
  llm_no: number
  llm_name: string
  llm_model: string
  last_reply_time: number
  queued_tasks: number
  history_lines: number
  current_title: string
}

export interface LLMInfo {
  index: number
  name: string
  current: boolean
  preferred?: boolean
  kind?: 'mixin' | 'single'
  members?: string[]
  active_member?: string
  in_mixin?: boolean
  model?: string
  api_base?: string
  api_key_masked?: string
}

export interface LLMTestResult {
  ok: boolean
  latency_ms?: number
  preview?: string
  model?: string
  name?: string
  error?: string
}

export interface SkillSearchHit {
  path: string
  matches: Array<{ line: number; text: string }>
}
export interface SkillSearchResult {
  hits: SkillSearchHit[]
  scanned: number
  truncated: boolean
  query: string
}

export interface SessionSnapshot {
  path: string
  mtime: number
  preview: string
  rounds: number
}

export interface HubSession {
  id: string
  title: string
  llm_index: number | null
  archive_path: string | null
  project_name?: string | null
  project_path?: string | null
  created_at: string
  updated_at: string
}

export interface ProjectItem {
  name: string
  path: string
  source: 'workspace' | 'session'
  dangling: boolean
}

export interface SessionRuntime {
  session_id: string
  status: string
  run_id: string | null
  stream_id: string | null
  completed_run_id?: string | null
  error?: string | null
  ok?: boolean
}

export interface SessionMessageProjection {
  id: string
  role: 'user' | 'assistant'
  content: string
  ordinal: number
  timestamp?: string | null
}

export interface SessionMessagesResponse {
  session_id: string
  archive_bound: boolean
  revision: string | null
  items: SessionMessageProjection[]
}

export interface ChatRetryConfig {
  enabled: boolean
  max_attempts: number
}

// ── WeChat ────────────────────────────────────────────────
export interface WxQRState {
  status: string                // idle | waiting_scan | scanning | confirmed | expired | timeout | error
  qrcode_id?: string
  url?: string
  bot_id?: string
  error?: string
}

export interface WxStatus {
  logged_in: boolean
  bot_id: string
  polling: boolean
  qr: WxQRState
  contacts: number
  allowlist: string[]
  log_count: number
}

export interface WxContact {
  uid: string
  last_text: string
  last_ts: number
  msg_count: number
  nickname: string
}

export interface WxLogEntry {
  ts: number
  direction: 'in' | 'out'
  uid: string
  text: string
  media: string[]
  context_token: string
  nickname?: string
}

// ── Feishu ────────────────────────────────────────────────
export interface FsStatus {
  running: boolean
  pid?: number | null
  returncode?: number | null
  external?: boolean
  fsapp_path: string
  fsapp_exists: boolean
  python: string
  log_file: string
  log_exists: boolean
  last_check?: FsCheckResult | null
  last_check_ts?: number
}

export interface FsCheckResult {
  ok?: boolean
  ready?: boolean
  returncode?: number
  error?: string
  raw?: string
  app_id_masked?: string
  app_secret_masked?: string
  allowed_users?: string[]
  public_access?: boolean
  pattern_count?: number
  agent_ok?: boolean
  agent_error?: string
  [key: string]: any
}

// ── Conversations ─────────────────────────────────────────
export interface ConversationSummary {
  id: string
  title: string
  message_count: number
  last_user_preview: string
  original_user_preview: string
}

export interface Message {
  role: 'user' | 'assistant' | 'system' | string
  content: string
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
}

export interface ScheduledChat {
  id: string
  session_id: string
  text: string
  images: string[]
  scheduled_for: number
  created_at: number
  status: 'pending' | 'dispatching' | 'sent' | 'cancelled'
  sent_at: number | null
  cancelled_at: number | null
  last_error: string | null
  retry_at: number | null
}

// ── Memory / SOPs ─────────────────────────────────────────
export interface SOPItem { name: string; size: number; mtime: number }
export interface SkillItem { path: string; name: string; size: number; mtime: number }

// ── Autonomous ────────────────────────────────────────────
export type ScheduleType = 'idle' | 'cron' | 'interval'

export interface Schedule {
  id: string
  type: ScheduleType
  enabled: boolean
  prompt: string
  idle_minutes: number
  cron: string
  interval_minutes: number
  last_fired_at: number
  fire_count: number
  name: string
}

export interface AutonomousRun {
  id: string
  schedule_id: string
  fired_at: number
  prompt_preview: string
  report_paths: string[]
  note: string
}

export interface ReportItem { name: string; size: number; mtime: number }

// ── Scheduled Tasks ───────────────────────────────────────
export type TaskScheduleType = 'cron' | 'interval'

export interface TaskSchedule {
  id: string
  type: TaskScheduleType
  enabled: boolean
  prompt: string
  cron: string
  interval_minutes: number
  notify_email: boolean
  email_to: string
  email_subject: string
  last_fired_at: number
  fire_count: number
  name: string
}

export interface TaskRun {
  id: string
  task_id: string
  task_name: string
  fired_at: number
  stream_id: string
  finished_at: number
  status: 'running' | 'done' | 'error' | 'timeout' | string
  prompt_preview: string
  result_preview: string
  email_sent: boolean
  email_error: string
  note: string
}

export interface EmailConfig {
  host: string
  port: number
  username: string
  from_addr: string
  default_to: string
  use_tls: boolean
  use_ssl: boolean
  password_set: boolean
}

// ── Upload ────────────────────────────────────────────────
export interface UploadResult {
  file_id: string
  name: string
  path: string
  url: string
  mime: string
  size: number
}

// ── mykey.py editor ──────────────────────────────────────
export type MyKeySessionType = 'native_claude' | 'native_oai' | 'claude' | 'oai' | 'mixin'

export interface MyKeySession {
  var: string
  type: MyKeySessionType
  fields: Record<string, any>     // backend no longer masks apikey
  lineno?: number
  end_lineno?: number
}

export interface MyKeyData {
  path: string
  exists: boolean
  raw: string
  mtime: number
  structured: {
    sessions: MyKeySession[]
    mixins: MyKeySession[]
    /** Back-compat alias: first item of mixins, if any. */
    mixin: MyKeySession | null
    globals: Record<string, any>
  }
}

export interface MyKeyWriteResult {
  ok: boolean
  backup?: string | null
  llms?: LLMInfo[]
  warnings?: string[]
  structured?: MyKeyData['structured']
  error?: string
  message?: string
  line?: number
  col?: number
}

export interface MyKeyBackup {
  name: string
  mtime: number
  size: number
}

export interface MyKeySyncResult {
  ok: boolean
  action: 'upload' | 'fetch'
  path: string
  returncode: number
  stdout: string
  stderr: string
  llms?: LLMInfo[]
  warnings?: string[]
  structured?: MyKeyData['structured']
}

// ── Chat WS protocol ─────────────────────────────────────
export type ChatWSIn =
  | { type: 'submit'; text: string; images?: string[]; source?: string; llm_index?: number | null }
  | { type: 'abort' }
  | { type: 'ping' }

export interface ChatStreamSnapshot {
  stream_id: string
  source: string
  query: string
  content: string
  done: boolean
  started_at: number
  finished_at: number
  logical_id?: string
  retry_attempt?: number
  retry_max?: number
  retry_of?: string
  retry_reason?: string
}

export interface ChatRetryReason {
  code: string
  label: string
  marker: string
}

export interface BtwResp {
  ok: boolean
  content: string
  error?: string
}

export type ChatEventCursor = { event_id: number; epoch: string }
export type ChatWSMeta = { event_id?: number; epoch?: string }

export type ChatWSOut = (
  | {
      type: 'snapshot'
      streams?: ChatStreamSnapshot[]
      session_id?: string
      status?: string
      run_id?: string | null
      stream_id?: string | null
      runtime?: { status: string; run_id: string | null; stream_id: string | null; error: string | null }
      active_message?: { stream_id: string; content: string; done: boolean } | null
    }
  | { type: 'reset'; reason?: string }
  | { type: 'started'; stream_id: string; source?: string; query?: string; ts?: number; logical_id?: string; retry_attempt?: number; retry_max?: number; retry_of?: string; retry_reason?: string }
  | { type: 'heartbeat'; stream_id: string }
  | { type: 'next'; stream_id: string; content: string; source?: string; logical_id?: string; retry_attempt?: number; retry_max?: number; retry_of?: string; retry_reason?: string }
  | { type: 'done'; stream_id: string; content: string; source?: string; logical_id?: string; retry_attempt?: number; retry_max?: number; retry_of?: string; retry_reason?: string }
  | { type: 'retry'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'retry_exhausted'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'aborted' }
  | { type: 'pong' }
  | { type: 'error'; session_id: string; run_id: string; stream_id: string; code: string; detail: string }
  | { type: 'rewound'; session_id: string; removed_sids: string[]; kept: number; history_lines: number }
  | { type: 'resync_required'; session_id: string; reason: string }
  | { type: 'replay_done'; session_id: string; event_id: number }
) & ChatWSMeta

export interface EventBusEnvelope {
  topic: string
  payload: Record<string, any>
  ts: number
}

export type BusEvent = EventBusEnvelope

// ── Conductor ─────────────────────────────────────────────
export interface ConductorChatMessage {
  id: string
  role: 'user' | 'assistant'
  msg: string  // Backend uses "msg", not "content"
  ts: number
}

export interface ConductorSubagent {
  id: string
  prompt: string
  status: 'running' | 'stopped'
  reply: string
  created_at: number
  updated_at: number
}

export interface ConductorLogItem {
  id: string
  ts: number
  event: string
  turn: number
  text: string
}

export interface ConductorStatus {
  started: boolean
  subagents: { running: number; stopped: number }
  chat_count: number
}

export interface TokenThreadStats {
  thread: string
  requests: number
  input: number
  output: number
  cache_create: number
  cache_read: number
  total: number
  cache_hit_rate: number
  elapsed_seconds: number
}

export interface TokenTotals extends Omit<TokenThreadStats, 'thread' | 'elapsed_seconds'> {}
export interface TokenWeekStats extends TokenTotals { week_start: string; week_end: string }
export interface TokenDayStats extends TokenTotals { date: string }
export interface TokenStatsResponse {
  available: boolean
  threads: TokenThreadStats[]
  totals: TokenTotals
  timestamp: number
  all_time: TokenTotals
  current_week: TokenWeekStats
  weeks: TokenWeekStats[]
  days: TokenDayStats[]
}
export interface TokenHistoryPoint extends TokenTotals { timestamp: number }
export interface TokenHistoryResponse { hours: number; history: TokenHistoryPoint[] }

export type ServicePanelState = 'running' | 'ready' | 'stopped' | 'error'
export type ServiceActivity = 'active' | 'standby' | 'inactive'
export type ServiceHealth = 'healthy' | 'attention' | 'unknown'
export interface ServicePanelItem {
  id: string
  name: string
  state: ServicePanelState
  activity: ServiceActivity
  health: ServiceHealth
  expected_running: boolean
  summary: string
  href: string
  metrics: Record<string, string | number | boolean | null>
  error: string | null
}
export interface ServicePanelResponse { services: ServicePanelItem[]; timestamp: number }

export interface ConductorApprovalItem {
  id: string
  prompt: string
  source: string
}
