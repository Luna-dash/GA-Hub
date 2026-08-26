import type { components as GeneratedApiComponents } from './generated/schema'

// Shared contracts come from the generated OpenAPI schema. Legacy types below
// remain until their endpoint-specific response models are migrated.
type ApiSchemas = GeneratedApiComponents['schemas']

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

export type AppStatus = ApiSchemas['AppStatusResp']
export type AgentStatus = ApiSchemas['GlobalAgentStatus']
export type ConversationSummary = ApiSchemas['ConversationSummaryResp']
export type Conversation = ApiSchemas['ConversationDetailResp']
export type ConversationListResponse = ApiSchemas['ConversationListResp']
export type ConversationUpdateResponse = ApiSchemas['ConversationUpdateResp']
export type ConversationDeleteResponse = ApiSchemas['ConversationMutationResp']
export type ConversationRestoreResponse = ApiSchemas['ConversationRestoreResp']
export type ConversationMessage = ApiSchemas['ConversationMessageResp']
export type ArchiveZipListResponse = ApiSchemas['ArchiveZipListResp']
export type ArchiveZipEntryListResponse = ApiSchemas['ArchiveZipEntryListResp']

export interface LLMInfo {
  key: string
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

export type MemoryTextResponse = ApiSchemas['MemoryTextResp']
export type MemoryWriteResponse = ApiSchemas['MemoryWriteResp']
export type SkillSearchHit = ApiSchemas['SkillSearchHit']
export type SkillSearchResult = ApiSchemas['SkillSearchResp']

export interface SessionSnapshot {
  path: string
  mtime: number
  preview: string
  rounds: number
}

export interface HubSession {
  id: string
  title: string
  llm_key?: string | null
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
  last_used?: number
  mem_lines?: number
  memory_path?: string | null
  dangling: boolean
}

export type SessionRuntime = ApiSchemas['SessionRuntimeResp']
export type SessionMessageProjection = ApiSchemas['SessionMessageProjection']
type GeneratedSessionMessagesResponse = ApiSchemas['SessionMessagesResp']
export type SessionMessagesResponse = Omit<
  GeneratedSessionMessagesResponse,
  'total' | 'has_more' | 'next_before'
> & {
  /** Optional during rolling upgrades from a pre-pagination backend. */
  total?: number
  has_more?: boolean
  next_before?: number | null
}

export interface ChatRetryConfig {
  enabled: boolean
  max_attempts: number
  /** Retry budget for unattended sources (scheduled / autonomous chats). */
  scheduled_max_attempts?: number
  /** Seconds before the first automatic retry attempt. */
  backoff_base_seconds?: number
  /** Multiplier applied per subsequent attempt (>= 1). */
  backoff_factor?: number
  /** Upper bound for any single computed backoff delay. */
  backoff_max_seconds?: number
  /** Backoff base for unattended scheduled sources (slower ramp, default 5s). */
  scheduled_backoff_base_seconds?: number
  /** Per-wait ceiling for unattended scheduled sources (default 10 min). */
  scheduled_backoff_max_seconds?: number
}

// ── WeChat ────────────────────────────────────────────────
export type WxQRState = ApiSchemas['WxQRState']

export type WxStatus = ApiSchemas['WxStatusResp']

export type WxContact = ApiSchemas['WxContact']
export type WxContactListResponse = ApiSchemas['WxContactListResp']

export type WxLogEntry = ApiSchemas['WxLogEntry']
export type WxLogListResponse = ApiSchemas['WxLogListResp']
export type WxMutationResponse = ApiSchemas['WxLogoutResp']
export type WxPollStartResponse = ApiSchemas['WxPollStartResp']
export type WxAllowlistResponse = ApiSchemas['WxAllowlistResp']
export type WxAllowlistWriteResponse = ApiSchemas['WxAllowlistWriteResp']

// ── Feishu ────────────────────────────────────────────────
export type FsStatus = ApiSchemas['FsStatusResp']
export type FsCheckResult = ApiSchemas['FsCheckResp']
export type FsKeysResponse = ApiSchemas['FsKeysResp']
export type FsStartResponse = ApiSchemas['FsStartResp']
export type FsStopResponse = ApiSchemas['FsStopResp']
export type FsSendResponse = ApiSchemas['FsSendResp']

export type ScheduledChat = ApiSchemas['ScheduledChatResp']
export type ScheduledChatListResponse = ApiSchemas['ScheduledChatListResp']

// ── Memory / SOPs ─────────────────────────────────────────
export type SOPItem = ApiSchemas['SOPItem']
export type SOPListResponse = ApiSchemas['SOPListResp']
export type SOPDetailResponse = ApiSchemas['SOPDetailResp']
export type SkillItem = ApiSchemas['SkillItem']
export type SkillListResponse = ApiSchemas['SkillListResp']
export type SkillDetailResponse = ApiSchemas['SkillDetailResp']

// ── Autonomous ────────────────────────────────────────────
export type ScheduleType = 'idle' | 'cron' | 'interval'

export type Schedule = ApiSchemas['AutonomousScheduleResp']
export type ScheduleListResponse = ApiSchemas['AutonomousScheduleListResp']
export type ScheduleMutationResponse = ApiSchemas['AutonomousMutationResp']
export type ScheduleTriggerResponse = ApiSchemas['AutonomousTriggerResp']
export type AutonomousRun = ApiSchemas['AutonomousRunResp']
export type AutonomousRunListResponse = ApiSchemas['AutonomousRunListResp']
export type ReportItem = ApiSchemas['AutonomousReportItem']
export type AutonomousReportListResponse = ApiSchemas['AutonomousReportListResp']
export type AutonomousReportDetailResponse = ApiSchemas['AutonomousReportDetailResp']

// ── Scheduled Tasks ───────────────────────────────────────
export type TaskScheduleType = 'cron' | 'interval'

export type TaskSchedule = ApiSchemas['TaskScheduleResp']
export type TaskScheduleListResponse = ApiSchemas['TaskScheduleListResp']
export type TaskMutationResponse = ApiSchemas['TaskMutationResp']
export type TaskTriggerResponse = ApiSchemas['TaskTriggerResp']
export type TaskRun = ApiSchemas['TaskRunResp']
export type TaskRunListResponse = ApiSchemas['TaskRunListResp']
export type EmailConfig = ApiSchemas['EmailConfigResp']
export type EmailTestResponse = ApiSchemas['EmailTestResp']

// ── Upload ────────────────────────────────────────────────
export type UploadResult = ApiSchemas['UploadResp']
export type RevealFileRequest = ApiSchemas['RevealFileReq']
export type RevealFileResponse = ApiSchemas['RevealFileResp']

// ── mykey.py editor ──────────────────────────────────────
export type MyKeySessionType =
  | 'native_claude' | 'native_oai' | 'claude' | 'oai' | 'mixin'
export type MyKeySession = Omit<ApiSchemas['MyKeySession'], 'fields' | 'var' | 'type'> & {
  var: string
  type: MyKeySessionType
  fields: Record<string, any>
}
export type MyKeyData = Omit<ApiSchemas['MyKeyDataResp'], 'structured'> & {
  structured: {
    sessions: MyKeySession[]
    mixins: MyKeySession[]
    mixin: MyKeySession | null
    globals: Record<string, any>
  }
}
export type MyKeyWriteResult = ApiSchemas['MyKeyWriteResp']
export type MyKeySessionTestResult = ApiSchemas['MyKeySessionTestResp']
export type MyKeyBackup = ApiSchemas['MyKeyBackup']
export type MyKeyBackupListResponse = ApiSchemas['MyKeyBackupListResp']
export type MyKeySyncResult = ApiSchemas['MyKeySyncResultResp']
export type MyKeyOpenResponse = ApiSchemas['MyKeyOpenResp']

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
  | { type: 'retry_scheduled'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; delay_seconds?: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'retry'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'retry_exhausted'; stream_id: string; source?: string; logical_id?: string; attempt: number; max_attempts: number; reason?: ChatRetryReason; retry_reason?: string }
  | { type: 'aborted' }
  | { type: 'pong' }
  | { type: 'error'; session_id: string; run_id: string; stream_id: string; code: string; detail: string }
  | { type: 'rewound'; session_id: string; removed_sids: string[]; kept: number; history_lines: number }
  | { type: 'resync_required'; session_id: string; reason: string }
  | { type: 'replay_done'; session_id: string; event_id: number }
) & ChatWSMeta

export type EventBusEnvelope = Omit<ApiSchemas['EventBusEnvelope'], 'payload'> & {
  payload: Record<string, any>
}
export type BusEvent = EventBusEnvelope & {
  event_id?: number
  epoch?: string
}
export type HubEventControl =
  | { type: 'resync_required'; reason: string; epoch: string }
  | { type: 'replay_done'; event_id: number; epoch: string }
export type HubEventMessage = BusEvent | HubEventControl
export type EventRecentResponse = Omit<ApiSchemas['EventRecentResp'], 'events'> & {
  events: EventBusEnvelope[]
}
export type LogLinesResponse = ApiSchemas['LogLinesResp']

// ── Conductor ─────────────────────────────────────────────
export type ConductorChatMessage = ApiSchemas['ConductorChatMessage']
export type ConductorSubagent = ApiSchemas['ConductorSubagent']
export type ConductorLogItem = ApiSchemas['ConductorLogItem']
export type ConductorStatus = ApiSchemas['ConductorStatusResp']
export type ConductorTextResponse = ApiSchemas['ConductorTextResp']
export type ConductorChatListResponse = ApiSchemas['ConductorChatListResp']
export type ConductorLogResponse = ApiSchemas['ConductorLogResp']
export type ConductorMutationResponse = ApiSchemas['ConductorMutationResp']
export type ConductorSubagentListResponse = ApiSchemas['ConductorSubagentListResp']
export type ConductorSubagentInstructionResponse = ApiSchemas['ConductorSubagentInstructionResp']
export type ConductorSubagentActionResponse = ApiSchemas['ConductorSubagentActionResp']
export type ConductorLifecycleResponse = ApiSchemas['ConductorLifecycleResp']
export type ConductorWorkflow = ApiSchemas['ConductorWorkflow']
export type ConductorWorkflowListResponse = ApiSchemas['ConductorWorkflowListResp']

export interface TokenThreadStats {
  thread: string
  title: string
  requests: number
  input: number
  output: number
  cache_create: number
  cache_read: number
  total: number
  cache_hit_rate: number
  elapsed_seconds: number
}

export interface TokenTotals extends Omit<TokenThreadStats, 'thread' | 'title' | 'elapsed_seconds'> {}
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

export type ServicePanelState = NonNullable<ApiSchemas['ServicePanelItem']['state']>
export type ServiceActivity = NonNullable<ApiSchemas['ServicePanelItem']['activity']>
export type ServiceHealth = NonNullable<ApiSchemas['ServicePanelItem']['health']>
export type ServicePanelItem = Omit<ApiSchemas['ServicePanelItem'], 'metrics'> & {
  metrics: Record<string, string | number | boolean | null>
}
export type ServicePanelResponse = Omit<ApiSchemas['ServicePanelResp'], 'services'> & {
  services: ServicePanelItem[]
}

export interface ConductorApprovalItem {
  id: string
  prompt: string
  source: string
}
